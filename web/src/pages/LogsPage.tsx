import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, type LogFile, type LogLine, type LogLevel } from '../api/client';
import { errorText, usePageTitle } from '../api/hooks';
import { useI18n, type MessageKey } from '../i18n';

const LEVELS: { value: LogLevel | ''; labelKey: MessageKey }[] = [
  { value: '', labelKey: 'logs.filter.allLevels' },
  { value: 'debug', labelKey: 'logs.filter.debugUp' },
  { value: 'info', labelKey: 'logs.filter.infoUp' },
  { value: 'warn', labelKey: 'logs.filter.warnUp' },
  { value: 'error', labelKey: 'logs.filter.errorOnly' },
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
  const { t } = useI18n();
  usePageTitle(t('logs.pageTitle'));
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
  const ids = {
    live: useId(),
    level: useId(),
    src: useId(),
    search: useId(),
  };

  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- async fetch, setState lands after await
    void fetchOnce();
    if (!live) return;
    const timer = setInterval(() => void fetchOnce(), POLL_MS);
    return () => clearInterval(timer);
  }, [live, fetchOnce]);

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

  useEffect(() => {
    if (!follow) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lines, follow]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
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
          <h1>{t('logs.pageTitle')}</h1>
          <p className="page-subtitle">{t('logs.subtitle')}</p>
        </div>
        <div className="logs-toolbar">
          <label className="logs-live" htmlFor={ids.live}>
            <input
              id={ids.live}
              name="liveRefresh"
              type="checkbox"
              checked={live}
              onChange={(e) => (e.target.checked ? resumeLive() : pauseLive())}
            />
            {t('logs.liveRefresh')}
          </label>
          {!live && (
            <button type="button" className="secondary small" onClick={resumeLive}>
              {t('logs.resumeLive')}
            </button>
          )}
        </div>
      </div>

      <section className="card logs-console-card" aria-label={t('logs.consoleAria')}>
        <div className="logs-console-bar">
          <div className="logs-filters">
            <label htmlFor={ids.level}>
              {t('logs.filter.level')}
              <select
                id={ids.level}
                name="logLevel"
                value={level}
                onChange={(e) => {
                  setLevel(e.target.value as LogLevel | '');
                  if (live) return;
                }}
                disabled={!live}
              >
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {t(l.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={ids.src}>
              {t('logs.filter.source')}
              <select id={ids.src} name="logSource" value={src} onChange={(e) => setSrc(e.target.value)} disabled={!live}>
                <option value="">{t('common.all')}</option>
                {SOURCES.filter(Boolean).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="logs-search" htmlFor={ids.search}>
              {t('logs.filter.search')}
              <input
                id={ids.search}
                name="logSearch"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={live ? t('logs.filter.searchLive') : t('logs.filter.searchPaused')}
              />
            </label>
          </div>
          <div className="logs-status muted small">
            <span>
              {total > lines.length
                ? t('logs.countBuffered', { shown: lines.length, total, page: PAGE })
                : t('logs.count', { shown: lines.length })}
            </span>
            {!follow && <span className="logs-follow-hint">{t('logs.followHint')}</span>}
          </div>
        </div>

        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}

        <div className="logs-view" ref={scrollerRef} onScroll={onScroll}>
          {filtered.length === 0 && !error && <p className="muted logs-empty">{t('logs.empty')}</p>}
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
          <h2 id="logfiles-title">{t('logs.files.title')}</h2>
          <span className="muted small">{t('logs.files.hint')}</span>
        </div>
        {files.length === 0 ? (
          <p className="muted">{t('logs.files.empty')}</p>
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
