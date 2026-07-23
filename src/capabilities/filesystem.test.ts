import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { read, write, append, list, search, remove, fileHash } from './filesystem.js';
import { createTempDir, removeTempDir } from '../test-helpers.js';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let tmpDir: string;

beforeAll(() => {
  tmpDir = createTempDir();
});

afterAll(() => {
  removeTempDir(tmpDir);
});

describe('capabilities/filesystem', () => {
  it('write + read', () => {
    const filePath = join(tmpDir, 'hello.txt');
    const snapshot = write(filePath, 'hello world');
    expect(snapshot.existed).toBe(false);
    expect(snapshot.hash_before).toBeNull();

    const content = read(filePath);
    expect(content).toBe('hello world');
  });

  it('write creates parent directories', () => {
    const filePath = join(tmpDir, 'deep', 'nested', 'file.txt');
    write(filePath, 'nested content');
    expect(read(filePath)).toBe('nested content');
  });

  it('write returns snapshot of existing file', () => {
    const filePath = join(tmpDir, 'existing.txt');
    write(filePath, 'v1');
    const snapshot = write(filePath, 'v2');
    expect(snapshot.existed).toBe(true);
    expect(snapshot.content_before).toBe('v1');
    expect(snapshot.hash_before).toBeTruthy();
  });

  it('path restriction blocks outside allowed_paths', () => {
    expect(() =>
      read('/etc/passwd', { allowed_paths: [tmpDir] })
    ).toThrow('Path not allowed');
  });

  it('path restriction allows within allowed_paths', () => {
    const filePath = join(tmpDir, 'allowed.txt');
    write(filePath, 'ok');
    const content = read(filePath, { allowed_paths: [tmpDir] });
    expect(content).toBe('ok');
  });

  it('list returns files and directories', () => {
    const subDir = join(tmpDir, 'listdir');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'a.txt'), 'a');
    mkdirSync(join(subDir, 'subdir'));

    const entries = list(subDir);
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const aFile = entries.find((e) => e.name === 'a.txt');
    expect(aFile).toBeTruthy();
    expect(aFile!.is_directory).toBe(false);

    const dir = entries.find((e) => e.name === 'subdir');
    expect(dir).toBeTruthy();
    expect(dir!.is_directory).toBe(true);
  });

  it('search finds files by pattern', () => {
    const searchDir = join(tmpDir, 'searchdir');
    mkdirSync(searchDir, { recursive: true });
    writeFileSync(join(searchDir, 'test.ts'), 'code');
    writeFileSync(join(searchDir, 'test.js'), 'code');
    writeFileSync(join(searchDir, 'readme.md'), 'doc');

    const tsFiles = search(searchDir, '*.ts');
    expect(tsFiles.length).toBe(1);
    expect(tsFiles[0]).toContain('test.ts');
  });

  it('search recursive finds in subdirectories', () => {
    const searchDir = join(tmpDir, 'recursivesearch');
    mkdirSync(join(searchDir, 'sub'), { recursive: true });
    writeFileSync(join(searchDir, 'root.txt'), 'root');
    writeFileSync(join(searchDir, 'sub', 'nested.txt'), 'nested');

    const results = search(searchDir, '*.txt', { recursive: true });
    expect(results.length).toBe(2);
  });

  it('remove deletes file', () => {
    const filePath = join(tmpDir, 'to-delete.txt');
    write(filePath, 'temp');
    expect(existsSync(filePath)).toBe(true);

    const snapshot = remove(filePath);
    expect(snapshot.existed).toBe(true);
    expect(snapshot.content_before).toBe('temp');
    expect(existsSync(filePath)).toBe(false);
  });

  it('remove non-existent returns snapshot with existed=false', () => {
    const filePath = join(tmpDir, 'never-existed.txt');
    const snapshot = remove(filePath);
    expect(snapshot.existed).toBe(false);
    expect(snapshot.hash_before).toBeNull();
  });

  it('fileHash returns null for non-existent file', () => {
    expect(fileHash(join(tmpDir, 'no-file.txt'))).toBeNull();
  });

  it('fileHash returns consistent hash', () => {
    const filePath = join(tmpDir, 'hash-test.txt');
    write(filePath, 'consistent');
    const hash1 = fileHash(filePath);
    const hash2 = fileHash(filePath);
    expect(hash1).toBe(hash2);
    expect(hash1).toBeTruthy();
  });

  describe('append', () => {
    it('appends to existing file', () => {
      const filePath = join(tmpDir, 'append-existing.txt');
      write(filePath, 'hello');
      const snapshot = append(filePath, ' world');
      expect(snapshot.existed).toBe(true);
      expect(snapshot.content_before).toBe('hello');
      expect(read(filePath)).toBe('hello world');
    });

    it('creates new file when appending to non-existent path', () => {
      const filePath = join(tmpDir, 'append-new-dir', 'append-new.txt');
      const snapshot = append(filePath, 'fresh content');
      expect(snapshot.existed).toBe(false);
      expect(snapshot.hash_before).toBeNull();
      expect(read(filePath)).toBe('fresh content');
    });

    it('respects path restriction', () => {
      expect(() =>
        append('/etc/evil.txt', 'data', { allowed_paths: [tmpDir] })
      ).toThrow('Path not allowed');
    });

    it('5 concurrent appends preserve all data', async () => {
      const filePath = join(tmpDir, 'concurrent-append.txt');
      write(filePath, '');

      // Each line is unique so we can verify all 5 arrived
      const lines = Array.from({ length: 5 }, (_, i) => `line-${i}\n`);

      // Fire all 5 appends concurrently (appendFileSync is OS-atomic per call)
      await Promise.all(
        lines.map((line) =>
          // Wrap in a microtask to simulate concurrent sessions
          new Promise<void>((resolve) => {
            setImmediate(() => {
              append(filePath, line);
              resolve();
            });
          }),
        ),
      );

      const result = readFileSync(filePath, 'utf-8');
      // Every line must appear exactly once
      for (const line of lines) {
        expect(result).toContain(line);
      }
      // Total length must equal sum of all lines (no data lost, no duplication)
      const totalExpectedLength = lines.reduce((sum, l) => sum + l.length, 0);
      expect(result.length).toBe(totalExpectedLength);
    });
  });
});
