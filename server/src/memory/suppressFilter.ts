import type Database from 'better-sqlite3';

/**
 * Deterministic suppression (project-memory spec / design D6 suppressFilter).
 *
 * After normalization and BEFORE report rows are inserted, issues are
 * matched against the repo's active suppression entries by fingerprint.
 * Hits are marked (suppressed=1 + suppressed_by) — never deleted — so the
 * report detail can audit them. This runs regardless of whether the review
 * engine obeyed the injected suppression hints.
 */

export interface SuppressibleIssue {
  file?: string | null;
  category?: string | null;
  description?: string | null;
}

export interface SuppressionRow {
  id: number;
  scope: string | null;
  fingerprint: string | null;
  status: string;
}

/**
 * Issue fingerprint: normalized (file prefix + category + description) hash.
 * Normalization strips line numbers / whitespace / case so the same pattern
 * reported at different lines aggregates into one suppression entry.
 */
export function issueFingerprint(issue: SuppressibleIssue): string | null {
  const file = (issue.file ?? '').replace(/\\/g, '/').trim();
  if (!file) return null;
  const category = (issue.category ?? '').trim().toLowerCase();
  const desc = (issue.description ?? '')
    .replace(/line\s*\d+/gi, '')
    .replace(/第\s*\d+\s*行/g, '')
    .replace(/:\d+(-\d+)?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 400);
  return hash(file + '|' + category + '|' + desc);
}

/** Stable non-crypto hash (FNV-1a) — dedup key, not a security boundary. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function hash(text: string): string {
  return fnv1a(text);
}

/**
 * Apply suppression to normalized issues. Returns the per-issue matched
 * suppression entry id (null = not suppressed). Caller persists the marker.
 */
export function matchSuppressions(
  db: Database.Database,
  repoId: number,
  issues: SuppressibleIssue[]
): (number | null)[] {
  const rows = db
    .prepare(
      `SELECT id, scope, fingerprint, status FROM memory_entry
       WHERE repo_id = ? AND kind = 'suppression' AND status = 'active' AND fingerprint IS NOT NULL`
    )
    .all(repoId) as unknown as SuppressionRow[];
  const entries: SuppressionRow[] = rows;

  return issues.map((issue) => {
    const fp = issueFingerprint(issue);
    if (!fp) return null;
    const hit = entries.find((s) => {
      if (s.fingerprint !== fp) return false;
      if (!s.scope) return true;
      const file = (issue.file ?? '').replace(/\\/g, '/');
      return file.startsWith(s.scope);
    });
    return hit ? hit.id : null;
  });
}
