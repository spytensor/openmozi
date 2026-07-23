import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface ArtifactErrorBoundaryProps {
  /** Reset the boundary when the rendered artifact changes. */
  resetKey: string;
  children: ReactNode;
}

interface ArtifactErrorBoundaryState {
  error: Error | null;
  resetKey: string;
}

/**
 * Contains renderer crashes (Sandpack, ReactMarkdown, iframe glue) to the
 * artifact body: the panel chrome stays alive and the raw failure is shown
 * truthfully instead of unmounting the whole app tree.
 */
export default class ArtifactErrorBoundary extends Component<ArtifactErrorBoundaryProps, ArtifactErrorBoundaryState> {
  state: ArtifactErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<ArtifactErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: ArtifactErrorBoundaryProps,
    state: ArtifactErrorBoundaryState,
  ): Partial<ArtifactErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error): void {
    console.error("[artifact] renderer crashed", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div data-testid="artifact-render-error" className="flex h-full items-center justify-center px-8">
          <div className="max-w-[420px] text-center">
            <AlertTriangle size={20} className="mx-auto mb-3 text-amber-400/80" />
            <p className="text-sm text-ink/70">Failed to render this artifact</p>
            <p className="mt-2 break-words font-mono text-[11px] leading-relaxed text-ink/35">
              {this.state.error.message}
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
