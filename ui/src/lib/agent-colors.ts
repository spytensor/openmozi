/**
 * Agent identity palette, shared by MY AGENTS, the composer mention menu and
 * the chat delegation cards so one agent looks the same everywhere.
 *
 * `color` in AGENT.md is free-form, so an unmapped or missing value must land
 * on a neutral — never on a status colour that would read as a warning.
 */
export const AGENT_COLOR_IDS = ["ochre", "jade", "slate", "bronze", "violet"] as const;

export type AgentColorId = (typeof AGENT_COLOR_IDS)[number];

const AGENT_COLOR_TOKENS: Record<AgentColorId, string> = {
  ochre: "var(--agent-ochre)",
  jade: "var(--agent-jade)",
  slate: "var(--agent-slate)",
  bronze: "var(--agent-bronze)",
  violet: "var(--agent-violet)",
};

/** Background for an agent avatar; `--agent-fg` is always the foreground. */
export function agentAvatarColor(color?: string | null): string {
  const key = color?.trim() as AgentColorId | undefined;
  return (key && AGENT_COLOR_TOKENS[key]) || "var(--agent-neutral)";
}

/** First letter of an agent name, used as its avatar glyph. */
export function agentInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "A";
}
