import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type LogFile, type LogLine, type LogLevel } from '../api/client';
import { errorText, usePageTitle } from '../api/hooks';

const LEVELS: { value: LogLevel | ''; label: string }[] = [
  { value: '', label: '全部级别' },
  { value: 'debug', label: 'DEBUG 及以上' },
  { value: 'info', label: 'INFO 及以上' },
  { value: 'warn', label: 'WARN 及以上' },
  { value: 'error', label: '仅 ERROR' },
];

const SOURCES = ['', 'server', 'task', 'ocr', 'monitor', 'notify'];

const POLL_MS = 3000;
const PAGE = 500;

/**
 * Runtime log viewer: polls the server's ring buffer, auto-scrolls to the
 * newest line while the user is at the bottom, and offers daily-file
 * downloads for full history.
 */
export function LogsPage() {
  usePageTitle('运行日志');
  const [lines, setLines] = useState<LogLine[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [level, setLevel] = useState<LogLevel | ''>('');
  const [src, setSrc] = useState('');
  const [q, setQ] = useState('');
  const [pausedQ, setPausedQ] = useState(''); // query applied while paused
  const [files, setFiles] = useState<LogFile[]>([]);
  const [follow, setFollow] = useState(true);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Latest filters for the polling interval without resetting it on change.
  // Written from an effect (not render) to keep render pure.
  const filtersRef = useRef({ level, src, q });
  useEffect(() => {
    filtersRef.current = { level, src, q };
  }, [level, src, q]);

  const fetchOnce = useCallback(async () => {
    const f = filtersRef.current;
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (f.level) params.set('level', f.level);
    if (f.src) params.set('src', f.src);
    if (f.q.trim()) params.set('q', f.q.trim());
    try {
      const res = await api.get<{ total: number; items: LogLine[] }>(`/api/logs?${params}`);
      setLines(res.items);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  // Poll while "live"; a paused view is a frozen snapshot (search applies to
  // the frozen buffer, which is what an operator wants when copying an error).
  // The first fetch fires immediately (no waiting one interval), then polling.
  // (Data fetching in an effect is a legitimate external-system sync; the
  // state writes all happen after await, never synchronously.)
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- async fetch, setState lands after await
    void fetchOnce();
    if (!live) return;
    const timer = setInterval(() => void fetchOnce(), POLL_MS);
    return () => clearInterval(timer);
  }, [live, fetchOnce]);

  // File list only changes when a day rolls over; refresh alongside polling.
  useEffect(() => {
    const load = () =>
      api
        .get<{ files: LogFile[] }>('/api/logs/files')
        .then((r) => setFiles(r.files))
        .catch(() => {});
    void load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, []);

  // Auto-follow: stick to the bottom on new lines unless the user scrolled up.
  useEffect(() => {
    if (!follow) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lines, follow]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    // "At the bottom" with a small tolerance; scrolling up disengages follow.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(atBottom);
  };

  const pauseLive = () => {
    setPausedQ(q);
    setLive(false);
  };
  const resumeLive = () => {
    setLevel('');
    setSrc('');
    setQ('');
    setLive(true);
  };

  const effectiveQ = live ? q : pausedQ;
  const filtered = effectiveQ.trim()
    ? lines.filter((l) => l.msg.toLowerCase().includes(effectiveQ.trim().toLowerCase()))
    : lines;

  return (
    <div className="logs-page">
      <div className="page-head">
        <div className="page-title-group">
          <h1>运行日志</h1>
          <p className="page-subtitle">实时追踪平台服务、监控轮询、评审引擎与通知投递日志</p>
        </div>
        <div className="logs-toolbar">
          <label className="logs-live">
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => (e.target.checked ? resumeLive() : pauseLive())}
            />
            实时刷新
          </label>
          {!live && (
            <button type="button" className="secondary small" onClick={resumeLive}>
              恢复实时
            </button>
          )}
        </div>
      </div>

      <section className="card logs-console-card" aria-label="实时日志">
        <div className="logs-console-bar">
          <div className="logs-filters">
            <label>
              级别
              <select
                value={level}
                onChange={(e) => {
                  setLevel(e.target.value as LogLevel | '');
                  if (live) return;
                  // In paused mode the snapshot is frozen; changing filters just
                  // re-filters the rendered list client-side (no refetch needed).
                }}
                disabled={!live}
              >
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              来源
              <select value={src} onChange={(e) => setSrc(e.target.value)} disabled={!live}>
                <option value="">全部</option>
                {SOURCES.filter(Boolean).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="logs-search">
              搜索
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={live ? '输入关键字过滤…' : '暂停中：过滤当前快照'}
              />
            </label>
          </div>
          <div className="logs-status muted small">
            <span>
              共 {lines.length} 行{total > lines.length ? `（缓冲区 ${total} 行，显示最新 ${PAGE} 行）` : ''}
            </span>
            {!follow && <span className="logs-follow-hint">已停止自动滚动，回到底部恢复</span>}
          </div>
        </div>

        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}

        <div className="logs-view" ref={scrollerRef} onScroll={onScroll}>
          {filtered.length === 0 && !error && <p className="muted logs-empty">暂无日志</p>}
          <ol className="logs-list">
            {filtered.map((l, i) => (
              <li key={`${l.t}-${i}`} className={`log-line ${l.level}`}>
                <span className="log-time">{formatTime(l.t)}</span>
                <span className={`log-level lv-${l.level}`}>{l.level.toUpperCase()}</span>
                <span className="log-src">{l.src}</span>
                <span className="log-msg">{l.msg}</span>
              </li>
            ))}
          </ol>
          <div ref={bottomRef} aria-hidden="true" />
        </div>
      </section>

      <section className="card logs-files" aria-labelledby="logfiles-title">
        <div className="card-head">
          <h2 id="logfiles-title">历史日志文件</h2>
          <span className="muted small">按天滚动保存（保留 7 天），点击可下载完整日志</span>
        </div>
        {files.length === 0 ? (
          <p className="muted">暂无日志文件</p>
        ) : (
          <ul className="logs-file-list">
            {files.map((f) => (
              <li key={f.name} className="logs-file-item">
                <a href={`/api/logs/files/${f.name}`} download className="mono">
                  {f.name}
                </a>
                <span className="muted small">{formatSize(f.size)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Compact local time; the date is available in the downloaded files. */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
