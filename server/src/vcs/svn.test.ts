import { describe, it, expect } from 'vitest';
import {
  parseXml,
  parseSvnInfoXml,
  parseSvnLogXml,
  decodeXmlEntities,
  svnLog,
  svnLogPage,
} from './svn.js';

const INFO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry kind="dir" path="." revision="1234">
  <url>http://svn.example.com/repo/trunk</url>
  <repository>
    <root>http://svn.example.com/repo</root>
    <uuid>abc-uuid</uuid>
  </repository>
  <commit revision="1234">
    <author>zhangsan</author>
  </commit>
</entry>
</info>`;

const LOG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry revision="1002">
  <author>wangwu</author>
  <date>2026-11-15T10:00:00.000Z</date>
  <paths>
    <path action="M" kind="file">/trunk/src/core/engine.cpp</path>
    <path action="A" kind="file">/trunk/docs/&#35835;&#25991;&#20214;.md</path>
    <path action="D" kind="file">/trunk/old.txt</path>
  </paths>
  <msg>&#20462;&#22797;bug &amp; &#20248;&#21270;&lt;&#24615;&#33021;&gt;</msg>
</logentry>
<logentry revision="1003">
  <author>zhangsan</author>
  <date>2026-11-16T08:30:00.000Z</date>
  <paths>
    <path action="M">/trunk/src/main.c</path>
  </paths>
  <msg>update main</msg>
</logentry>
</log>`;

describe('decodeXmlEntities', () => {
  it('decodes the five standard entities', () => {
    expect(decodeXmlEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'');
  });
  it('decodes numeric entities (decimal and hex)', () => {
    expect(decodeXmlEntities('&#20013;&#x6587;')).toBe('中文');
  });
  it('leaves unknown entities untouched', () => {
    expect(decodeXmlEntities('&nbsp;')).toBe('&nbsp;');
  });
});

describe('parseXml', () => {
  it('parses nested elements with attributes and text', () => {
    const node = parseXml('<a x="1"><b>hello</b><c y="2"/></a>');
    expect(node.tag).toBe('a');
    expect(node.attrs.x).toBe('1');
    expect(node.children[0].text).toBe('hello');
    expect(node.children[1].tag).toBe('c');
    expect(node.children[1].attrs.y).toBe('2');
  });
});

describe('parseSvnInfoXml', () => {
  it('extracts url, repository root, and revision', () => {
    const info = parseSvnInfoXml(INFO_XML);
    expect(info.url).toBe('http://svn.example.com/repo/trunk');
    expect(info.repositoryRoot).toBe('http://svn.example.com/repo');
    expect(info.revision).toBe(1234);
  });
  it('throws a helpful error for malformed xml', () => {
    expect(() => parseSvnInfoXml('<notinfo/>')).toThrow(/svn info XML/);
  });
});

describe('parseSvnLogXml', () => {
  const entries = parseSvnLogXml(LOG_XML);

  it('parses entries in document order', () => {
    expect(entries.map((e) => e.revision)).toEqual([1002, 1003]);
  });
  it('parses authors and dates', () => {
    expect(entries[0].author).toBe('wangwu');
    expect(entries[1].author).toBe('zhangsan');
    expect(entries[0].date).toBe('2026-11-15T10:00:00.000Z');
  });
  it('parses changed paths with actions', () => {
    expect(entries[0].paths).toEqual([
      { path: '/trunk/src/core/engine.cpp', action: 'M' },
      { path: '/trunk/docs/读文件.md', action: 'A' },
      { path: '/trunk/old.txt', action: 'D' },
    ]);
  });
  it('decodes entities in commit messages (Chinese + & + <>)', () => {
    expect(entries[0].message).toBe('修复bug & 优化<性能>');
  });
  it('handles multi-line messages', () => {
    const xml = `<log><logentry revision="1"><author>a</author><date>2026-01-01T00:00:00.000Z</date><msg>line1
line2</msg></logentry></log>`;
    expect(parseSvnLogXml(xml)[0].message).toBe('line1\nline2');
  });
  it('returns empty for empty log', () => {
    expect(parseSvnLogXml('<log/>')).toEqual([]);
  });
});

describe('svnLog', () => {
  it('passes --limit through so a subdirectory URL yields its own recent commits', { timeout: 60_000 }, async () => {
      // Real local repo: 4 commits touching subdir/, 30 more touching root.
      // A HEAD-derived window alone would return few subdir entries; with
      // --limit the path's own commits all come back.
      const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { execFileSync } = await import('node:child_process');
      const dir = mkdtempSync(join(tmpdir(), 'crp-svnlog-'));
      try {
        const repoDir = join(dir, 'repo');
        const wc = join(dir, 'wc');
        execFileSync('svnadmin', ['create', repoDir]);
        execFileSync('svn', ['checkout', '-q', `file:///${repoDir.replace(/\\/g, '/')}`, wc]);
        mkdirSync(join(wc, 'sub'), { recursive: true });
        writeFileSync(join(wc, 'root.txt'), 'root');
        execFileSync('svn', ['add', '-q', 'root.txt', 'sub'], { cwd: wc });
        execFileSync('svn', ['commit', '-q', '-m', 'r1 init'], { cwd: wc });
        for (let i = 0; i < 4; i++) {
          writeFileSync(join(wc, 'sub', `f${i}.txt`), `content ${i}`);
          execFileSync('svn', ['add', '-q', `sub/f${i}.txt`], { cwd: wc });
          execFileSync('svn', ['commit', '-q', '-m', `sub commit ${i}`], { cwd: wc });
        }
        for (let i = 0; i < 30; i++) {
          writeFileSync(join(wc, `root${i}.txt`), `content ${i}`);
          execFileSync('svn', ['add', '-q', `root${i}.txt`], { cwd: wc });
          execFileSync('svn', ['commit', '-q', '-m', `root commit ${i}`], { cwd: wc });
        }

        const subUrl = `file:///${repoDir.replace(/\\/g, '/')}/sub`;
        const entries = await svnLog(subUrl, 1, 'HEAD', {}, { limit: 50 });
        expect(entries.length).toBe(5); // r1 + 4 sub commits, despite HEAD being r35
        expect(entries[0].message).toBe('r1 init');
        expect(entries.at(-1)?.message).toBe('sub commit 3');
        expect(entries.every((e) => e.paths.some((p) => p.path.includes('/sub')))).toBe(true);
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Windows svn file-handle lag; best-effort cleanup
        }
      }
    }
  );

  it('svnLogPage pages newest-first with an inclusive descending cursor', { timeout: 60_000 }, async () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'crp-svnpage-'));
    try {
      const repoDir = join(dir, 'repo');
      const wc = join(dir, 'wc');
      execFileSync('svnadmin', ['create', repoDir]);
      execFileSync('svn', ['checkout', '-q', `file:///${repoDir.replace(/\\/g, '/')}`, wc]);
      mkdirSync(join(wc, 'sub'), { recursive: true });
      writeFileSync(join(wc, 'root.txt'), 'root');
      execFileSync('svn', ['add', '-q', 'root.txt', 'sub'], { cwd: wc });
      execFileSync('svn', ['commit', '-q', '-m', 'r1 init'], { cwd: wc });
      for (let i = 1; i <= 6; i++) {
        writeFileSync(join(wc, 'sub', `f${i}.txt`), `content ${i}`);
        execFileSync('svn', ['add', '-q', `sub/f${i}.txt`], { cwd: wc });
        execFileSync('svn', ['commit', '-q', '-m', `sub commit ${i}`], { cwd: wc });
      }
      for (let i = 1; i <= 20; i++) {
        writeFileSync(join(wc, `root${i}.txt`), `content ${i}`);
        execFileSync('svn', ['add', '-q', `root${i}.txt`], { cwd: wc });
        execFileSync('svn', ['commit', '-q', '-m', `root commit ${i}`], { cwd: wc });
      }

      const subUrl = `file:///${repoDir.replace(/\\/g, '/')}/sub`;
      // Page 1 from HEAD: the path's own 4 most recent commits, newest-first.
      const p1 = await svnLogPage(subUrl, 'HEAD', {}, { limit: 4 });
      expect(p1.map((e) => e.message)).toEqual(['sub commit 6', 'sub commit 5', 'sub commit 4', 'sub commit 3']);
      // Page 2 continues from (oldest shown - 1) with no repeats.
      const p2 = await svnLogPage(subUrl, p1.at(-1)!.revision - 1, {}, { limit: 4 });
      expect(p2.map((e) => e.message)).toEqual(['sub commit 2', 'sub commit 1', 'r1 init']);
      // svn quirk: `-r 0:1` still yields r1 (the 0:1 range is not empty), so
      // the caller (repoService.listNodes) stops issuing cursors at 0 — it
      // returns nextCursor=undefined once the oldest-shown revision is 1.
      const p3 = await svnLogPage(subUrl, p2.at(-1)!.revision - 1, {}, { limit: 4 });
      expect(p3.map((e) => e.message)).toEqual(['r1 init']);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows svn file-handle lag; best-effort cleanup
      }
    }
  });
});
