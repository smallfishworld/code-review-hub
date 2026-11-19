import { describe, it, expect } from 'vitest';
import { which } from './which.js';
import {
  probeDependency,
  DEPENDENCY_SPECS,
  parseVersion,
  compareVersions,
} from './detector.js';

describe('which()', () => {
  it('finds a real command (node) on PATH', async () => {
    const resolved = await which(process.execPath);
    expect(resolved).toBeTruthy();
  });

  it('finds npm-installed .cmd shim on Windows by bare name', async () => {
    const resolved = await which('npm');
    expect(resolved).toBeTruthy();
  });

  it('returns null for a nonexistent command', async () => {
    expect(await which('definitely-not-a-command-xyz')).toBeNull();
  });

  it('searches a custom PATH-like string', async () => {
    // empty path -> nothing found
    expect(await which('node', '')).toBeNull();
  });
});

describe('probeDependency()', () => {
  it('probes an existing executable and reports version', async () => {
    const r = await probeDependency('git', DEPENDENCY_SPECS.git.conditional);
    if (r.found && r.executable) {
      expect(r.version).toMatch(/git/i);
    } else {
      // git may be absent on some CI machines; found flag must be consistent
      expect(r.found).toBe(false);
      expect(r.error).toBeTruthy();
    }
  });

  it('reports missing command as not found', async () => {
    const r = await probeDependency('definitely-not-a-command-xyz', false);
    expect(r.found).toBe(false);
    expect(r.executable).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  it('flags a version below the required minimum', async () => {
    // `node --version` prints "v24.14.0"; require an impossible 99.0.
    const r = await probeDependency('node', false, 10_000, '99.0');
    expect(r.found).toBe(true);
    expect(r.executable).toBe(false);
    expect(r.error).toMatch(/版本过低/);
    expect(r.error).toContain('99.0');
  });

  it('accepts a version at or above the minimum', async () => {
    const r = await probeDependency('node', false, 10_000, '10.0');
    expect(r.found).toBe(true);
    expect(r.executable).toBe(true);
  });
});

describe('version helpers', () => {
  it('parses dotted versions out of arbitrary lines', () => {
    expect(parseVersion('svn, version 1.14.5 (r1922182)')).toEqual([1, 14, 5]);
    expect(parseVersion('git version 2.55.0.windows.5')).toEqual([2, 55, 0]);
    expect(parseVersion('v24.14.0')).toEqual([24, 14, 0]);
    expect(parseVersion('no digits here')).toBeNull();
  });

  it('compares versions numerically', () => {
    expect(compareVersions([1, 9, 0], [1, 14, 0])).toBeLessThan(0);
    expect(compareVersions([1, 14, 5], [1, 9])).toBeGreaterThan(0);
    expect(compareVersions([2, 0], [2, 0, 0])).toBe(0);
  });

  it('declares the SVN minimum required by ocr workspace mode', () => {
    expect(DEPENDENCY_SPECS.svn.minVersion).toBe('1.9');
    expect(DEPENDENCY_SPECS.svn.note).toMatch(/1\.9/);
  });
});
