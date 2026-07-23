import type { ArtifactEvent } from '../artifacts/types.js';

/** Channel-neutral callbacks emitted while a Brain turn executes. */
export interface ProgressCallback {
  onToolStart: (toolName: string) => void;
  onToolEnd: (toolName: string) => void;
  onProcessingStart: () => void;
  onStreamChunk?: (accumulated: string) => void;
  onStreamEnd?: (fullText: string) => void;
  /** Roll back a partial stream that must not remain visible or durable. */
  onStreamReset?: () => void;
  onArtifact?: (event: ArtifactEvent) => void;
  /**
   * Fired exactly once, before any stream/artifact/final frame, when the turn
   * binds to a session the caller did not already name — i.e. a brand-new Web
   * chat where the client sent no sessionId (Issue #627). Channels use it to
   * tell the originating client which session now owns the turn so its
   * session-scoped filter accepts the frames that follow. Never fired for a
   * message that already carried a valid sessionId, so existing-session
   * behavior is unchanged.
   */
  onSessionResolved?: (sessionId: string) => void;
}
