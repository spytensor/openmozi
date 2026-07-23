import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { validatePath } from './router.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('tel/path-restriction', () => {
  describe('path traversal detection', () => {
    it('rejects paths with ..', () => {
      expect(() => validatePath('/tmp/../etc/passwd')).toThrow('traversal');
    });

    it('rejects paths with .. in middle', () => {
      expect(() => validatePath('/home/user/../../etc/shadow')).toThrow('traversal');
    });

    it('allows paths without ..', () => {
      expect(() => validatePath('/tmp/safe/file.txt')).not.toThrow();
    });
  });

  describe('absolute deny list', () => {
    it('rejects /etc', () => {
      expect(() => validatePath('/etc/passwd')).toThrow('deny list');
    });

    it('rejects /etc itself', () => {
      expect(() => validatePath('/etc')).toThrow('deny list');
    });

    it('rejects /root', () => {
      expect(() => validatePath('/root/.bashrc')).toThrow('deny list');
    });

    it('rejects paths containing /.ssh', () => {
      expect(() => validatePath('/home/user/.ssh/id_rsa')).toThrow('deny pattern');
    });

    it('rejects paths containing /.gnupg', () => {
      expect(() => validatePath('/home/user/.gnupg/pubring.gpg')).toThrow('deny pattern');
    });
  });

  describe('allowed_paths whitelist', () => {
    it('allows paths within allowed_paths', () => {
      expect(() => validatePath('/tmp/workspace/file.txt', ['/tmp/workspace'])).not.toThrow();
    });

    it('rejects paths outside allowed_paths', () => {
      expect(() => validatePath('/home/user/file.txt', ['/tmp/workspace'])).toThrow('not within allowed paths');
    });

    it('allows exact match of allowed path', () => {
      expect(() => validatePath('/tmp/workspace', ['/tmp/workspace'])).not.toThrow();
    });

    it('allows when no allowed_paths specified', () => {
      expect(() => validatePath('/tmp/any/file.txt')).not.toThrow();
    });

    it('allows when allowed_paths is empty array', () => {
      expect(() => validatePath('/tmp/any/file.txt', [])).not.toThrow();
    });

    it('checks multiple allowed paths', () => {
      const paths = ['/tmp/workspace', '/home/user/projects'];
      expect(() => validatePath('/home/user/projects/app/main.ts', paths)).not.toThrow();
      expect(() => validatePath('/var/log/app.log', paths)).toThrow('not within allowed paths');
    });
  });

  describe('deny list takes priority over allowed_paths', () => {
    it('still denies /etc even if in allowed_paths', () => {
      expect(() => validatePath('/etc/hosts', ['/etc'])).toThrow('deny list');
    });

    it('still denies .ssh even if in allowed_paths', () => {
      expect(() => validatePath('/home/.ssh/config', ['/home'])).toThrow('deny pattern');
    });
  });
});
