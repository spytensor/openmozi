/**
 * Icon vocabulary for agents.
 *
 * Drawn from `lucide-react`, which 56 other files already use — a second icon
 * library would put two stroke weights and two grids in the same view, which is
 * what makes an interface read as assembled rather than designed.
 *
 * Curated rather than exposing all ~1500 lucide icons: an agent is a role, and
 * a short list of role-shaped glyphs produces a coherent roster. A free pick
 * from everything produces a zoo.
 *
 * Selection rules, so additions stay consistent:
 * - Line glyphs only. No filled or duotone shapes — they read heavier than the
 *   surrounding UI at avatar size.
 * - The glyph must survive at 14px. Anything with fine interior detail is out.
 * - Say the *role*, not the vendor or the mood. No brand marks, no faces.
 */
import {
  Beaker,
  Binary,
  BookOpen,
  Bot,
  Braces,
  Bug,
  Calculator,
  ChartLine,
  Compass,
  Database,
  FileSearch,
  Gavel,
  Globe,
  Hammer,
  Languages,
  Layers,
  Lightbulb,
  Map,
  Megaphone,
  Microscope,
  Notebook,
  PenTool,
  Radar,
  Route,
  Scale,
  ScrollText,
  Shield,
  Sparkles,
  Stethoscope,
  Target,
  Telescope,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/** Stable ids. Persisted in AGENT.md, so renaming one is a breaking change. */
export const AGENT_ICONS = {
  bot: Bot,
  terminal: Terminal,
  braces: Braces,
  binary: Binary,
  bug: Bug,
  wrench: Wrench,
  hammer: Hammer,
  layers: Layers,
  database: Database,
  globe: Globe,
  radar: Radar,
  telescope: Telescope,
  microscope: Microscope,
  beaker: Beaker,
  "file-search": FileSearch,
  "book-open": BookOpen,
  "scroll-text": ScrollText,
  notebook: Notebook,
  "pen-tool": PenTool,
  languages: Languages,
  megaphone: Megaphone,
  "chart-line": ChartLine,
  calculator: Calculator,
  scale: Scale,
  gavel: Gavel,
  shield: Shield,
  stethoscope: Stethoscope,
  compass: Compass,
  map: Map,
  route: Route,
  target: Target,
  lightbulb: Lightbulb,
  sparkles: Sparkles,
} as const satisfies Record<string, LucideIcon>;

export type AgentIconId = keyof typeof AGENT_ICONS;

export const AGENT_ICON_IDS = Object.keys(AGENT_ICONS) as AgentIconId[];

export function isAgentIconId(value: string): value is AgentIconId {
  return Object.prototype.hasOwnProperty.call(AGENT_ICONS, value);
}

/**
 * Pick a stable icon for an agent that never declared one.
 *
 * Deterministic on the name so an agent keeps the same face across reloads,
 * across the three places it is rendered, and across machines. A random or
 * insertion-order choice would make the same agent look like two agents.
 */
function fallbackIconId(name: string): AgentIconId {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AGENT_ICON_IDS[Math.abs(hash) % AGENT_ICON_IDS.length];
}

/**
 * Resolve an agent's glyph.
 *
 * An unknown id falls back rather than throwing or rendering nothing: `icon` in
 * AGENT.md is free-form text a user can hand-edit, and a typo must not leave a
 * hole in the roster.
 */
export function agentIcon(icon: string | null | undefined, name: string): LucideIcon {
  const key = icon?.trim();
  if (key && isAgentIconId(key)) return AGENT_ICONS[key];
  return AGENT_ICONS[fallbackIconId(name)];
}
