/**
 * Project Detection — Detect workspace project type and suggest proactive setup.
 *
 * Scanned on first interaction to offer background tasks (daily summary, etc.)
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';

const logger = pino({ name: 'mozi:project-detection' });

export interface ProjectInfo {
  detected: boolean;
  type: 'typescript' | 'python' | 'rust' | 'go' | 'java' | 'generic' | 'none';
  name?: string;
  fileCount?: number;
  hasGit: boolean;
  suggestions: string[];
}

/**
 * Detect project type from a directory.
 */
export function detectProject(dir: string): ProjectInfo {
  const result: ProjectInfo = {
    detected: false,
    type: 'none',
    hasGit: false,
    suggestions: [],
  };

  try {
    if (!existsSync(dir)) return result;

    result.hasGit = existsSync(join(dir, '.git'));

    // TypeScript/JavaScript
    if (existsSync(join(dir, 'package.json'))) {
      result.detected = true;
      result.type = existsSync(join(dir, 'tsconfig.json')) ? 'typescript' : 'generic';
      try {
        const pkg = JSON.parse(require('node:fs').readFileSync(join(dir, 'package.json'), 'utf-8'));
        result.name = pkg.name;
      } catch { /* ignore */ }
    }
    // Python
    else if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'setup.py')) || existsSync(join(dir, 'requirements.txt'))) {
      result.detected = true;
      result.type = 'python';
    }
    // Rust
    else if (existsSync(join(dir, 'Cargo.toml'))) {
      result.detected = true;
      result.type = 'rust';
    }
    // Go
    else if (existsSync(join(dir, 'go.mod'))) {
      result.detected = true;
      result.type = 'go';
    }
    // Java
    else if (existsSync(join(dir, 'pom.xml')) || existsSync(join(dir, 'build.gradle'))) {
      result.detected = true;
      result.type = 'java';
    }

    // Count files
    if (result.detected) {
      try {
        const srcDirs = ['src', 'lib', 'app'].filter(d => existsSync(join(dir, d)));
        let count = 0;
        for (const d of srcDirs) {
          count += countFiles(join(dir, d));
        }
        result.fileCount = count;
      } catch { /* ignore */ }
    }

    // Generate suggestions
    if (result.detected) {
      if (result.hasGit) {
        result.suggestions.push('每天早晨的 Git 变更摘要');
      }
      result.suggestions.push('项目活动每日晨报');
      if (result.type === 'typescript' || result.type === 'python') {
        result.suggestions.push('代码改动时提醒跑测试');
      }
    }

  } catch (err) {
    logger.warn({ dir, err: err instanceof Error ? err.message : String(err) }, 'Project detection failed');
  }

  return result;
}

function countFiles(dir: string, max = 500): number {
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= max) break;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (entry.isFile()) count++;
      else if (entry.isDirectory()) count += countFiles(join(dir, entry.name), max - count);
    }
  } catch { /* ignore permission errors */ }
  return count;
}

/**
 * Generate a first-interaction suggestion message based on project detection.
 */
export function generateFirstInteractionSuggestion(dir: string): string | null {
  const project = detectProject(dir);
  if (!project.detected || project.suggestions.length === 0) return null;

  const typeLabel: Record<string, string> = {
    typescript: 'TypeScript',
    python: 'Python',
    rust: 'Rust',
    go: 'Go',
    java: 'Java',
    generic: 'Node.js',
  };

  const lines = [
    `我检测到你在一个 ${typeLabel[project.type] ?? ''} 项目${project.name ? ` (${project.name})` : ''}${project.fileCount ? ` 中，有约 ${project.fileCount} 个源文件` : ''}。`,
    '',
    '我可以帮你设置：',
    ...project.suggestions.map(s => `  → ${s}`),
    '',
    '回复"设置"开启，或者随时告诉我你需要什么。',
  ];

  return lines.join('\n');
}
