import { appendFileSync, mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * In-memory ring buffer of runtime log lines, mirrored to a rotating file on
 * disk (`<dataDir>/logs/runtime-YYYY-MM-DD.log`). The web console reads the
 * buffer for the live view and the directory for downloads, so restarting the
 * service never loses history beyond the buffer size and file retention.
 *
 * Levels: debug < info < warn < error. Everything logs as JSON lines to the
 * file; the API returns them parsed so the UI can filter/colorize.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  /** ISO timestamp. */
  t: string;
  level: LogLevel;
  /** Short source tag: server / ocr / task / monitor / notify ... */
  src: string;
  msg: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** One day per file; keep a bounded number of old files. */
const RETAIN_FILES = 7;
/** Upper bound for a single day's file (guard against runaway output). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export class LogService {
  private buffer: LogLine[] = [];
  private readonly capacity: number;
  private minLevel: LogLevel = 'debug';
  private logDir: string | null;
  private today: string;
  private writtenToday = 0;

  constructor(
    /** Ring buffer size; defaults to 5000 lines. */
    capacity = 5000,
    /** When set, lines are also appended to a daily file under <dataDir>/logs. */
    dataDir?: string
  ) {
    this.capacity = capacity;
    this.logDir = dataDir ? join(dataDir, 'logs') : null;
    this.today = this.dateStamp();
    if (this.logDir) {
      try {
        mkdirSync(this.logDir, { recursive: true });
      } catch {
        this.logDir = null;
      }
    }
  }

  log(level: LogLevel, src: string, msg: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const line: LogLine = { t: new Date().toISOString(), level, src, msg };
    this.buffer.push(line);
    if (this.buffer.length > this.capacity) {
      // Trim in chunks to avoid re-slicing on every line.
      this.buffer = this.buffer.slice(-this.capacity);
    }
    this.appendToFile(line);
  }

  debug(src: string, msg: string): void {
    this.log('debug', src, msg);
  }
  info(src: string, msg: string): void {
    this.log('info', src, msg);
  }
  warn(src: string, msg: string): void {
    this.log('warn', src, msg);
  }
  error(src: string, msg: string): void {
    this.log('error', src, msg);
  }

  /**
   * Latest lines matching the filters. Returned oldest-first (natural reading
   * order); `limit` takes the most recent N before re-sorting.
   */
  recent(opts: { limit?: number; level?: LogLevel; src?: string; q?: string } = {}): {
    total: number;
    items: LogLine[];
  } {
    let items = this.buffer;
    if (opts.level) {
      const min = LEVEL_ORDER[opts.level];
      items = items.filter((l) => LEVEL_ORDER[l.level] >= min);
    }
    if (opts.src) items = items.filter((l) => l.src === opts.src);
    if (opts.q) {
      const q = opts.q.toLowerCase();
      items = items.filter((l) => l.msg.toLowerCase().includes(q));
    }
    const total = items.length;
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
    return { total, items: items.slice(-limit) };
  }

  /** Set the minimum level that enters the buffer/file. */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
    this.info('server', `日志级别调整为 ${level}`);
  }

  getLevel(): LogLevel {
    return this.minLevel;
  }

  /** List downloadable log files (daily), newest first. */
  files(): { name: string; size: number; modified: string }[] {
    if (!this.logDir || !existsSync(this.logDir)) return [];
    try {
      return readdirSync(this.logDir)
        .filter((f) => /^runtime-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .map((f) => {
          const full = join(this.logDir as string, f);
          const st = statSync(full);
          return { name: f, size: st.size, modified: st.mtime.toISOString() };
        })
        .sort((a, b) => b.name.localeCompare(a.name));
    } catch {
      return [];
    }
  }

  /** Absolute path of a log file, or null when the name is not a valid one. */
  filePath(name: string): string | null {
    if (!/^runtime-\d{4}-\d{2}-\d{2}\.log$/.test(name)) return null;
    if (!this.logDir) return null;
    const full = join(this.logDir, name);
    // The regex already pins the name shape; this stays a cheap sanity check.
    return existsSync(full) ? full : null;
  }

  private dateStamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  private appendToFile(line: LogLine): void {
    if (!this.logDir) return;
    try {
      const stamp = this.dateStamp();
      if (stamp !== this.today) {
        this.today = stamp;
        this.writtenToday = 0;
        this.rotateOld();
      }
      const path = join(this.logDir, `runtime-${stamp}.log`);
      if (this.writtenToday >= MAX_FILE_BYTES) return; // day capped; buffer still live
      appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8');
      this.writtenToday += Buffer.byteLength(`${JSON.stringify(line)}\n`);
    } catch {
      // File logging is best-effort; the ring buffer keeps working.
    }
  }

  private rotateOld(): void {
    if (!this.logDir) return;
    try {
      const files = this.files();
      for (const f of files.slice(RETAIN_FILES)) {
        const p = join(this.logDir, f.name);
        try {
          unlinkSync(p);
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort
    }
  }
}
