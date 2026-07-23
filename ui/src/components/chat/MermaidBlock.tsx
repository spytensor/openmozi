import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/theme/ThemeProvider";

/**
 * Mermaid diagram block for ```mermaid fences (presentation matrix: diagrams
 * are answer content and render inline, bounded). The mermaid library is a
 * heavy dependency, so it loads as its own lazy chunk on first use — never in
 * the entry bundle. On render failure the raw source shows as a code block
 * (truthful fallback, no invented diagram).
 */
let mermaidSeq = 0;

export default function MermaidBlock({ code }: { code: string }) {
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "dark" ? "dark" : "neutral",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        });
        const { svg: rendered } = await mermaid.render(`mozi-mermaid-${++mermaidSeq}`, code);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, resolvedTheme]);

  if (failed) {
    return (
      <pre className="!bg-[var(--code-bg)] overflow-x-auto rounded-lg p-3.5 font-mono text-xs text-ink/80">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      ref={hostRef}
      data-testid="mermaid-block"
      className="my-2 max-h-[420px] overflow-auto rounded-lg bg-ink/[0.02] p-3 shadow-[inset_0_0_0_1px_rgba(var(--ink-rgb),0.06)] [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // eslint-disable-next-line react/no-danger -- mermaid output under securityLevel: strict
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    >
      {svg ? undefined : <span className="text-[12px] text-ink/35">…</span>}
    </div>
  );
}
