# MOZI Architecture v1.1 — Gap Analysis & Extended Design

> 基于 v1.0 架构文档和完整设计讨论的差异分析，补充缺失设计。
> Author: Chaojie + Mozi · February 2026

> **Runtime Note (v1.9.9, March 3, 2026):**
> - **Default request path** is direct brain/tool-loop execution in gateway handler (no classifier step).
> - **DAG execution is active on-demand** through `decompose_task` (`system-tools` -> `dag-bridge` -> `executeDag`).
> - **SubAgent DAG runtime is rollout-gated** (`tools.subagents` global/tenant/session flags). When not enabled,
>   DAG work still executes via in-process fallback.
>  
> So DAG is **not fully dormant**: it is no longer the default path, but remains a live capability via tool flow.

---

## 一、v1.0 缺失项补充

### 1. Session Handoff Protocol（跨 session 续力）

v1.0 只在 Token Strategy 水位线表提了"95% 触发 Session Rotation"，但没有定义续力机制。

**Handoff Document Schema:**

```
SessionHandoff {
  session_id: string
  created_at: ISO8601
  trigger: "watermark_95" | "user_command" | "timeout" | "crash_recovery"

  // 任务快照
  task_snapshot: {
    [task_id]: {
      status: "completed" | "in_progress" | "blocked" | "failed"
      progress: string          // 如 "step 3/7"
      assigned_agent: agent_id
      key_output: string        // 已产出的关键结果（摘要，非全文）
    }
  }

  // 决策记录（不可丢失）
  key_decisions: string[]       // 如 ["选择了 React 而非 Vue", "API 用 REST"]
  unresolved_questions: string[] // 如 ["数据库选型待定"]

  // 活跃 subagent 状态
  active_agents: {
    [agent_id]: {
      role: string
      status: "running" | "blocked"
      task_id: string
    }
  }

  // 文件变更摘要
  file_changes: string[]        // 如 ["src/api.py: +120 lines"]

  // 对话摘要（Running Summary 的最终版本）
  conversation_summary: string  // <2000 tokens

  // 用户偏好/当次 session 学到的上下文
  session_context: string       // 如 "用户要求所有代码用 TypeScript"
}
```

**生成流程：**
1. Token Budget Manager 检测到 95% 水位线
2. 暂停接收新事件，Brain 进入 HANDOFF 状态
3. Brain 用当前 context 生成 Handoff Document（这是 Brain 在旧 session 的最后一次 LLM 调用）
4. 持久化 Handoff Document 到 Task Store
5. 启动新 session，System Prompt + Handoff Document 作为初始 context
6. 活跃 subagent 不中断——它们通过消息队列通信，不依赖 Brain 的 session

**注意：** Handoff 生成本身消耗 token，要在 95% 时触发而不是 99%，留足余量。

---

### 2. 安全与权限模型

v1.0 完全缺失独立的安全层设计。

**权限分级体系：**

```
PermissionLevel {
  L0_READ_ONLY:    // 文件读取、搜索、API GET
  L1_READ_WRITE:   // 文件写入、数据库写入
  L2_SHELL_EXEC:   // 执行 shell 命令（受限：无网络、沙箱内）
  L3_FULL_ACCESS:  // shell + 网络 + Docker + 任意文件路径
}
```

**Agent 权限规则：**

| Agent 类型 | 默认权限 | 可提升到 | 提升条件 |
|-----------|---------|---------|---------|
| Dynamic Agent（临时） | L0_READ_ONLY | L2_SHELL_EXEC | Brain 在 Task Brief 中显式授权 |
| Preset Agent（常驻） | L1_READ_WRITE | L3_FULL_ACCESS | 需 human-in-the-loop 确认 |
| Brain | L1_READ_WRITE | — | Brain 自身不执行 tool call |

**Hard Gates（必须人确认）：**
1. **Skill 注册** — 新 skill 写入 registry 前必须人审批
2. **Agent Promotion** — Dynamic → Preset 需人确认
3. **L3 权限授予** — 任何 agent 获得 FULL_ACCESS 需人确认
4. **外部通信** — 发送邮件、发推、调外部 API（非 LLM）需确认

**沙箱策略：**
- Dynamic Agent 默认在隔离环境中执行（受限文件系统 + 无网络出口）
- 通过 TEL 层的 Sandbox Manager 实施，不依赖 agent 自觉
- 沙箱实现：Phase 1 用 restricted shell（seccomp/AppArmor），Phase 2 用容器

**Path Restriction：**
- 每个 agent 有 allowed_paths 白名单（在 Task Brief 中定义）
- TEL 层在执行文件操作前强制校验路径
- 禁止访问：系统配置、其他 agent 的 workspace、secret store

---

### 3. Checkpoint / Rollback 机制

**设计：**

```
Checkpoint {
  checkpoint_id: string
  task_id: string
  step_index: int
  created_at: ISO8601
  state_snapshot: {
    files_changed: [{path, hash_before, hash_after}]
    db_mutations: [{table, operation, row_id}]
    agent_context_summary: string   // 压缩的 agent 当前认知
  }
  rollback_commands: string[]       // 回滚指令序列（git revert, SQL undo 等）
}
```

**流程：**
- TEL 层在每个 tool call 成功执行后，自动创建 checkpoint（对于有副作用的操作：写文件、写DB、执行命令）
- 只读操作不创建 checkpoint
- checkpoint 存储在 Task Store（SQLite），按 task_id 索引
- SubAgent 执行失败时：TEL 自动回滚到最近 checkpoint → 重试
- 重试仍失败：回滚到更早的 checkpoint → 换策略重试
- 超过 retry 上限：回滚到 task 起始状态 → 上报 Brain

**Git-based Rollback（文件操作）：**
- 每个 task 开始前自动 `git stash` 或创建临时分支
- 失败回滚 = `git checkout` 回起始点
- 成功 = squash commit

---

### 4. 错误上下文压缩策略

**原则：** 永远不把 raw error log 直接喂给模型。

**压缩流水线：**
1. **规则提取**（无 LLM 成本）：
   - 保留最后 20 行 stderr
   - 提取 error type + message（正则匹配常见模式：Python traceback、Node stack trace、shell exit code）
   - 提取关键数字：行号、exit code、HTTP status
2. **结构化输出：**
   ```
   ErrorContext {
     tool: "shell"
     command: "npm run build"
     exit_code: 1
     error_type: "TypeScriptError"
     error_message: "Property 'x' does not exist on type 'Y'"
     file: "src/api.ts"
     line: 42
     stderr_tail: "..." (最后 5 行)
     attempt: 2          // 第几次重试
     prev_fix_summary: "上次尝试修改了类型定义但仍报错"
   }
   ```
3. **上报给 SubAgent：** 结构化 ErrorContext（<500 tokens），不是 raw log
4. **上报给 Brain：** 更短的摘要（<100 tokens）：`"shell:npm build failed (TypeScriptError at api.ts:42), 2 retries exhausted"`

---

### 5. Tool Schema 懒加载

**机制：**

Brain/SubAgent 启动时的 system prompt 只包含 Tool Category Manifest：

```
Available tool categories:
- browser: Web browsing and automation
- shell: Command execution
- filesystem: File read/write/search
- api: HTTP requests
- database: SQL/NoSQL operations
- docker: Container management
```

当 agent 发出 intent 涉及某个 category 时（如 "search for files matching *.py"）：
1. TEL 层识别这是 filesystem category
2. Token Budget Manager 检查注入 schema 后的 budget
3. 将 filesystem 的完整 tool schema 注入当前 context（通过 system prompt append 或 tool definition 动态更新）
4. agent 下一步即可使用具体 tool

**缓存策略：**
- 一旦加载，同一 session 内不卸载（避免反复加载的 token 浪费）
- Session rotation 时重置，新 session 按需重新加载

---

### 6. Running Summary 机制

Running Summary 是**常态机制**，不是等水位线才触发。

**工作方式：**
- 主 agent 维护一个 `running_summary` 字段（上限 2000 tokens）
- 每当对话历史超过 5 轮，自动将第 1-2 轮压缩进 running_summary
- 压缩方式：用小模型（Haiku 级）做摘要，提取事实和决策，丢弃寒暄
- running_summary 本身超过 2000 tokens 时，做二次压缩（用同一个小模型）
- 关键决策和事实同时写入 Memory Interface（长期记忆层）

**Context 构成（常态）：**
```
[System Prompt]        ≤ 8% window
[Running Summary]      ≤ 5% window (2000 tokens cap)
[Active Task Status]   动态
[Recent 3-5 turns]     动态
[Loaded Tool Schemas]  动态（懒加载的）
[Working Space]        剩余
```

这样 system overhead 稳定在 ~13%，远低于 v1.0 的 20% 估算。

---

## 二、v1.0 深度不足项补充

### 7. Task DAG 完整设计

**Task Node Schema：**

```
Task {
  id: string (uuid)
  parent_task_id: string | null       // 顶级 task = null
  title: string
  objective: string                    // 做什么
  done_criteria: string                // 验收标准
  status: "pending" | "ready" | "assigned" | "running" | "blocked" | "completed" | "failed" | "cancelled"
  
  // 依赖
  depends_on: task_id[]                // 前置依赖
  blocks: task_id[]                    // 被它阻塞的后续 task（自动计算）
  
  // 分配
  assigned_agent: agent_id | null
  agent_type_hint: "preset:code-reviewer" | "dynamic" | "any"
  
  // 约束
  constraints: {
    token_budget: int                  // 该 task 的 token 上限
    timeout_seconds: int
    max_retries: int
    permission_level: PermissionLevel
    allowed_paths: string[]
    forbidden_paths: string[]
  }
  
  // 执行记录
  attempts: [{
    attempt_id: string
    agent_id: string
    started_at: ISO8601
    ended_at: ISO8601
    result_envelope: ResultEnvelope | null
    checkpoints: checkpoint_id[]
  }]
  
  // 元数据
  created_at: ISO8601
  updated_at: ISO8601
  priority: int                        // 0=highest
  tags: string[]
}
```

**DAG 调度策略：**
- 使用拓扑排序确定可执行顺序
- `status=ready`：所有 depends_on 均 completed
- 最大并行 subagent 数：可配置（默认 5，上限 10）
- 资源竞争：token budget 从 task 的 parent 按比例分配，不超支
- 依赖失败处理策略（per-task 配置）：
  - `fail_fast`：依赖失败 → 立即 cancel 下游
  - `continue`：依赖失败 → 跳过本 task，继续其他无依赖的 task
  - `fallback`：依赖失败 → 用 fallback 值继续

**存储：** SQLite with WAL mode（单机）。表结构：tasks, task_dependencies, task_attempts, checkpoints。

---

### 8. SubAgent 进化评分体系

**评分公式：**

```
evolution_score = w1 * success_rate + w2 * efficiency_score + w3 * reliability_score

where:
  success_rate     = completed_tasks / total_tasks
  efficiency_score = 1 - (avg_token_cost / budget_allocated)  // 越省 token 越高
  reliability_score = 1 - (avg_retries / max_retries)         // 越少重试越高
  
  w1 = 0.5, w2 = 0.3, w3 = 0.2  (可调)
```

**生命周期规则：**

| 条件 | 动作 |
|------|------|
| spawn_count ≥ 5 && evolution_score ≥ 0.8 | 建议 promote → Preset（需 human 确认） |
| spawn_count ≥ 3 && evolution_score < 0.3 | 自动 blacklist（不再 spawn 同类） |
| Preset agent 连续 30 天未被调用 | 建议 archive → 仍保留定义但不预加载 |
| Preset agent success_rate 连续下降到 < 0.5 | 告警 → 建议 demote 回 dynamic 或人工审查 |

**数据来源：** Observer 模块的 trace 和 cost tracking。

---

### 9. 消息队列选型

**决策：Phase 1 用 SQLite-based 内部队列，Phase 2 按需引入 Redis Streams。**

理由：
- Phase 1 是单机部署，引入 Redis 是不必要的外部依赖
- SQLite WAL mode 支持单写多读，完全够用
- 队列表设计：

```sql
CREATE TABLE message_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,        -- "brain_to_agent", "agent_to_brain", "system"
  sender TEXT NOT NULL,
  receiver TEXT NOT NULL,
  payload JSON NOT NULL,
  priority INTEGER DEFAULT 0,   -- 0=highest
  status TEXT DEFAULT 'pending', -- pending, processing, done, failed
  created_at TEXT NOT NULL,
  processed_at TEXT,
  ttl_seconds INTEGER           -- 过期时间，NULL=永不过期
);
CREATE INDEX idx_queue_pending ON message_queue(channel, status, priority, created_at);
```

- Brain 和 SubAgent 通过 poll（50ms interval）或 SQLite 的 `sqlite3_update_hook` 获得近实时通知
- Phase 2 如果需要多机部署，消息队列层通过 Interface 替换为 Redis Streams，上下层无感知

---

### 10. Observer 告警机制

**告警规则引擎（规则 > 统计，Phase 1 不用 ML）：**

```
AlertRule {
  id: string
  name: string
  condition: expression          // 如 "agent.token_cost > 3 * agent.avg_token_cost"
  severity: "info" | "warning" | "critical"
  action: "log" | "notify_user" | "pause_agent" | "kill_agent"
  cooldown_seconds: int          // 同一规则的告警间隔
}
```

**内置规则：**

| 规则 | 条件 | 严重度 | 动作 |
|------|------|--------|------|
| Cost Spike | 单次 task cost > 3x 历史均值 | warning | notify_user |
| Stuck Agent | agent 心跳正常但 5 分钟无 tool call | warning | notify_user |
| Retry Storm | 同一 tool 连续失败 > 5 次 | critical | pause_agent |
| Budget Exceeded | task token 用量 > budget 的 120% | critical | kill_agent |
| Success Rate Drop | preset agent 最近 10 次 success_rate < 0.4 | warning | notify_user |

**通知渠道：** 通过 L0 的 channel adapter 推送给用户（走正常消息流，附带 `[SYSTEM ALERT]` 标记）。

---

## 三、新增盲区设计

### 11. 崩溃恢复（Crash Recovery）

**状态持久化策略：** Event Sourcing 思路——所有状态变更记录为事件，系统重启后 replay 恢复。

**Event Log 表：**

```sql
CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,       -- "task_created", "task_assigned", "agent_spawned", "checkpoint_saved", ...
  entity_type TEXT NOT NULL,      -- "task", "agent", "session"
  entity_id TEXT NOT NULL,
  payload JSON NOT NULL,
  created_at TEXT NOT NULL
);
```

**重启恢复流程：**
1. 读取最后的 session handoff document（如果存在）
2. 扫描 event_log，重建：
   - 所有 task 的当前状态
   - 所有 active agent 的最后已知状态（subagent 进程已死，标记为 crashed）
3. 对 `status=running` 的 task：
   - 有 checkpoint → 从最近 checkpoint 恢复，spawn 新 subagent 继续
   - 无 checkpoint → 标记为 failed，通知用户
4. Brain 进入 RESPONDING 状态，向用户汇报恢复情况
5. 恢复完成 → IDLE

**WAL（Write-Ahead Log）：**
- SQLite 自带 WAL mode，保证事务不丢
- event_log + tasks + message_queue 在同一个 SQLite 文件中，原子一致

---

### 12. LLM Provider 故障降级

**Provider Health Registry：**

```
ProviderHealth {
  provider: string         // "anthropic", "openai", "google", ...
  status: "healthy" | "degraded" | "down"
  latency_p50: int         // ms
  latency_p99: int
  error_rate_1h: float     // 最近 1 小时错误率
  last_success: ISO8601
  last_failure: ISO8601
}
```

**健康检查：** 每 60 秒做一次轻量 API 调用（如 list models），更新 health registry。

**降级链路：**

```
Brain:    Opus → Sonnet → 进入 DEGRADED 模式（不做 DAG 拆解，只处理单步任务）
SubAgent: Sonnet → Haiku → 报错上报 Brain（Brain 决定等待恢复或换 provider）
TEL:      不依赖 LLM → 无降级需求（如果 intent parsing 用了小模型，fallback 到规则引擎）
```

**DEGRADED 模式行为：**
- Brain 不做复杂 task 拆解，只处理"对话+单步执行"
- 主动通知用户："当前 LLM provider 异常，系统在降级模式运行，复杂任务暂时排队"
- 维护一个 pending_queue，provider 恢复后自动处理排队任务

---

### 13. LLM API Rate Limit 管理

**集中式 Rate Limiter：**

所有 LLM 调用（Brain + 所有 SubAgent）经过一个全局 Rate Limiter：

```
RateLimiter {
  // per provider 配置
  providers: {
    "anthropic": { rpm: 50, tpm: 400000, concurrent: 10 },
    "openai":    { rpm: 60, tpm: 600000, concurrent: 20 },
    ...
  }
  
  // 调用方法
  acquire(provider, estimated_tokens) → Promise<permit>
  // 如果超限：排队等待，不是直接拒绝
  // 返回 permit 后调用方才可发起 API 请求
  // permit 带 timeout，超时自动释放
}
```

**优先级：** Brain 的 LLM 调用永远优先于 SubAgent。SubAgent 之间按 task priority 排序。

**位置：** 横切模块，和 Token Budget Manager 同级。所有 LLM 调用必须经过它，不允许绕过。

---

### 14. 反压（Backpressure）机制

**问题：** 多个 subagent 同时完成，result envelope 涌入 Brain 的 inbox。

**策略：**
- Brain inbox 有上限（默认 20 条消息）
- 超过上限：新消息进入 overflow buffer（持久化到 SQLite）
- Brain 按优先级消费 inbox：用户消息 > 失败通知 > 完成通知 > 进度更新
- 如果 Brain 正在处理一个 LLM 调用（RESPONDING 状态），完成通知自动 buffer，等 IDLE 后批量消费
- 通知聚合的 debounce 窗口（300ms）天然起到削峰作用

**极端情况：** 如果 overflow buffer 也满了（>100），开始丢弃优先级最低的消息（进度更新类），并记录到 Observer。

---

### 15. Skill 版本管理

```
SkillVersion {
  skill_id: string
  version: semver             // "1.0.0", "1.1.0"
  status: "draft" | "active" | "deprecated"
  skill_md: text              // SKILL.md 内容
  scripts: [{path, hash}]    // 关联脚本
  created_at: ISO8601
  created_by: "human" | agent_id
}
```

**规则：**
- 同一 skill 同时只有一个 `active` 版本
- SubAgent spawn 时锁定当前 active 版本（snapshot），执行过程中 skill 更新不影响它
- 新版本发布流程：draft → 测试通过 → promote to active（旧版本自动变 deprecated）
- Human 创建的 skill 直接可以 active；agent 创建的必须先 draft，等 human 确认

---

### 16. 配置管理

**配置层级（优先级从高到低）：**

```
1. Runtime override（API 调用或 /config 命令动态修改）
2. Environment variables
3. mozi.json（主配置文件）
4. Default values（代码内置）
```

**mozi.json 结构：**

```yaml
system:
  max_parallel_agents: 5
  watchdog_interval_seconds: 5
  heartbeat_timeout_seconds: 15

brain:
  model: "claude-opus-4"
  fallback_model: "claude-sonnet-4"
  max_dag_depth: 5

token_budget:
  watermark_soft: 0.70
  watermark_hard: 0.85
  watermark_rotate: 0.95
  running_summary_cap_tokens: 2000
  subagent_startup_budget_pct: 0.10

tel:
  tools:
    shell:
      timeout: 60
      soft_timeout: 30
      retries: 1
      sandbox: "restricted"
    playwright:
      timeout: 120
      soft_timeout: 60
      retries: 2
      sandbox: "docker"
      fallback: "screenshot_and_report"

evolution:
  promote_min_spawns: 5
  promote_min_score: 0.8
  archive_inactive_days: 30
  demote_min_tasks: 10
  demote_score_threshold: 0.5

rate_limits:
  anthropic: { rpm: 50, tpm: 400000, concurrent: 10 }
  openai: { rpm: 60, tpm: 600000, concurrent: 20 }

security:
  default_permission: "L0_READ_ONLY"
  hard_gates: ["skill_register", "agent_promote", "l3_grant", "external_comm"]
```

**热更新：**
- `system`、`token_budget`、`evolution`、`rate_limits` 支持热更新（/config set 命令，不重启）
- `brain.model`、`security` 需要重启生效（安全考虑）
- 所有配置变更记录到 event_log（审计）

---

### 17. 冷启动（Bootstrap）

**出厂预装：**

```
bootstrap/
├── skills/              # Anthropic-compatible bundled skills
│   ├── docx/            # Word 文档
│   ├── pdf/             # PDF
│   ├── pptx/            # 演示文稿
│   ├── xlsx/            # 电子表格
│   └── skill-creator/   # 创建新 skill（自进化的种子）
├── agents/              # 预设 agent
│   ├── coder.yaml       # system_prompt + tools + permission
│   ├── reviewer.yaml
│   └── researcher.yaml
├── mozi.json            # 默认配置
└── welcome.md           # 首次对话的引导文案
```

**首次启动流程：**
1. 检测到空 workspace → 复制 bootstrap/ 到工作目录
2. Brain 启动，加载 welcome.md 作为首次 system prompt 补充
3. 引导用户完成：
   - 选择通信渠道（Telegram / Web UI / API）
   - 设置 LLM API keys
   - 可选：导入已有 MEMORY.md
4. 完成后删除 welcome.md，进入正常运行

**关键：`skill-create` 是最重要的 bootstrap skill** — 它是自进化的种子。有了它，系统可以根据需求自己创建所有其他 skill。

---

## 四、技术选型

### 核心决策因素

| 因素 | 权重 | 说明 |
|------|------|------|
| AI Coding 友好度 | 最高 | 你明确要求未来 100% AI coding，LLM 写哪种语言最可靠直接决定选型 |
| 异步 I/O 能力 | 高 | always-on daemon，大量并发 LLM API 调用、WebSocket、子进程管理 |
| 生态成熟度 | 高 | LLM SDK、Web 框架、ORM、消息队列客户端 |
| 性能 | 中 | 瓶颈在 LLM API 延迟（秒级），不在本地计算。CPU-bound 工作几乎没有 |
| 类型安全 | 中 | 系统复杂度高，类型系统能减少 bug |
| 部署简易度 | 中 | 单二进制 vs 解释器依赖 |

### 候选语言分析

**TypeScript (Node.js):**
- AI Coding 友好度：★★★★★ — LLM 写 TS 的质量仅次于 Python，类型系统提供了额外的 guardrail
- 异步 I/O：★★★★★ — Event loop 模型天生适合 I/O 密集型，原生 async/await
- 生态：★★★★☆ — OpenAI/Anthropic 官方 SDK、Express/Fastify、Prisma/Drizzle（ORM）、ws（WebSocket）、better-sqlite3
- 性能：★★★★☆ — V8 引擎足够快，worker_threads 可处理 CPU 密集型
- 类型安全：★★★★☆ — TypeScript 的类型系统成熟，Zod 做 runtime validation
- 部署：★★★☆☆ — 需要 Node.js runtime（但可以用 Bun 做单文件打包）

**Python (asyncio):**
- AI Coding 友好度：★★★★★ — LLM 写 Python 最可靠
- 异步 I/O：★★★☆☆ — asyncio 可用但不如 Node.js 自然，GIL 限制真并行
- 生态：★★★★★ — AI/ML 生态无敌（LangChain/LlamaIndex 虽不用但库多）、FastAPI、SQLAlchemy
- 性能：★★★☆☆ — 慢，但瓶颈不在这里
- 类型安全：★★★☆☆ — type hints + Pydantic，但运行时不强制
- 部署：★★☆☆☆ — 依赖管理复杂（venv/poetry/uv），打包不优雅

**Rust:**
- AI Coding 友好度：★★☆☆☆ — LLM 写 Rust 错误率高，borrow checker 是 AI 的噩梦
- 异步 I/O：★★★★★ — Tokio 异步运行时极其强大
- 生态：★★★☆☆ — LLM SDK 不成熟，Web 框架（Actix/Axum）可用
- 性能：★★★★★ — 无敌，但这个场景不需要
- 类型安全：★★★★★ — 编译器即安全网
- 部署：★★★★★ — 单二进制，零依赖
- 致命缺陷：**AI coding 不友好直接否决。** 你要 100% AI coding，Rust 的编译错误会让 AI agent 陷入无限修复循环。

**Go:**
- AI Coding 友好度：★★★★☆ — 语法简单，LLM 写得不错
- 异步 I/O：★★★★★ — goroutine 模型优秀
- 生态：★★★☆☆ — LLM SDK 相对少，ORM 不成熟
- 性能：★★★★☆ — 很快
- 类型安全：★★★★☆ — 静态类型，但泛型刚出，表达力弱于 TS
- 部署：★★★★★ — 单二进制

### 推荐：TypeScript（主体）+ Python（Skill 脚本层）

**理由：**

1. **TypeScript 做核心系统**（L1 Gateway、L2 Brain orchestration、TEL、Observer、Token Budget Manager、Config、消息队列）：
   - Node.js 的 event loop 天然适合"一个 always-on 进程管理大量异步 I/O"
   - LLM 写 TS 可靠，类型系统减少 runtime 错误
   - OpenClaw 本身就是 Node.js 实现，证明了这个技术栈做 agent gateway 可行
   - better-sqlite3 性能极好（比 Python sqlite3 快 5-10x）
   - 子进程管理用 `child_process.spawn`，成熟稳定

2. **Python 做 Skill 脚本和 Capability adapter**（L4 层的工具脚本、数据处理、ML 相关）：
   - Playwright Python SDK 比 Node 的更稳定，文档更好
   - 数据处理和分析 Python 无可替代
   - SubAgent 执行具体 skill 时可以 spawn Python 子进程
   - Skill 脚本用 Python 写 → AI coding 最可靠 → 自进化闭环最顺畅

3. **胶水层**：
   - TS 核心通过 `child_process` spawn Python 脚本
   - 通信用 JSON over stdio（跟 Claude Code 的 MCP 一致）
   - 不用 gRPC/REST 做内部通信（过重）

**不用 Rust 的决定性原因：** 你未来的目标是 100% AI coding，包括系统自身的迭代也要 AI 来做。Rust 的 borrow checker 会让 AI agent 在自我修改代码时频繁失败。TypeScript 在这方面的容错率高一个量级。

**不用纯 Python 的原因：** asyncio 写复杂的并发调度逻辑不如 Node.js 自然，而且 GIL 在多 subagent 管理场景（虽然主要是 I/O，但偶尔有 JSON 序列化/DAG 计算等 CPU 工作）是潜在瓶颈。

### 技术栈汇总

```
┌─────────────────────────────────────────────────┐
│ Core Runtime: TypeScript + Node.js (≥22 LTS)    │
│ Package Manager: pnpm                           │
│ Build: tsup (fast, zero-config)                 │
│ Runtime Validation: Zod                         │
│ HTTP/WebSocket: Fastify + @fastify/websocket    │
│ Database: better-sqlite3 (WAL mode)             │
│ Process Management: child_process.spawn         │
│ Scheduler: node-cron                            │
│ Logging: pino (structured JSON)                 │
├─────────────────────────────────────────────────┤
│ Skill Scripts: Python (≥3.11)                   │
│ Python Deps: uv (fast installer)                │
│ Browser: Playwright (Python)                    │
│ Data: pandas, httpx, pydantic                   │
├─────────────────────────────────────────────────┤
│ Storage: SQLite (single file)                   │
│   - tasks, events, message_queue, checkpoints   │
│   - agent_registry, skill_versions, traces      │
│ Memory: Markdown + Git (long-term)              │
│         SQLite (mid-term / task state)           │
│         In-process (short-term / context)        │
├─────────────────────────────────────────────────┤
│ Future (Phase 2+):                              │
│   Redis Streams (multi-node message queue)      │
│   PostgreSQL (multi-tenant persistence)         │
│   ClickHouse (analytics / observability)        │
│   Docker SDK (container-level sandbox)          │
└─────────────────────────────────────────────────┘
```

---

## 五、多租户预留设计

> MVP 是单用户单机。但架构必须让"加多租户"是扩展，不是重写。

### 核心原则：Tenant-Scoped Everything

从 Day 1 开始，所有数据结构都带 `tenant_id` 字段。MVP 阶段 `tenant_id = "default"`，但 schema 已经准备好。

### 数据隔离

```sql
-- 所有表都有 tenant_id
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  ...
);
CREATE INDEX idx_tasks_tenant ON tasks(tenant_id, status);

-- 消息队列也按 tenant 隔离
CREATE TABLE message_queue (
  ...
  tenant_id TEXT NOT NULL DEFAULT 'default',
  ...
);
```

**Memory 隔离：**
```
workspace/
├── tenants/
│   ├── default/          # MVP 的单用户
│   │   ├── SOUL.md
│   │   ├── MEMORY.md
│   │   ├── skills/
│   │   └── agents/
│   ├── tenant_abc/       # 未来的租户 A
│   └── tenant_xyz/       # 未来的租户 B
```

### 资源管控

**Tenant Resource Quota：**

```
TenantQuota {
  tenant_id: string
  
  // Token 预算
  daily_token_limit: int          // 每日总 token 上限
  monthly_token_limit: int
  max_tokens_per_task: int        // 单 task 上限
  
  // 并发
  max_parallel_agents: int        // 并发 subagent 数
  max_active_tasks: int           // 同时活跃 task 数
  
  // 存储
  max_storage_mb: int             // workspace 磁盘限额
  max_memory_entries: int         // 记忆条目上限
  max_skills: int                 // skill 数量上限
  
  // 计算
  max_shell_timeout: int          // shell 命令最大超时
  sandbox_type: "shared" | "container"  // 隔离级别
  
  // 模型访问
  allowed_models: string[]        // 允许使用的模型列表
  brain_model: string             // 指定 Brain 用哪个模型
}
```

**计费埋点：**
- 每次 LLM 调用记录 `{tenant_id, model, input_tokens, output_tokens, cost_usd}`
- 每次 tool call 记录 `{tenant_id, tool, duration_ms}`
- Observer 聚合 → 可对接计费系统

**资源强制执行：**
- Token Budget Manager 在每次 LLM 调用前检查 tenant quota
- 超限行为：soft limit（告警）→ hard limit（拒绝新 task，现有 task 可完成）
- Rate Limiter 按 tenant 分桶，防止单个租户耗尽全局 API 配额

### 计算隔离路径

```
Phase 1 (MVP):     单进程，tenant_id 做逻辑隔离
Phase 2 (SaaS):    每个 tenant 一个 worker 进程，共享 Gateway
Phase 3 (Enterprise): 每个 tenant 一组容器（Brain + Agent Pool），物理隔离
```

每个 Phase 都不需要改 Brain/TEL/Skill 的代码，只改部署拓扑和进程管理层。这就是分层架构的价值。

### 多租户 Brain 隔离

```
Gateway (L1, 共享)
  ├─ Tenant A Session → Brain A (独立 context, 独立 model config)
  ├─ Tenant B Session → Brain B
  └─ Tenant C Session → Brain C
```

每个 tenant 的 Brain 是独立的 LLM session（独立 system prompt，加载 tenant 自己的 SOUL.md/MEMORY.md）。Gateway 根据 tenant_id 路由到正确的 Brain 实例。

---

## 六、企业级 Web UI 设计

> 和 Telegram 完全等价的 Web 交互界面，"只是另一个 L0 adapter"。

### 设计原则

1. **单一对话入口** — 整个 UI 就是一个聊天窗口，没有复杂的 dashboard
2. **/ 命令系统** — 和 Telegram 里用 / 命令完全一致
3. **L0 adapter** — Web UI 是另一个 channel adapter，后端不需要任何改动

### UI 组成

```
┌─────────────────────────────────────────────┐
│  MOZI                              [user] ▼ │
├─────────────────────────────────────────────┤
│                                             │
│  [Chat messages area]                       │
│                                             │
│  System: Mozi is ready.                     │
│                                             │
│  You: /status                               │
│  Mozi: 3 tasks running, 2 agents active...  │
│                                             │
│  You: 帮我重构 src/api.ts                    │
│  Mozi: 已拆解为 3 个子任务，正在执行...        │
│                                             │
│  [Task Progress Cards - inline]             │
│  ┌─ Task 1: Refactor API ──── ✅ done ─┐   │
│  ┌─ Task 2: Update tests ──── ⏳ 60%  ─┐   │
│  ┌─ Task 3: Update docs ───── ⏸ wait  ─┐   │
│                                             │
│  [System Alert - inline]                    │
│  ⚠️ Agent cost spike detected (3.2x avg)    │
│                                             │
├─────────────────────────────────────────────┤
│  [/ commands autocomplete]                  │
│  /status /tasks /agents /config /approve    │
│                                             │
│  [Input box]                          [Send]│
│  [📎 File] [🎤 Voice]                       │
└─────────────────────────────────────────────┘
```

### / 命令列表

```
/status           — 系统状态概览（agents, tasks, token usage）
/tasks            — 列出所有活跃 task 及状态
/tasks <id>       — 查看单个 task 详情（DAG, subagent, cost）
/agents           — 列出所有 agent（preset + dynamic + archived）
/agents <id>      — 查看 agent 详情（评分、历史）
/config           — 查看当前配置
/config set <k> <v> — 修改配置（热更新项）
/approve <id>     — 审批 pending 的 skill 注册 / agent promotion / 权限提升
/reject <id>      — 拒绝审批
/memory           — 查看/搜索长期记忆
/skills           — 列出所有 skill
/kill <agent_id>  — 手动终止一个 agent
/cancel <task_id> — 取消一个 task
/budget           — Token 用量和预算
/trace <task_id>  — 查看 task 的完整 trace（调试用）
/help             — 命令列表
```

### 技术实现

```
Frontend: React + TailwindCSS + shadcn/ui
  - 一个 Chat 组件（复用成熟的开源 chat UI）
  - WebSocket 连接到 Gateway
  - 消息格式和 Telegram adapter 完全一致
  - Task Progress Cards 用 rich message 渲染（Gateway 发送结构化消息，前端解析）

Backend: 无额外后端
  - Web UI 直接连 Gateway 的 WebSocket endpoint
  - 认证：JWT token（企业环境对接 OIDC/SAML）
  - 鉴权：tenant_id 从 JWT 提取

部署：
  - 前端打包为静态文件，Gateway 直接 serve（Fastify static plugin）
  - 或独立部署到 CDN / Vercel
```

### 企业级扩展（不改核心架构）

- **SSO 对接**：Gateway 加一个 auth middleware，校验 JWT → 提取 tenant_id
- **审计日志**：Observer 的 event_log 按 tenant 导出
- **RBAC**：mozi.json 加 `roles` 配置，不同角色可用不同 / 命令
- **Custom Branding**：前端 theme 配置，per-tenant SOUL.md 定义 agent 人格

---

## 七、版本路线图

```
v0.1 — Skeleton
  TS 项目脚手架 + SQLite schema + 基础消息循环
  Brain 连接单个 LLM + 直接回复（无 subagent）
  Telegram adapter（最简）

v0.2 — SubAgent & TEL
  SubAgent spawn/kill lifecycle
  TEL 层（shell + filesystem 两个 tool）
  Task Brief / Result Envelope 协议
  Checkpoint 基础版

v0.3 — Intelligence
  Task DAG decomposition
  Skill Registry + skill-create bootstrap skill
  Running Summary + 水位线 compaction
  Session Handoff

v0.4 — Resilience
  Watchdog 进程
  Crash Recovery (event sourcing)
  LLM provider failover
  Rate Limiter
  Error context compression

v0.5 — Evolution
  SubAgent 评分体系
  Dynamic → Preset promotion flow
  Skill versioning
  Observer + alerting

v1.0 — Production
  Web UI
  Security model (permission levels + hard gates)
  Config management (hot reload)
  Cold bootstrap
  Documentation

v2.0 — Multi-tenant
  tenant_id activation
  Resource quotas
  Per-tenant Brain isolation
  Billing integration
  Enterprise auth (OIDC/SAML)
```

---

## Retired Brain State Checkpoint Design

The checkpoint design described in earlier revisions was never wired into the
production compression path and was removed in Issue #710. Current compression
uses `src/core/running-summary.ts`; durable task/session/checkpoint state remains
in its production stores. Historical `brain_state_snapshot` event/runtime rows
are preserved but no current producer or automatic reinjection is claimed.

---

*Document version: v1.1 · February 2026*
*Gap analysis based on v1.0 architecture + full design discussion transcript*
