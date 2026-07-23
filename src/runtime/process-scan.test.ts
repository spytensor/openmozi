import { describe, expect, it } from 'vitest';
import { parsePsOutputForEntry } from './process-scan.js';

describe('runtime/process-scan', () => {
  it('extracts pids whose command contains entry path', () => {
    const entryPath = '/repo/Mozi/dist/index.js';
    const output = [
      '1001 /usr/local/bin/node /repo/Mozi/dist/index.js',
      '1002 /usr/local/bin/node /repo/Mozi/dist/other.js',
      '1003 /usr/local/bin/node /repo/Mozi/dist/index.js --flag',
      'not-a-row',
      '',
    ].join('\n');

    expect(parsePsOutputForEntry(output, entryPath)).toEqual([1001, 1003]);
  });

  it('deduplicates repeated pid rows', () => {
    const entryPath = '/repo/Mozi/dist/index.js';
    const output = [
      '2001 /usr/local/bin/node /repo/Mozi/dist/index.js',
      '2001 /usr/local/bin/node /repo/Mozi/dist/index.js --same',
    ].join('\n');

    expect(parsePsOutputForEntry(output, entryPath)).toEqual([2001]);
  });
});

