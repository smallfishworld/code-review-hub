import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type RepoType = 'svn' | 'git';

export const SCHEMA_VERSION = 13;

/**
 * Ordered, append-only list of migrations. Each entry runs once, tracked in
 * the `schema_migrations` table. Never edit an already-shipped migration.
 */
const MIGRATIONS: { version: number; name: string; up: (db: Database.Database) => void }[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      // Repos: SVN or Git remotes known to the platform.
      db.exec(`
        CREATE TABLE repo (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (type IN ('svn','git')),
          name TEXT NOT NULL UNIQUE,
          url TEXT NOT NULL,
          username TEXT,
          credential_id INTEGER REFERENCES credential(id),
          branch TEXT,               -- git only: monitored branch, e.g. main
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);

      // Encrypted credentials (blob = AES-256-GCM payload, see crypto/secrets).
      db.exec(`
        CREATE TABLE credential (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          label TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('svn','git','llm','smtp','chat','admin')),
          ciphertext BLOB NOT NULL,
          iv BLOB NOT NULL,
          auth_tag BLOB NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);

      // LLM provider config forwarded to the ocr CLI.
      db.exec(`
        CREATE TABLE provider (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          api_base TEXT NOT NULL,
          model TEXT NOT NULL,
          credential_id INTEGER REFERENCES credential(id),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);

      // Monitoring rules: one per repo (poll interval, author/path filters).
      db.exec(`
        CREATE TABLE monitor_rule (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id INTEGER NOT NULL UNIQUE REFERENCES repo(id) ON DELETE CASCADE,
          interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 30),
          author_whitelist TEXT NOT NULL DEFAULT '[]',  -- JSON array of names; empty = all
          path_prefixes TEXT NOT NULL DEFAULT '[]',     -- JSON array of path prefixes; empty = all
          backtrack_nodes INTEGER NOT NULL DEFAULT 0,   -- on first enable, review last N nodes
          enabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);

      // Per-rule polling state: last processed node (SVN revision number or
      // git commit sha) plus bookkeeping. Survives restarts.
      db.exec(`
        CREATE TABLE monitor_state (
          rule_id INTEGER PRIMARY KEY REFERENCES monitor_rule(id) ON DELETE CASCADE,
          last_node TEXT,             -- last processed revision/sha; NULL = not started
          last_poll_at TEXT,
          last_poll_error TEXT,
          init_status TEXT NOT NULL DEFAULT 'ready'
            CHECK (init_status IN ('ready','cloning','failed')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);

      // Review tasks. node = svn revision number or git commit sha.
      // repo_id is a soft reference: repos can be deleted while task
      // history is preserved (spec: deleting a repo keeps its reports).
      db.exec(`
        CREATE TABLE task (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id INTEGER NOT NULL,
          node TEXT NOT NULL,
          trigger TEXT NOT NULL CHECK (trigger IN ('manual','auto')),
          status TEXT NOT NULL DEFAULT 'queued'
            CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
          author TEXT,
          error TEXT,
          ocr_exit_code INTEGER,
          started_at TEXT,
          finished_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE (repo_id, node, trigger)
        );
        CREATE INDEX idx_task_status ON task(status);
        CREATE INDEX idx_task_repo_node ON task(repo_id, node);
      `);

      // Parsed report index; raw ocr JSON lives in data/reports/<task-id>.json.
      db.exec(`
        CREATE TABLE report (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL UNIQUE REFERENCES task(id),
          summary TEXT,
          issue_count INTEGER NOT NULL DEFAULT 0,
          raw_path TEXT NOT NULL,           -- path to the raw ocr JSON file
          parsed_ok INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);

      // Per-issue index extracted from reports for filtering/display.
      db.exec(`
        CREATE TABLE report_issue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          report_id INTEGER NOT NULL REFERENCES report(id) ON DELETE CASCADE,
          file TEXT,
          line INTEGER,
          severity TEXT,
          description TEXT NOT NULL
        );
        CREATE INDEX idx_issue_report ON report_issue(report_id);
      `);

      // Notification channels: email (SMTP) or chat webhook.
      db.exec(`
        CREATE TABLE notification_channel (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (type IN ('email','chat')),
          name TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 0,
          config TEXT NOT NULL DEFAULT '{}',  -- JSON, non-secret parts
          credential_id INTEGER REFERENCES credential(id),
          template TEXT,                      -- chat: message template
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);

      // Notification send log: success or final-failure per (task, channel).
      db.exec(`
        CREATE TABLE notification_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES task(id),
          channel_id INTEGER NOT NULL REFERENCES notification_channel(id),
          status TEXT NOT NULL CHECK (status IN ('sent','failed')),
          detail TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX idx_notif_log_task ON notification_log(task_id);
      `);

      // Global notification trigger rule: all | failed_only | success_only.
      db.exec(`
        CREATE TABLE setting (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO setting (key, value) VALUES ('notification_trigger', 'all');
      `);

      // Admin password (bcrypt hash).
      db.exec(`
        INSERT INTO setting (key, value) VALUES ('admin_password', '');
      `);
    },
  },
  {
    version: 2,
    name: 'monitor-log',
    up: (db) => {
      // Per-node monitoring decisions: triggered or skipped (with reason).
      // Powers the monitor status panel ("最近触发/跳过记录").
      db.exec(`
        CREATE TABLE monitor_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id INTEGER NOT NULL REFERENCES monitor_rule(id) ON DELETE CASCADE,
          node TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('triggered','skipped')),
          reason TEXT,
          author TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX idx_monitor_log_rule ON monitor_log(rule_id, id DESC);
      `);
    },
  },
  {
    version: 3,
    name: 'provider-protocol',
    up: (db) => {
      // LLM wire protocol used when forwarding this provider to ocr
      // (anthropic | anthropic-bedrock | openai | openai-responses).
      db.exec(`
        ALTER TABLE provider ADD COLUMN protocol TEXT NOT NULL DEFAULT 'anthropic';
      `);
    },
  },
  {
    version: 4,
    name: 'report-issue-suggestion',
    up: (db) => {
      // ocr comments carry an optional `suggestion_code`; the console's report
      // detail shows it next to the problem description.
      db.exec(`
        ALTER TABLE report_issue ADD COLUMN suggestion TEXT;
      `);
    },
  },
  {
    version: 5,
    name: 'monitor-head-node',
    up: (db) => {
      // Latest node seen on the remote at the last poll (SVN HEAD revision or
      // git branch head sha). The console's monitor panel shows it as
      // "最新节点" next to the processed position.
      db.exec(`
        ALTER TABLE monitor_state ADD COLUMN head_node TEXT;
      `);
    },
  },
  {
    version: 6,
    name: 'task-retrigger-after-cancel',
    up: (db) => {
      // The old UNIQUE (repo_id, node, trigger) made a cancelled task
      // permanently block re-triggering the same node: the INSERT hit the
      // constraint and the queue returned the stale cancelled row instead.
      // Terminal states (succeeded/failed/cancelled) must be history, not
      // locks. Rebuild the table without the hard UNIQUE and enforce "at most
      // one active task per (repo,node,trigger)" with a partial unique index
      // over queued/running rows only. SQLite cannot drop a table constraint,
      // so this is the canonical create-copy-drop-rename rebuild.
      db.exec(`
        CREATE TABLE task_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id INTEGER NOT NULL,
          node TEXT NOT NULL,
          trigger TEXT NOT NULL CHECK (trigger IN ('manual','auto')),
          status TEXT NOT NULL DEFAULT 'queued'
            CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
          author TEXT,
          error TEXT,
          ocr_exit_code INTEGER,
          started_at TEXT,
          finished_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO task_new (id, repo_id, node, trigger, status, author, error,
                              ocr_exit_code, started_at, finished_at, created_at)
          SELECT id, repo_id, node, trigger, status, author, error,
                 ocr_exit_code, started_at, finished_at, created_at FROM task;
        DROP TABLE task;
        ALTER TABLE task_new RENAME TO task;
        CREATE INDEX idx_task_status ON task(status);
        CREATE INDEX idx_task_repo_node ON task(repo_id, node);
        CREATE UNIQUE INDEX idx_task_active ON task(repo_id, node, trigger)
          WHERE status IN ('queued','running');
      `);
    },
  },
  {
    version: 7,
    name: 'repo-init-status',
    up: (db) => {
      // Workspace prewarm bookkeeping: the platform downloads the repo (SVN
      // checkout / git clone) right after the repo is saved instead of
      // lazily on the first review, so the console can show an
      // "initializing" state and the first review does not absorb the whole
      // download. Existing repos default to 'ready' (they may already have
      // a workspace; the prewarm pass treats 'ready' with no workspace as
      // needing init anyway).
      db.exec(`
        ALTER TABLE repo ADD COLUMN init_status TEXT NOT NULL DEFAULT 'ready'
          CHECK (init_status IN ('pending','preparing','ready','failed'));
        ALTER TABLE repo ADD COLUMN init_error TEXT;
        ALTER TABLE repo ADD COLUMN init_updated_at TEXT;
      `);
    },
  },
  {
    version: 8,
    name: 'report-issue-category',
    up: (db) => {
      db.exec(`
        ALTER TABLE report_issue ADD COLUMN category TEXT;
      `);
    },
  },
  {
    version: 9,
    name: 'engines-mcp-memory',
    up: (db) => {
      addEngineTables(db);
      addMcpTables(db);
      addMemoryTables(db);
      addIssueColumns(db);
    },
  },
  {
    version: 10,
    name: 'review-task-provenance',
    up: (db) => {
      db.exec(`
        ALTER TABLE repo ADD COLUMN source_version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE task ADD COLUMN source_version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE task ADD COLUMN monitor_rule_id INTEGER;
        ALTER TABLE task ADD COLUMN engine_selection_error TEXT;
        ALTER TABLE task ADD COLUMN pending_report TEXT;
        DROP INDEX idx_task_active;
        DROP INDEX idx_task_repo_node;
        CREATE INDEX idx_task_repo_node ON task(repo_id, source_version, node);
        CREATE UNIQUE INDEX idx_task_active ON task(repo_id, source_version, node, trigger)
          WHERE status IN ('queued','running');
      `);
    },
  },
  {
    version: 11,
    name: 'repository-review-settings',
    up: (db) => {
      db.exec(`
        ALTER TABLE repo ADD COLUMN review_concurrency INTEGER NOT NULL DEFAULT 2
          CHECK (review_concurrency >= 1 AND typeof(review_concurrency) = 'integer');
      `);
    },
  },
  {
    version: 12,
    name: 'repo-provider-pool',
    up: (db) => {
      // A repo binds a POOL of LLM providers (concurrent reviews spread
      // across models). Position preserves the operator's ordering; the first
      // member is the primary/preferred model.
      db.exec(`
        CREATE TABLE repo_provider (
          repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
          provider_id INTEGER NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
          position INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (repo_id, provider_id)
        );
        CREATE INDEX idx_repo_provider_repo ON repo_provider(repo_id, position);
      `);
      // (No legacy single-provider column exists: pre-release, the pool in
      // repo_provider is the only repo-level model binding.)
      // Each task records the model it actually ran with, so the assignment
      // survives restarts/retries and reports show which model produced them.
      // provider_label snapshots "name · model" at enqueue time: providers can
      // be renamed or deleted afterwards, and history must stay readable.
      db.exec(`
        ALTER TABLE task ADD COLUMN provider_id INTEGER REFERENCES provider(id) ON DELETE SET NULL;
        ALTER TABLE task ADD COLUMN provider_label TEXT;
      `);
    },
  },
  {
    version: 13,
    name: 'review-feedback-wont-fix',
    up: (db) => {
      db.exec(`
        ALTER TABLE review_feedback RENAME TO review_feedback_old;
        CREATE TABLE review_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
          issue_id INTEGER NOT NULL REFERENCES report_issue(id) ON DELETE CASCADE,
          verdict TEXT NOT NULL CHECK (verdict IN ('false_positive','fixed','valid','wont_fix')),
          memory_id INTEGER REFERENCES memory_entry(id) ON DELETE SET NULL,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE (issue_id, verdict)
        );
        INSERT INTO review_feedback (id, task_id, issue_id, verdict, memory_id, note, created_at)
          SELECT id, task_id, issue_id, verdict, memory_id, note, created_at FROM review_feedback_old;
        DROP TABLE review_feedback_old;
        CREATE INDEX idx_review_feedback_task ON review_feedback(task_id);
      `);
    },
  },
];

export class DatabaseError extends Error {}

export interface DbOptions {
  /** Directory that will contain the SQLite file. Created if missing. */
  dataDir: string;
  /** File name inside dataDir. */
  fileName?: string;
  /** Skip the built-in migration runner (tests only). */
  skipMigrations?: boolean;
}

/**
 * Open (and migrate) the platform database.
 *
 * Migrations run inside a transaction; applied versions are recorded in
 * schema_migrations so restarts are idempotent and data persists.
 */
export function openDatabase(opts: DbOptions): Database.Database {
  mkdirSync(opts.dataDir, { recursive: true });
  const db = new Database(join(opts.dataDir, opts.fileName ?? 'platform.db'));

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  if (opts.skipMigrations) return db;

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version
    )
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
        m.version,
        m.name
      );
    });
    tx();
  }

  const current = db.pragma('user_version', { simple: true }) as number;
  if (current !== SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  return db;
}

/** Names of all tables created by migrations (for tests). */
export function listTables(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map((r) => r.name).sort();
}

/** Run one static DDL statement (single-statement, no interpolation). */
function runDdl(db: Database.Database, sql: string): void {
  db.prepare(sql).run();
}

/** v9: pluggable engine registry + engine selection columns. */
function addEngineTables(db: Database.Database): void {
  const createEngine = `
    CREATE TABLE engine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('ocr','claude-code','codex','custom-http','custom-script')),
      config TEXT NOT NULL DEFAULT '{}',
      credential_id INTEGER REFERENCES credential(id),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`;
  runDdl(db, createEngine);
  runDdl(db, 'ALTER TABLE task ADD COLUMN engine_id INTEGER REFERENCES engine(id)');
  runDdl(db, 'ALTER TABLE report ADD COLUMN engine TEXT');
  runDdl(db, 'ALTER TABLE repo ADD COLUMN engine_id INTEGER REFERENCES engine(id)');
  runDdl(db, 'ALTER TABLE monitor_rule ADD COLUMN engine_id INTEGER REFERENCES engine(id)');
}

/** v9: MCP server registry + per-task injection audit. */
function addMcpTables(db: Database.Database): void {
  const createMcpServer = `
    CREATE TABLE mcp_server (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      transport TEXT NOT NULL CHECK (transport IN ('stdio','http')),
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','repo')),
      repo_id INTEGER REFERENCES repo(id) ON DELETE CASCADE,
      tool_allowlist TEXT,
      timeout_sec INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK ((scope = 'global' AND repo_id IS NULL) OR (scope = 'repo' AND repo_id IS NOT NULL))
    )`;
  runDdl(db, createMcpServer);
  const createInjectionAudit = `
    CREATE TABLE task_mcp_injection (
      task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
      server_id INTEGER NOT NULL REFERENCES mcp_server(id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      allowlist_enforced INTEGER NOT NULL DEFAULT 0,
      tool_stats TEXT,
      PRIMARY KEY (task_id, server_id)
    )`;
  runDdl(db, createInjectionAudit);
}

/** v9: project memory tables (entry + FTS + injection audit + feedback). */
function addMemoryTables(db: Database.Database): void {
  const createMemoryEntry = `
    CREATE TABLE memory_entry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('architecture','convention','pitfall','suppression','history','glossary')),
      scope TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      fingerprint TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      hits INTEGER NOT NULL DEFAULT 0,
      feedback_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','rejected')),
      source_task_id INTEGER REFERENCES task(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_used_at TEXT
    )`;
  runDdl(db, createMemoryEntry);
  runDdl(db, 'CREATE INDEX idx_memory_repo_kind ON memory_entry(repo_id, kind, status)');
  runDdl(db, 'CREATE INDEX idx_memory_fingerprint ON memory_entry(repo_id, fingerprint)');

  // FTS5 + trigram: the default unicode61 tokenizer makes Chinese body text
  // (reports are forced Chinese) unsearchable. Probe module + tokenizer and
  // record availability in `setting`; LIKE fallback when unavailable.
  let ftsOk = false;
  try {
    runDdl(db, 'CREATE VIRTUAL TABLE temp.fts_probe USING fts5(x)');
    runDdl(db, 'DROP TABLE temp.fts_probe');
    runDdl(db, "CREATE VIRTUAL TABLE temp.fts_probe_tri USING fts5(x, tokenize='trigram')");
    runDdl(db, 'DROP TABLE temp.fts_probe_tri');
    ftsOk = true;
  } catch {
    // FTS5 or trigram unavailable: LIKE fallback (recorded below)
  }
  db.prepare(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('memory_fts_available', ftsOk ? '1' : '0');
  if (ftsOk) {
    runDdl(
      db,
      `CREATE VIRTUAL TABLE memory_fts USING fts5(
        title, body, content='memory_entry', content_rowid='id', tokenize='trigram'
      )`
    );
    runDdl(
      db,
      `CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory_entry BEGIN
        INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END`
    );
    runDdl(
      db,
      `CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory_entry BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, body)
          VALUES ('delete', old.id, old.title, old.body);
      END`
    );
    runDdl(
      db,
      `CREATE TRIGGER memory_fts_au AFTER UPDATE ON memory_entry BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, body)
          VALUES ('delete', old.id, old.title, old.body);
        INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END`
    );
  }

  const createInjection = `
    CREATE TABLE memory_injection (
      task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
      memory_id INTEGER NOT NULL REFERENCES memory_entry(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, memory_id)
    )`;
  runDdl(db, createInjection);
  const createFeedback = `
    CREATE TABLE review_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
      issue_id INTEGER NOT NULL REFERENCES report_issue(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL CHECK (verdict IN ('false_positive','fixed','valid')),
      memory_id INTEGER REFERENCES memory_entry(id) ON DELETE SET NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (issue_id, verdict)
    )`;
  runDdl(db, createFeedback);
}

/** v9: issue range lines + deterministic suppression markers. */
function addIssueColumns(db: Database.Database): void {
  runDdl(db, 'ALTER TABLE report_issue ADD COLUMN end_line INTEGER');
  runDdl(db, 'ALTER TABLE report_issue ADD COLUMN suppressed INTEGER NOT NULL DEFAULT 0');
  runDdl(
    db,
    'ALTER TABLE report_issue ADD COLUMN suppressed_by INTEGER REFERENCES memory_entry(id) ON DELETE SET NULL'
  );
}
