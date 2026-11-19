/**
 * Monitoring filter engine.
 *
 * A node (SVN revision / Git commit) is reviewed only when it passes every
 * configured filter:
 * - author whitelist: empty = all authors allowed
 * - path prefixes: empty = all paths allowed; otherwise at least one changed
 *   path must start with one of the prefixes (directory or file)
 *
 * When both are configured the semantics are AND (spec: 人员与路径过滤组合).
 */

export interface FilterInput {
  author: string;
  /** Changed paths of the node (repo-relative, e.g. trunk/src/a.cpp). */
  paths: string[];
}

export interface FilterRule {
  authorWhitelist: string[];
  pathPrefixes: string[];
}

export type FilterOutcome =
  | { matched: true }
  | { matched: false; reason: string };

/** Normalize a repo-relative path for prefix comparison.
 *  SVN log paths are repo-absolute ("/trunk/src/a.cpp"); strip the leading
 *  slash so they compare against user-entered prefixes ("trunk/src/"). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function evaluateFilters(rule: FilterRule, input: FilterInput): FilterOutcome {
  const whitelist = rule.authorWhitelist.map((a) => a.trim()).filter(Boolean);
  const prefixes = rule.pathPrefixes.map((p) => normalizePath(p.trim())).filter(Boolean);

  if (whitelist.length > 0) {
    const author = input.author.trim();
    if (!whitelist.includes(author)) {
      return {
        matched: false,
        reason: `作者 ${author || '(未知)'} 不在人员白名单 [${whitelist.join(', ')}] 中`,
      };
    }
  }

  if (prefixes.length > 0) {
    const paths = input.paths.map(normalizePath);
    const hit = paths.some((p) => prefixes.some((prefix) => p.startsWith(prefix)));
    if (!hit) {
      const shown = paths.slice(0, 5).join(', ') + (paths.length > 5 ? ' …' : '');
      return {
        matched: false,
        reason: `变更路径 [${shown || '(无)'}] 不在监控路径 [${prefixes.join(', ')}] 内`,
      };
    }
  }

  return { matched: true };
}
