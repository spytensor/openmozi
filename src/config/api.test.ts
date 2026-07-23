import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { loadConfig } from './index.js';
import { handleConfigCommand } from './api.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  loadConfig(); // Initialize with defaults
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('config/api', () => {
  describe('handleConfigCommand', () => {
    it('shows current config when no args', () => {
      const result = handleConfigCommand('');
      expect(result).toContain('Current configuration');
      expect(result).toContain('max_parallel_agents');
      expect(result).toContain('brain.model');
    });

    it('shows usage for invalid format', () => {
      const result = handleConfigCommand('invalid');
      expect(result).toContain('Usage');
    });

    it('updates a hot-reloadable numeric value', () => {
      const result = handleConfigCommand('set system.max_parallel_agents 10');
      expect(result).toContain('Config updated');
      expect(result).toContain('10');
    });

    it('updates a hot-reloadable decimal value', () => {
      const result = handleConfigCommand('set token_budget.watermark_soft 0.65');
      expect(result).toContain('Config updated');
      expect(result).toContain('0.65');
    });

    it('updates evolution config', () => {
      const result = handleConfigCommand('set evolution.promote_min_score 0.85');
      expect(result).toContain('Config updated');
    });

    it('rejects non-hot-reloadable keys', () => {
      const result = handleConfigCommand('set brain.model gpt-5');
      expect(result).toContain('failed');
      expect(result).toContain('not hot-updatable');
    });

    it('rejects security config changes', () => {
      const result = handleConfigCommand('set security.default_permission L3_FULL_ACCESS');
      expect(result).toContain('failed');
    });

    it('shows usage for incomplete set command', () => {
      const result = handleConfigCommand('set system.max_parallel_agents');
      expect(result).toContain('Usage');
    });
  });
});
