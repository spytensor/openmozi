/**
 * Lightweight, deterministic admission signal for durable DAG execution.
 *
 * This function only classifies the request. The runtime owns enforcement in
 * brain-engine: once this returns true, inline tools and direct delivery are
 * not permitted until decompose_task has created a real persisted plan.
 */

/**
 * Explicit multi-phase / multi-step structure markers. A prompt that is
 * ORGANIZED into phases ("阶段一/二/三", "Phase 1/2", "Step 1:", "步骤二")
 * is the single strongest decomposition signal there is — a real production
 * failure shipped exactly this shape and the old signal list missed it
 * entirely (only "三个区域" matched, one signal, below threshold).
 */
const PHASE_MARKER = /(?:^|[\n*#>\s])(?:阶段|步骤|第\s*[一二三四五六七八九十\d]+\s*(?:阶段|步|部分|环节)|phase\s*\d|stage\s*\d|step\s*\d)/gim;

const CREATION_ACTION = /\b(?:build|create|develop|implement|produce|generate|deliver|design|migrate|automate|package|deploy|write)\b|构建|创建|开发|实现|生成|交付|设计|迁移|自动化|打包|部署|编写/i;
const RESEARCH_ACTION = /\b(?:collect|gather|compile|research|investigate|survey|retrieve|validate)\b|收集|搜集|调研|研究|调查|检索|验证/i;
const SMALL_SCOPE = /\b(?:brief|quick|simple|single|one[- ]page)\b|\bshort\s+(?:report|summary|answer|analysis)\b|简短|简要|快速|简单|单页/i;
const BROAD_SCOPE = /\b(?:multiple|several|many|each|every|all|dozens?|hundreds?|\d{2,})\b|多个|若干|每个|各个|全部|数十|数百|[二三四五六七八九十百]+\s*(?:个|份|页|国家|地区|文件)/i;
const COMPLEX_OBJECT = /\b(?:application|app|system|service|platform|marketplace|portal|workflow|automation|pipeline|dashboard|website|desktop|installer|report|presentation|workbook|spreadsheet)\b|应用|系统|服务|平台|商城|门户|工作流|自动化|流水线|仪表盘|网站|桌面|安装包|报告|演示文稿|工作簿|表格/i;

function countSignals(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

export function requiresDurablePlan(userMessage: string): boolean {
  const text = typeof userMessage === 'string' ? userMessage : '';
  // CJK characters carry more information per char; use a lower threshold
  const hasCjk = /[㐀-鿿]/.test(text);
  if (text.length < (hasCjk ? 10 : 30)) return false;

  // Two or more explicit phase/step markers = the user already decomposed
  // the task for us. No further evidence needed.
  const phaseMarkers = text.match(PHASE_MARKER);
  if (phaseMarkers && phaseMarkers.length >= 2) return true;

  // Research-heavy deliverables are intrinsically multi-phase even when the
  // user writes them as prose instead of explicit numbered steps. The three
  // independent requirements below intentionally avoid forcing a DAG for a
  // small request such as "summarize this paragraph as a report".
  const researchOrCollection = RESEARCH_ACTION.test(text);
  const creationRequested = CREATION_ACTION.test(text);
  const durableDeliverable = /\b(?:pdf|report|whitepaper|presentation|slide deck|workbook)\b|报告|白皮书|演示文稿|工作簿/i.test(text);
  const analysisOrVisualization = /\b(?:analy[sz](?:e|is)|quantitative(?:ly)?|scenario|visuali[sz](?:e|ation)|charts?|plots?|implications?|yield curve)\b|分析|量化|情景|可视化|图表|影响|收益率曲线/i.test(text);
  const genuinelySmallScope = SMALL_SCOPE.test(text) && !BROAD_SCOPE.test(text);
  if (creationRequested && researchOrCollection && durableDeliverable && analysisOrVisualization && !genuinelySmallScope) return true;
  if (creationRequested && durableDeliverable && BROAD_SCOPE.test(text)) return true;

  // Production builds are multi-phase even when written as a capability list
  // rather than numbered steps. Require an explicit creation verb plus several
  // independent lifecycle/capability signals so ordinary coding questions do
  // not get routed into a background plan.
  const productionBuildSignals = countSignals(text, [
    /\b(?:authentication|authorization|sign[- ]?in|sso|oauth)\b|认证|授权|登录/i,
    /\b(?:billing|payments?|subscriptions?)\b|计费|支付|订阅/i,
    /\b(?:roles?|permissions?|organizations?|multi[- ]tenant)\b|角色|权限|组织|多租户/i,
    /\b(?:dashboard|admin|audit logs?|observability|monitoring)\b|仪表盘|管理后台|审计日志|可观测|监控/i,
    /\b(?:automated tests?|integration tests?|end[- ]to[- ]end tests?|test suite)\b|自动化测试|集成测试|端到端测试/i,
    /\b(?:docker|container|packaging|installer)\b|容器|打包|安装包/i,
    /\b(?:deployment|production[- ]ready|infrastructure|ci\/?cd)\b|部署|生产就绪|基础设施|持续集成/i,
    /\b(?:documentation|runbook|operator guide)\b|文档|运行手册|操作指南/i,
  ]);
  if (creationRequested && productionBuildSignals >= 3) return true;

  const pipelineSignals = countSignals(text, [
    /\b(?:pipeline|etl|elt|workflow)\b|流水线|工作流/i,
    /\b(?:ingest|extract|collect|source connectors?)\b|摄取|采集|数据源/i,
    /\b(?:transform|normalize|clean|deduplicate|validate)\b|转换|清洗|去重|验证/i,
    /\b(?:load|warehouse|database|storage|publish)\b|加载|数仓|数据库|存储|发布/i,
    /\b(?:schedule|orchestrat|retry|monitor|alert)\w*\b|调度|编排|重试|监控|告警/i,
    /\b(?:tests?|docker|deploy|documentation)\b|测试|容器|部署|文档/i,
  ]);
  if (creationRequested && pipelineSignals >= 3) return true;

  // Office/document production can also require several independently
  // verifiable outputs. The action requirement prevents questions *about* an
  // existing report from being mistaken for a new production request.
  const officeSignals = countSignals(text, [
    /\b(?:pdf|report|document|presentation|slides?|workbook|spreadsheet)\b|PDF|报告|文档|演示文稿|幻灯片|工作簿|表格/i,
    /\b(?:charts?|tables?|visuali[sz]ations?|diagrams?)\b|图表|表格|可视化|示意图/i,
    /\b(?:sources?|citations?|references?|evidence)\b|来源|引用|参考资料|证据/i,
    /\b(?:analysis|scenario|forecast|comparison|recommendations?)\b|分析|情景|预测|比较|建议/i,
    /\b(?:appendix|speaker notes?|executive summary|methodology)\b|附录|演讲备注|执行摘要|方法论/i,
  ]);
  if (creationRequested && !genuinelySmallScope && officeSignals >= 4) return true;

  // Domain vocabularies can never enumerate every kind of complex product.
  // A creation request for a system/workflow plus a long capability list is a
  // structural signal: each clause is independently implementable/verifiable.
  const requirementSeparators = (text.match(/[,;；，]|\n\s*(?:[-*]|\d+[.)、])/g) ?? []).length;
  if (creationRequested && COMPLEX_OBJECT.test(text) && requirementSeparators >= 4) return true;

  const signals = [
    /compar|对比|比较|versus|vs\b/i.test(text),
    /and then.*and then|然后.*然后|同时.*同时/i.test(text),
    // A single item is not evidence of a multi-phase task. Requiring two or
    // more avoids routing requests such as "一个 SVG 图表来比较" into a DAG.
    /(?:\b(?:[2-9]\d*|1\d+)|[二三四五六七八九十]+)\s*(个|项|steps?|things?|products?|competitors?|files?)/i.test(text),
    /research.*report|调研.*报告|分析.*总结|investigate.*summarize|analyze.*summarize/i.test(text),
    /多个|multiple|several|各个|respectively|for each|each\b.*separately|separately\b.*each/i.test(text),
    // Deliverable-with-acceptance language: staged work heading for review
    /交付|验收|评审|deliverable|acceptance criteria|final report/i.test(text),
  ];
  return signals.filter(Boolean).length >= 2;
}

/** Backward-compatible name for callers that only need the boolean signal. */
export const shouldSuggestDecomposition = requiresDurablePlan;
