import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluatePromptContract,
  isPromptSurfaceFile,
  isRuntimeFeatureFile,
  PROMPT_FILES,
  PROMPT_SURFACE_FILES,
} from './prompt-contract.mjs';

describe('scripts/prompt-contract', () => {
  it('detects runtime feature files', () => {
    expect(isRuntimeFeatureFile('src/gateway/handler.ts')).toBe(true);
    expect(isRuntimeFeatureFile('src/core/model-router.ts')).toBe(true);
    expect(isRuntimeFeatureFile('src/templates/SOUL.md')).toBe(false);
    expect(isRuntimeFeatureFile('src/gateway/handler.test.ts')).toBe(false);
    expect(isRuntimeFeatureFile('README.md')).toBe(false);
  });

  it('names files that exist', () => {
    // The list is matched by exact path, so a rename would silently switch the
    // gate off — it would simply stop finding anything to guard.
    const root = join(import.meta.dirname, '..');
    for (const file of [...PROMPT_SURFACE_FILES, ...PROMPT_FILES]) {
      expect(existsSync(join(root, file)), `${file} no longer exists — update prompt-contract.mjs`).toBe(true);
    }
  });

  it('catches a tool added to an existing category', () => {
    // The drift that actually happens: `shell_sudo` appended to SHELL_TOOLS. It
    // never touches definitions.ts — ALL_TOOLS just spreads the leaf — so naming
    // the barrel alone left the gate silent for the most common case there is.
    const result = evaluatePromptContract(['src/tools/shell-tools.ts', 'CHANGELOG.md']);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('shell-tools.ts');
  });

  it('identifies the files that decide what the prompt claims', () => {
    // The prompt states two things it does not know itself: the tool list and the
    // capability summary. These render them; everything else is plumbing.
    expect(isPromptSurfaceFile('src/core/capability-manifest.ts')).toBe(true);
    expect(isPromptSurfaceFile('src/tools/definitions.ts')).toBe(true);
    expect(isPromptSurfaceFile('src/system-prompt.ts')).toBe(true);
    expect(isPromptSurfaceFile('src/tools/tool-shaping.ts')).toBe(true);
    // Individual tool declarations, and the registry the prompt renders from.
    expect(isPromptSurfaceFile('src/tools/shell-tools.ts')).toBe(true);
    expect(isPromptSurfaceFile('src/tools/dynamic-registry.ts')).toBe(true);
    // Execution plumbing in the same directory declares no tools.
    expect(isPromptSurfaceFile('src/tools/executor.ts')).toBe(false);
    expect(isPromptSurfaceFile('src/memory/session-timeline.ts')).toBe(false);
    expect(isPromptSurfaceFile('src/channels/websocket.ts')).toBe(false);
    expect(isPromptSurfaceFile('src/tools/definitions.test.ts')).toBe(false);
  });

  it('demands a prompt update when the prompt could start lying', () => {
    const result = evaluatePromptContract(['src/core/capability-manifest.ts', 'CHANGELOG.md']);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('capability-manifest');
  });

  it('does not demand a prompt update for work the prompt does not describe', () => {
    // The gate used to fire on any file under a runtime root. A timeline
    // persistence fix has no prompt implication, so the demand could not be met
    // honestly — only by a cosmetic edit or the bypass.
    const result = evaluatePromptContract([
      'src/memory/session-timeline.ts',
      'src/channels/websocket.ts',
      'CHANGELOG.md',
    ]);
    expect(result.ok).toBe(true);
  });

  it('still demands a changelog for any runtime change', () => {
    const result = evaluatePromptContract(['src/gateway/handler.ts']);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('CHANGELOG');
  });

  it('passes when a prompt-surface change updates the prompt and changelog', () => {
    const result = evaluatePromptContract([
      'src/tools/tool-shaping.ts',
      'src/templates/SOUL.md',
      'CHANGELOG.md',
    ]);
    expect(result.ok).toBe(true);
  });

  it('passes when only non-runtime files change', () => {
    const result = evaluatePromptContract([
      'README.md',
      'docs/ARCHITECTURE-GAPS.md',
    ]);
    expect(result.ok).toBe(true);
  });
});
