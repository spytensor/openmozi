/**
 * Self-Modification Tool - MOZI can improve its own code
 * Reads target file, sends to LLM with instruction, writes modified content,
 * runs tests, and rolls back on failure.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '../store/db.js';
import { exec } from '../capabilities/shell.js';
import type { LLMClient } from '../core/llm.js';
import { getRuntimeProjectRoot } from '../runtime/project-root.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:self-modify' });

/** Test timeout: 2 minutes */
const TEST_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Ensure the self_modifications table exists.
 */
export function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_modifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_file TEXT NOT NULL,
      instruction TEXT NOT NULL,
      original_content TEXT,
      modified_content TEXT,
      diff_summary TEXT,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reverted_at DATETIME,
      test_passed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'applied'
    )
  `);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModificationResult {
  success: boolean;
  filePath: string;
  diff_summary: string;
  test_passed: boolean;
  rolled_back: boolean;
  error?: string;
}

export interface ImproveCodeParams {
  target: string;
  issue: string;
  approach: string;
  auto_apply?: boolean;
}

// ---------------------------------------------------------------------------
// Core: applyModification
// ---------------------------------------------------------------------------

/**
 * Apply an LLM-driven code modification to a file.
 * Flow: read file -> LLM generates modified content -> write -> run tests ->
 * if tests fail, restore backup -> record result.
 */
export async function applyModification(
  filePath: string,
  instruction: string,
  client: LLMClient,
): Promise<ModificationResult> {
  ensureTable();

  // Security: resolve and validate path is within src/
  const projectRoot = getRuntimeProjectRoot();
  const resolved = resolve(projectRoot, filePath);
  const srcDir = resolve(projectRoot, 'src');

  if (!resolved.startsWith(srcDir)) {
    return {
      success: false,
      filePath,
      diff_summary: '',
      test_passed: false,
      rolled_back: false,
      error: `Security: can only modify files in src/ directory. Got: ${filePath}`,
    };
  }

  if (!existsSync(resolved)) {
    return {
      success: false,
      filePath,
      diff_summary: '',
      test_passed: false,
      rolled_back: false,
      error: `File not found: ${filePath}`,
    };
  }

  // Read original content
  let originalContent: string;
  try {
    originalContent = readFileSync(resolved, 'utf-8');
  } catch (err) {
    return {
      success: false,
      filePath,
      diff_summary: '',
      test_passed: false,
      rolled_back: false,
      error: `Could not read file: ${err}`,
    };
  }

  // Ask LLM to modify the file
  let modifiedContent: string;
  try {
    const response = await client.chat([
      {
        role: 'system',
        content: 'You are modifying a TypeScript file. Return ONLY the complete modified file content, nothing else. No markdown fences, no explanations.',
      },
      {
        role: 'user',
        content: `Here is the current content of ${filePath}:\n\n${originalContent}\n\nInstruction: ${instruction}\n\nReturn ONLY the complete modified file content.`,
      },
    ]);
    modifiedContent = response.content.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      filePath,
      diff_summary: '',
      test_passed: false,
      rolled_back: false,
      error: `LLM call failed: ${msg}`,
    };
  }

  if (!modifiedContent || modifiedContent === originalContent) {
    return {
      success: false,
      filePath,
      diff_summary: 'No changes produced by LLM',
      test_passed: false,
      rolled_back: false,
      error: 'LLM returned identical or empty content',
    };
  }

  // Compute a simple diff summary
  const origLines = originalContent.split('\n').length;
  const modLines = modifiedContent.split('\n').length;
  const diffSummary = `${origLines} lines -> ${modLines} lines (${modLines - origLines >= 0 ? '+' : ''}${modLines - origLines})`;

  // Write modified content
  try {
    writeFileSync(resolved, modifiedContent, 'utf-8');
  } catch (err) {
    return {
      success: false,
      filePath,
      diff_summary: diffSummary,
      test_passed: false,
      rolled_back: false,
      error: `Could not write file: ${err}`,
    };
  }

  // Run tests
  logger.info({ filePath }, 'Running tests after modification');
  const testResult = await exec('pnpm test', {
    timeout: TEST_TIMEOUT_MS,
    cwd: projectRoot,
  });

  const testPassed = testResult.exit_code === 0 && !testResult.timed_out;

  // If tests fail, roll back
  let rolledBack = false;
  if (!testPassed) {
    logger.warn({ filePath, exit_code: testResult.exit_code }, 'Tests failed, rolling back');
    try {
      writeFileSync(resolved, originalContent, 'utf-8');
      rolledBack = true;
    } catch (err) {
      logger.error({ filePath, err }, 'Failed to restore backup');
    }
  }

  // Record to DB
  const db = getDb();
  const status = testPassed ? 'applied' : (rolledBack ? 'rolled_back' : 'failed');
  db.prepare(`
    INSERT INTO self_modifications (target_file, instruction, original_content, modified_content, diff_summary, test_passed, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(filePath, instruction, originalContent, modifiedContent, diffSummary, testPassed ? 1 : 0, status);

  logger.info({ filePath, status, testPassed, rolledBack }, 'Modification completed');

  return {
    success: testPassed,
    filePath,
    diff_summary: diffSummary,
    test_passed: testPassed,
    rolled_back: rolledBack,
    error: testPassed ? undefined : `Tests failed (exit ${testResult.exit_code}). ${rolledBack ? 'Rolled back.' : 'Rollback failed.'}`,
  };
}

// ---------------------------------------------------------------------------
// improveCode (legacy wrapper, used by executor)
// ---------------------------------------------------------------------------

/**
 * The improve_code tool entry point. Wraps applyModification with
 * a human-readable report.
 */
export async function improveCode(params: ImproveCodeParams, client?: LLMClient): Promise<string> {
  const { target, issue, approach, auto_apply = false } = params;

  ensureTable();

  if (!client) {
    // No client provided — record the intention only
    const db = getDb();
    db.prepare(`
      INSERT INTO self_modifications (target_file, instruction, status)
      VALUES (?, ?, ?)
    `).run(target, `${issue}\nApproach: ${approach}`, 'suggested');

    return `Self-modification suggestion recorded for ${target}.\nIssue: ${issue}\nApproach: ${approach}\n\nNote: No LLM client provided. Pass a client to enable auto-apply.`;
  }

  if (!auto_apply) {
    // Suggestion mode — just record, don't modify
    const db = getDb();
    db.prepare(`
      INSERT INTO self_modifications (target_file, instruction, status)
      VALUES (?, ?, ?)
    `).run(target, `${issue}\nApproach: ${approach}`, 'suggested');

    return `Self-modification suggestion recorded for ${target}.\nIssue: ${issue}\nApproach: ${approach}\n\nSet auto_apply=true to apply changes.`;
  }

  // Auto-apply: use applyModification
  const instruction = `Issue: ${issue}\nApproach: ${approach}`;
  const result = await applyModification(target, instruction, client);

  if (result.success) {
    return `Modification applied successfully to ${target}.\nDiff: ${result.diff_summary}\nTests: PASSED`;
  }

  return `Modification failed for ${target}.\nDiff: ${result.diff_summary}\nRolled back: ${result.rolled_back}\nError: ${result.error}`;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Get history of self-modifications.
 */
export function getSelfModifications(limit = 10): Array<{
  id: number;
  target_file: string;
  instruction: string;
  diff_summary: string | null;
  status: string;
  test_passed: number;
  applied_at: string;
}> {
  ensureTable();
  const db = getDb();
  return db.prepare(`
    SELECT id, target_file, instruction, diff_summary, status, test_passed, applied_at
    FROM self_modifications
    ORDER BY applied_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: number;
    target_file: string;
    instruction: string;
    diff_summary: string | null;
    status: string;
    test_passed: number;
    applied_at: string;
  }>;
}

/**
 * Revert a previously applied modification by restoring original content.
 */
export async function revertModification(id: number): Promise<string> {
  ensureTable();
  const db = getDb();

  const mod = db.prepare('SELECT * FROM self_modifications WHERE id = ?').get(id) as {
    id: number;
    target_file: string;
    original_content: string | null;
    status: string;
  } | undefined;

  if (!mod) {
    return `Error: Modification not found: ${id}`;
  }

  if (mod.status === 'rolled_back' || mod.status === 'reverted') {
    return `Modification ${id} is already ${mod.status}.`;
  }

  if (!mod.original_content) {
    return `Error: No original content stored for modification ${id}. Cannot revert.`;
  }

  const projectRoot = getRuntimeProjectRoot();
  const resolved = resolve(projectRoot, mod.target_file);

  try {
    writeFileSync(resolved, mod.original_content, 'utf-8');
  } catch (err) {
    return `Error: Could not write file: ${err}`;
  }

  db.prepare('UPDATE self_modifications SET status = ?, reverted_at = datetime("now") WHERE id = ?')
    .run('reverted', id);

  return `Reverted modification ${id} on ${mod.target_file}. Original content restored.`;
}
