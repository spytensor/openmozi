import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '../test-helpers.js';
import { extractSkillFromArchive, isSkillArchivePath } from './skill-archive.js';

const SKILL_BODY = `---
name: Sector Chip Rating
description: Rate A-share sector chip structure
---

Do the rating.
`;

const scratchDirs: string[] = [];
const extracted: string[] = [];

function scratch(): string {
  const dir = createTempDir();
  scratchDirs.push(dir);
  return dir;
}

/** Zip `contents` (paths relative to `rootDir`) into `archivePath`. */
function zipDir(rootDir: string, archivePath: string, entries: string[]): void {
  execFileSync('zip', ['-q', '-r', '-y', archivePath, ...entries], { cwd: rootDir, stdio: 'pipe' });
}

function writeSkillTree(baseDir: string, dirName: string): string {
  const skillDir = join(baseDir, dirName);
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL_BODY);
  writeFileSync(join(skillDir, 'scripts', 'score.py'), 'print("score")\n');
  return skillDir;
}

afterEach(() => {
  for (const dir of extracted.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const dir of scratchDirs.splice(0)) removeTempDir(dir);
});

describe('skills/skill-archive', () => {
  it('recognizes skill package extensions', () => {
    expect(isSkillArchivePath('/tmp/a.skill')).toBe(true);
    expect(isSkillArchivePath('/tmp/a.zip')).toBe(true);
    expect(isSkillArchivePath('/tmp/A.ZIP')).toBe(true);
    expect(isSkillArchivePath('/tmp/a.tar.gz')).toBe(true);
    expect(isSkillArchivePath('/tmp/a.xlsx')).toBe(false);
    expect(isSkillArchivePath('/tmp/SKILL.md')).toBe(false);
  });

  /**
   * The exact shape that failed in production on 2026-07-27: a zip holding a
   * `.skill` bundle (itself a zip) next to an unrelated spreadsheet.
   */
  it('extracts a zip containing a nested .skill next to unrelated files', () => {
    const stage = scratch();
    writeSkillTree(stage, 'sector-chip-rating');
    const innerArchive = join(stage, 'sector-chip-rating.skill');
    zipDir(stage, innerArchive, ['sector-chip-rating']);
    rmSync(join(stage, 'sector-chip-rating'), { recursive: true, force: true });
    writeFileSync(join(stage, 'holdings.xlsx'), 'not really a spreadsheet');

    const outerArchive = join(scratch(), 'INVESMENT-SKILL.zip');
    zipDir(stage, outerArchive, ['sector-chip-rating.skill', 'holdings.xlsx']);

    const result = extractSkillFromArchive(outerArchive);
    extracted.push(...result.tempDirs);

    expect(readFileSync(result.skillFilePath, 'utf-8')).toContain('name: Sector Chip Rating');
    expect(result.tempDirs.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts an archive whose SKILL.md sits at the root', () => {
    const stage = scratch();
    writeFileSync(join(stage, 'SKILL.md'), SKILL_BODY);
    const archive = join(scratch(), 'flat.zip');
    zipDir(stage, archive, ['SKILL.md']);

    const result = extractSkillFromArchive(archive);
    extracted.push(...result.tempDirs);
    expect(readFileSync(result.skillFilePath, 'utf-8')).toContain('Sector Chip Rating');
  });

  it('extracts a .tar.gz skill package', () => {
    const stage = scratch();
    writeSkillTree(stage, 'sector-chip-rating');
    const archive = join(scratch(), 'skill.tar.gz');
    execFileSync('tar', ['-czf', archive, 'sector-chip-rating'], { cwd: stage, stdio: 'pipe' });

    const result = extractSkillFromArchive(archive);
    extracted.push(...result.tempDirs);
    expect(readFileSync(result.skillFilePath, 'utf-8')).toContain('Sector Chip Rating');
  });

  it('rejects an archive with no SKILL.md and names the accepted shapes', () => {
    const stage = scratch();
    writeFileSync(join(stage, 'notes.txt'), 'nothing here');
    const archive = join(scratch(), 'empty.zip');
    zipDir(stage, archive, ['notes.txt']);

    expect(() => extractSkillFromArchive(archive)).toThrow(/No SKILL\.md found/);
  });

  it('refuses to guess when an archive holds two skills', () => {
    const stage = scratch();
    writeSkillTree(stage, 'skill-one');
    writeSkillTree(stage, 'skill-two');
    const archive = join(scratch(), 'two.zip');
    zipDir(stage, archive, ['skill-one', 'skill-two']);

    expect(() => extractSkillFromArchive(archive)).toThrow(/contains 2 skills/);
  });

  it('rejects a package whose symlink escapes the extracted tree', () => {
    const stage = scratch();
    const skillDir = writeSkillTree(stage, 'evil-skill');
    symlinkSync('/etc', join(skillDir, 'host-etc'));
    const archive = join(scratch(), 'evil.zip');
    zipDir(stage, archive, ['evil-skill']);

    expect(() => extractSkillFromArchive(archive)).toThrow(/symlink pointing outside/);
  });

  it('reports a missing archive instead of throwing a raw fs error', () => {
    expect(() => extractSkillFromArchive(join(scratch(), 'nope.zip'))).toThrow(/Skill archive not found/);
  });
});
