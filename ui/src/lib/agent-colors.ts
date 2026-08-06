/**
 * Agent identity palette, shared by MY AGENTS, the composer mention menu and
 * the chat delegation cards so one agent looks the same everywhere.
 *
 * `color` in AGENT.md is free-form. A recognized palette id wins; otherwise
 * the stable Agent name selects from the same identity palette. This keeps an
 * Agent recognizable without exposing colour selection to the model.
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

/** The identity hue itself, for swatches and any single-colour use. */
export function agentAvatarColor(color?: string | null, agentName?: string | null): string {
  const key = color?.trim() as AgentColorId | undefined;
  if (key && AGENT_COLOR_TOKENS[key]) return AGENT_COLOR_TOKENS[key];
  const name = agentName?.trim().toLowerCase();
  if (!name) return "var(--agent-neutral)";
  let hash = 0;
  for (const char of name) hash = ((hash * 31) + char.codePointAt(0)!) >>> 0;
  return AGENT_COLOR_TOKENS[AGENT_COLOR_IDS[hash % AGENT_COLOR_IDS.length]];
}

/**
 * Avatar styling: the glyph alone, in the agent's hue.
 *
 * No fill behind it. `docs/DESIGN.md` allows an icon to sit on a tinted fill
 * *or* bare, and at avatar size the tint reads as a container the glyph has
 * been put inside — one more box in a view that already has cards and rows.
 * The hue alone carries the identity. Not a ring either: the same rule treats
 * a border around a small glyph as an empty frame.
 */
export function agentAvatarStyle(color?: string | null, agentName?: string | null): { color: string } {
  return { color: agentAvatarColor(color, agentName) };
}

/**
 * Tinted fill, used only for the pressed state of the icon picker.
 *
 * A picker is a control and needs a visible selection; an avatar is a label
 * and does not.
 */
export function agentSwatchStyle(color?: string | null): { background: string; color: string } {
  const hue = agentAvatarColor(color);
  return { background: `color-mix(in srgb, ${hue} 18%, transparent)`, color: hue };
}
