import type { CanvasHTMLAttributes, CSSProperties } from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";

/**
 * MOZI runtime activity semantics. Every value must be driven by a real
 * runtime signal (session FSM, turn status, tool kind) — never decorative
 * rotation. The mapping to thinking-orbs states lives here and only here.
 */
export type OrbActivity =
  | "thinking"
  | "working"
  | "responding"
  | "searching"
  | "writing"
  | "delegating";

const STATE_MAP: Record<OrbActivity, OrbState> = {
  thinking: "solving",
  working: "working",
  responding: "composing",
  searching: "searching",
  writing: "composing",
  delegating: "weaving",
};

/**
 * thinking-orbs ships exactly two tuned designs (64 and 20 CSS px), not a
 * scale factor. MOZI surfaces need three footprints, so the two odd ones
 * downscale the nearest larger design via CSS (canvas buffer stays at the
 * preset size × DPR, so downscaling keeps it crisp; upscaling would blur).
 */
const SIZE_PRESETS = {
  capsule: { preset: 64, css: 48 },
  inline: { preset: 20, css: 20 },
  micro: { preset: 20, css: 14 },
} as const;

export type OrbSizeVariant = keyof typeof SIZE_PRESETS;

interface ActivityOrbProps extends Omit<CanvasHTMLAttributes<HTMLCanvasElement>, "style"> {
  activity: OrbActivity;
  size?: OrbSizeVariant;
  style?: CSSProperties;
}

/**
 * The single wiring point for thinking-orbs. Nothing else in the UI may
 * import the library directly — swapping it or retuning the activity→state
 * mapping must stay a one-file change.
 *
 * Theme is left on "auto": the library watches the `data-theme` attribute
 * and `dark` class that ThemeProvider already writes on <html> (live, via
 * MutationObserver), so the DOM attribute stays the single source of truth
 * without coupling this component to React context.
 *
 * Always rendered decorative (aria-hidden): every call site pairs the orb
 * with its own visible or aria text label.
 */
export function ActivityOrb({ activity, size = "inline", style, ...rest }: ActivityOrbProps) {
  const { preset, css } = SIZE_PRESETS[size];
  return (
    <ThinkingOrb
      state={STATE_MAP[activity]}
      size={preset}
      theme="auto"
      aria-hidden="true"
      data-orb-activity={activity}
      style={css === preset ? style : { width: css, height: css, ...style }}
      {...rest}
    />
  );
}
