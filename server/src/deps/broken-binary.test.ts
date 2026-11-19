import { describe, it, expect, beforeAll } from 'vitest';
import { chmodSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeDependency } from './detector.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-dep-'));
  // An existing but non-executable file named like a command, on PATH.
  const fixture = join(dir, 'non-executable-fixture');
  writeFileSync(fixture, 'not a binary');
  chmodSync(fixture, 0o644); // no execute bit (POSIX)
  const sep = process.platform === 'win32' ? ';' : ':';
  process.env.PATH = dir + sep + (process.env.PATH ?? '');
});

describe('probeDependency broken-binary case', () => {
  it('finds the file but reports not executable', async () => {
    const r = await probeDependency('non-executable-fixture', true);
    expect(r.found).toBe(true);
    expect(r.executable).toBe(false);
    expect(r.error).toBeTruthy();
  }, 30_000);
});

describe('probeDependency missing command', () => {
  it('reports a nonexistent command as not found', async () => {
    const r = await probeDependency('definitely-not-a-command-xyz', false);
    expect(r.found).toBe(false);
    expect(r.executable).toBe(false);
    expect(r.error).toMatch(/not found/i);
  }, 30_000);
});
