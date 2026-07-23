# MOZI Onboarding & Model Router Design

## 一、Onboarding 流程

首次启动（或新租户）时，系统引导用户完成初始化。

### Step 1: 选择 Brain 模型

```
Welcome to MOZI.

Choose your Brain model (the orchestrator — needs strong reasoning):

1. Claude Opus 4      (Anthropic) — recommended
2. Claude Sonnet 4    (Anthropic) — balanced
3. GPT-5              (OpenAI)
4. Gemini 3 Pro       (Google)
5. Custom (enter provider/model)

Your choice: _
```

用户选完后填入 API Key（如果还没配置该 provider）。

### Step 2: 配置可用 Provider

```
Now let's set up your available LLM providers.
MOZI will test each one and figure out the best routing.

Providers detected from environment:
  ✅ Anthropic  (ANTHROPIC_API_KEY found)
  ❌ OpenAI     (no key)
  ❌ Google     (no key)

Add more providers? Enter API keys:
  OpenAI API Key (or skip): _
  Google API Key (or skip): _
  Deepseek API Key (or skip): _
  Custom provider (baseUrl + key, or skip): _
```

### Step 2.5: Provider Env 归一化（已实现）

`mozi onboard`（legacy alias: `mozi init`）和 Telegram onboarding 现在统一走 provider registry 的 env 解析，不再依赖单一变量名。

每个 provider 的 API key 优先级：

1. `MOZI_LIVE_<PROVIDER>_KEY`
2. `<PROVIDER>_API_KEYS`（逗号/分号分隔）
3. 主变量 + alias 变量（例如 Google: `GEMINI_API_KEY` / `GOOGLE_API_KEY`）
4. `<PROVIDER>_API_KEY_<N>`

示例：

```bash
MOZI_LIVE_OPENAI_KEY=...
OPENAI_API_KEYS=key-a,key-b
OPENAI_API_KEY=key-primary
OPENAI_API_KEY_1=key-1
```

```bash
GEMINI_API_KEY=...
GOOGLE_API_KEY=...   # alias
ZAI_API_KEY=...
Z_AI_API_KEY=...     # alias
```

### Step 3: Model Discovery & Benchmarking

用户配完 provider 后，Brain 自动执行模型探测：

```
🔍 Discovering available models...

Anthropic:
  ✅ claude-opus-4-20250514     (200k context)
  ✅ claude-sonnet-4-20250514   (200k context)
  ✅ claude-haiku-3.5           (200k context)

OpenAI:
  ✅ gpt-5                      (128k context)
  ✅ gpt-4.1                    (128k context)
  ✅ gpt-4.1-mini               (128k context)

Running quick benchmarks (30 seconds)...
```

**Benchmark Suite（轻量，<30s）：**

```
BenchmarkSuite {
  tests: [
    {
      name: "reasoning"
      prompt: "Solve: If A→B and B→C, does A→C? Answer yes/no with one sentence."
      evaluate: response => contains("yes") && length < 200
      // 测推理能力
    },
    {
      name: "instruction_following"
      prompt: "Return exactly this JSON: {\"status\": \"ok\", \"count\": 3}"
      evaluate: response => JSON.parse(response).status === "ok"
      // 测指令遵循
    },
    {
      name: "code_generation"
      prompt: "Write a Python function that reverses a string. Only output the function, nothing else."
      evaluate: response => response.includes("def ") && !response.includes("```")
      // 测代码生成 + 格式遵循
    },
    {
      name: "tool_calling"
      // 如果模型支持 function calling，测一次
      tool_def: {name: "get_time", params: {timezone: "string"}}
      prompt: "What time is it in Dubai?"
      evaluate: response => used_tool("get_time", {timezone: contains("Dubai")})
    }
  ]
  
  metrics_per_test: {
    latency_ms: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    passed: boolean
  }
}
```

### Step 4: Brain 生成 Model Router

Benchmark 结果出来后，Brain 自动生成路由配置：

```
📊 Benchmark Results:

Model                  Reasoning  Instruct  Code  Tools  Latency  Cost
claude-opus-4          ✅ 100%    ✅ 100%   ✅    ✅     1200ms   $$$
claude-sonnet-4        ✅ 100%    ✅ 100%   ✅    ✅     600ms    $$
claude-haiku-3.5       ✅ 85%     ✅ 90%    ✅    ✅     200ms    $
gpt-5                  ✅ 100%    ✅ 95%    ✅    ✅     800ms    $$$
gpt-4.1-mini           ✅ 80%     ✅ 85%    ✅    ❌     300ms    $

Recommended routing:
  Brain:           claude-opus-4 (your choice)
  Complex SubAgent: claude-sonnet-4 (reasoning ✅, cost $$)
  Simple SubAgent:  claude-haiku-3.5 (fast, cheap, good enough)
  Fallback Brain:   gpt-5 (if Anthropic is down)
  Summary/Compress: gpt-4.1-mini (cheapest that passes instruction test)

Apply this routing? [Y/n]: _
```

### Step 4b: Channel 配置（可选）

Wizard 在 Brain/Provider 配置完成后，基于 channel 注册表动态生成通道
选择清单（见 `src/onboarding/channels.ts`）。每一个注册在
`channelRegistry` 且实现了 `runWizard` 的 plugin 都会作为一个可勾选
项出现：

```
Which messaging channels would you like to configure? (Space toggles)
  [ ] Telegram        — Standard Telegram bot via @BotFather
  [ ] Discord         — Bot connected via the Discord Gateway
  [ ] Slack           — Socket-Mode bot (no public webhook needed)
  [ ] LINE            — LINE Messaging API (requires public URL)
  [ ] Feishu / Lark   — WSClient long-connection (no public URL)
  [ ] Matrix          — Matrix homeserver (matrix.org or self-hosted)
  [ ] WeChat iLink    — Personal WeChat via ClawBot bridge
  [ ] IRC             — IRC networks (Libera, OFTC, custom) over TLS
  [ ] Mattermost      — Self-hosted or cloud Mattermost server
  [ ] Twitch Chat     — Twitch chat bot (tmi.js)
  [ ] Google Chat     — Outgoing Incoming-Webhook notifications (beta)
  [ ] Microsoft Teams — Outgoing Incoming-Webhook notifications (beta)
```

选中的 plugin 依次调用 `plugin.runWizard(ctx)`：每个 plugin 自己
owns 它的 prompt 顺序、在线验证、以及要持久化的 env keys。结果通过
`persistEnvValue(key, value)` 写入 `~/.mozi/.env`（或加密存储）。

Update 菜单也由 `buildChannelUpdateMenuItems()` 动态生成 —— 用户可以
随时 `pnpm mozi onboard` → "Configure \<channel\>" 来修改某个 channel
的凭据，而不再需要在 wizard.ts 里硬编码 `update_telegram` /
`update_wechat` 分支。

新加 channel 时 **不需要** 改 wizard.ts —— 只要在
`src/channels/plugins/` 下加一个 plugin 文件、在
`src/channels/plugins/index.ts` 里 register 一下就好。完整的清单见
`docs/channels/README.md`。

### Step 5: 保存配置

```yaml
# 自动写入 mozi.json
brain:
  model: "claude-opus-4-20250514"
  provider: "anthropic"
  fallback_model: "gpt-5"
  fallback_provider: "openai"

model_router:
  complex_subagent:
    provider: "anthropic"
    model: "claude-sonnet-4-20250514"
  simple_subagent:
    provider: "anthropic"
    model: "claude-haiku-3.5-20250514"
  summary:
    provider: "openai"
    model: "gpt-4.1-mini"
  
  # Brain 后续可以动态调整（基于实际使用数据）
  auto_optimize: true
  optimize_interval_days: 7
```

---

## 二、Model Router 架构

### 层级

```
Brain (L2)
  ↓ 需要 spawn SubAgent
Model Router
  ↓ 根据 task 特征选择 model
  ├── task.complexity = "high" → complex_subagent model
  ├── task.complexity = "low"  → simple_subagent model
  ├── task.type = "summary"    → summary model
  └── task.type = "code"       → code model (如果单独配置了的话)
LLM Client
  ↓ 实际调用
Provider API
```

### Task 特征判断

Brain 在创建 Task Brief 时标注 task 的特征：

```
TaskBrief {
  ...
  hints: {
    complexity: "high" | "medium" | "low"
    type: "code" | "research" | "summary" | "review" | "general"
    needs_tool_calling: boolean
    estimated_tokens: int
  }
}
```

Model Router 根据 hints 选择最合适的模型。

### 动态优化（auto_optimize）

每周（或用户配置的间隔），Brain 执行一次 model routing review：

1. 从 Observer 收集过去一周的数据：
   - 每个模型在每种 task type 上的 success_rate
   - 每个模型的 avg latency 和 avg cost
   - 每个模型的 retry 率
2. 生成调整建议（Brain 自己分析数据做决策）
3. 如果 auto_optimize=true，直接应用
4. 如果 auto_optimize=false，提交给用户 /approve

```
🔄 Weekly Model Routing Review:

Changes proposed:
  - code tasks: claude-sonnet-4 → codex-gpt-5.3
    Reason: codex success_rate 95% vs sonnet 87% on code tasks
  - summary: gpt-4.1-mini → claude-haiku-3.5  
    Reason: haiku 40% cheaper, same quality on summaries

Apply? [Y/n]: _
```

---

## 三、Provider 抽象

### Provider Registry

```typescript
interface ProviderConfig {
  id: string;                    // "anthropic", "openai", "google", "custom_1"
  name: string;                  // "Anthropic"
  baseUrl?: string;              // 自定义 provider 的 base URL
  apiKey: string;                // encrypted at rest
  models: ModelInfo[];           // 该 provider 下可用的模型
  status: "healthy" | "degraded" | "down";
  rateLimit: { rpm: number; tpm: number; concurrent: number };
}

interface ModelInfo {
  id: string;                    // "claude-opus-4-20250514"
  name: string;                  // "Claude Opus 4"
  context_window: number;        // 200000
  supports_tools: boolean;
  supports_streaming: boolean;
  input_cost_per_1m: number;     // USD per 1M input tokens
  output_cost_per_1m: number;
  benchmark_results?: BenchmarkResult;
}
```

### Model Discovery

每个 provider adapter 实现 `listModels()` 方法：

```typescript
interface LLMProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  chat(model: string, messages: Message[], options?: ChatOptions): Promise<ChatResponse>;
  chatStream(model: string, messages: Message[], options?: ChatOptions): AsyncGenerator<StreamChunk>;
}
```

- Anthropic: 硬编码模型列表（API 不提供 list endpoint）
- OpenAI: `GET /v1/models`
- Google: `GET /v1beta/models`
- Custom: 尝试 OpenAI-compatible `/v1/models`，失败则要求用户手动输入

---

## 四、与现有架构的集成

### Config 扩展

在 mozi.json 中增加：

```yaml
providers:
  anthropic:
    api_key: "sk-ant-..."
    # models 自动发现，不需要手动列
  openai:
    api_key: "sk-..."
  google:
    api_key: "..."
  custom:
    - id: "deepseek"
      name: "DeepSeek"
      base_url: "https://api.deepseek.com/v1"
      api_key: "..."
      compatible: "openai"  # OpenAI-compatible API

model_router:
  brain:
    provider: "anthropic"
    model: "claude-opus-4-20250514"
  fallback_brain:
    provider: "openai"
    model: "gpt-5"
  roles:
    complex_subagent:
      provider: "anthropic"
      model: "claude-sonnet-4-20250514"
    simple_subagent:
      provider: "anthropic"
      model: "claude-haiku-3.5-20250514"
    summary:
      provider: "openai"
      model: "gpt-4.1-mini"
    code:
      provider: "anthropic"
      model: "claude-sonnet-4-20250514"
  auto_optimize: true
  optimize_interval_days: 7

onboarding:
  completed: false  # 首次启动为 false，完成后设为 true
```

### Onboarding 作为 Bootstrap Skill

Onboarding 本身是一个 skill（`bootstrap/skills/onboarding/`），Brain 在检测到 `onboarding.completed = false` 时自动触发。

这意味着：
- Onboarding 流程可以被 Brain 自我更新（作为 skill 的进化）
- 用户可以随时 `/onboard` 重新执行
- 多租户时每个 tenant 独立 onboarding
