import { describe, it, expect } from 'vitest';
import { evaluateFilters } from './filters.js';

const none = { authorWhitelist: [], pathPrefixes: [] };

describe('evaluateFilters', () => {
  it('matches everything when no filters configured', () => {
    expect(evaluateFilters(none, { author: 'anyone', paths: ['a.txt'] })).toEqual({ matched: true });
    expect(evaluateFilters(none, { author: '', paths: [] })).toEqual({ matched: true });
  });

  it('author whitelist: hit and miss', () => {
    const rule = { authorWhitelist: ['zhangsan', 'lisi'], pathPrefixes: [] };
    expect(evaluateFilters(rule, { author: 'zhangsan', paths: [] }).matched).toBe(true);
    const miss = evaluateFilters(rule, { author: 'wangwu', paths: [] });
    expect(miss.matched).toBe(false);
    if (!miss.matched) expect(miss.reason).toContain('wangwu');
  });

  it('path prefixes: directory prefix hit and miss', () => {
    const rule = { authorWhitelist: [], pathPrefixes: ['trunk/src/core/'] };
    expect(
      evaluateFilters(rule, { author: 'x', paths: ['trunk/src/core/engine.cpp'] }).matched
    ).toBe(true);
    const miss = evaluateFilters(rule, { author: 'x', paths: ['docs/readme.md'] });
    expect(miss.matched).toBe(false);
    if (!miss.matched) expect(miss.reason).toContain('docs/readme.md');
  });

  it('path prefix matches an exact file path too', () => {
    const rule = { authorWhitelist: [], pathPrefixes: ['trunk/README.md'] };
    expect(evaluateFilters(rule, { author: 'x', paths: ['trunk/README.md'] }).matched).toBe(true);
    expect(evaluateFilters(rule, { author: 'x', paths: ['trunk/README.md.bak'] }).matched).toBe(
      true
    ); // documented prefix semantics
  });

  it('AND semantics: both author and path must pass', () => {
    const rule = { authorWhitelist: ['zhangsan'], pathPrefixes: ['trunk/src/core/'] };
    expect(
      evaluateFilters(rule, { author: 'zhangsan', paths: ['trunk/src/core/a.cpp'] }).matched
    ).toBe(true);
    expect(evaluateFilters(rule, { author: 'wangwu', paths: ['trunk/src/core/a.cpp'] }).matched).toBe(
      false
    );
    expect(evaluateFilters(rule, { author: 'zhangsan', paths: ['docs/x.md'] }).matched).toBe(false);
  });

  it('normalizes backslashes and ./ prefixes', () => {
    const rule = { authorWhitelist: [], pathPrefixes: ['trunk/src/'] };
    expect(
      evaluateFilters(rule, { author: 'x', paths: ['.\\trunk\\src\\a.cpp'] }).matched
    ).toBe(true);
  });

  it('ignores blank entries in filter lists', () => {
    const rule = { authorWhitelist: ['  '], pathPrefixes: [''] };
    expect(evaluateFilters(rule, { author: 'anyone', paths: ['x'] }).matched).toBe(true);
  });

  it('git-style paths (no trunk prefix) work with matching prefixes', () => {
    const rule = { authorWhitelist: [], pathPrefixes: ['src/core/'] };
    expect(evaluateFilters(rule, { author: 'x', paths: ['src/core/engine.cpp'] }).matched).toBe(
      true
    );
  });
});
