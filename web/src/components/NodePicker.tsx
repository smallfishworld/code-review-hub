import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, type RepoNode, type RepoNodePage } from '../api/client';
import { errorText } from '../api/hooks';
import { useI18n } from '../i18n';

interface NodePickerProps {
  repoId: number | '';
  value: string;
  onChange: (value: string) => void;
  /** Accessible name; the visible label is rendered by the caller. */
  label: string;
  placeholder?: string;
  required?: boolean;
  /** id of the visible <label>, so the input keeps its native association. */
  inputId?: string;
}

const DEBOUNCE_MS = 250;
/** Page size for both the initial load and every "load older" scroll step. */
const PAGE_SIZE = 100;

/**
 * Searchable node picker: an editable combobox over the repo's history.
 * Opens with the most recent 100 revisions/commits (newest-first); scrolling
 * to the bottom fetches the next older page, so the full history is
 * reachable without leaving the popup. Free text stays valid — an operator
 * can still type a revision number or a short SHA that is not listed.
 */
export function NodePicker({
  repoId,
  value,
  onChange,
  label,
  placeholder,
  required,
  inputId,
}: NodePickerProps) {
  const { t } = useI18n();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState<RepoNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  // Open upwards when the input sits near the bottom of the window, so the
  // list is not clipped by the viewport edge. `maxHeight` keeps the popup
  // inside the space that is actually available on the chosen side.
  const [placement, setPlacement] = useState({ flip: false, maxHeight: 320 });
  // The query is what the user typed; `value` is the committed node.
  const [query, setQuery] = useState(value);
  // What the list is filtered by. Cleared on commit so reopening the picker
  // shows the recent nodes again instead of only the one already chosen.
  const [filter, setFilter] = useState('');
  // Cursor of the next (older) page; undefined = history exhausted.
  const cursorRef = useRef<string | undefined>(undefined);
  // Every load takes a ticket and only the newest may write state: a slow
  // request for an earlier keystroke (or for the previous repo) would
  // otherwise land last and show the wrong list.
  const requestSeq = useRef(0);
  // Track the last props we synced from, so the resets happen during render
  // (React's recommended pattern) rather than in an effect that would render
  // twice and briefly show the previous repo's revisions.
  const [synced, setSynced] = useState({ value, repoId });
  if (synced.value !== value || synced.repoId !== repoId) {
    const repoChanged = synced.repoId !== repoId;
    setSynced({ value, repoId });
    if (synced.value !== value) {
      setQuery(value);
      if (value === '') setFilter('');
    }
    if (repoChanged) {
      setNodes([]);
      setError(null);
      setActive(-1);
      setOpen(false);
      setFilter('');
    }
  }

  // Invalidate in-flight loads on a repo switch: the cleanup runs
  // synchronously at commit, before any pending response can land, so stale
  // results from the previous repo are discarded by the ticket check.
  useEffect(() => {
    return () => {
      requestSeq.current += 1;
    };
  }, [repoId]);

  /** First page: resets the list (repo opened, filter changed). */
  const load = useCallback(
    async (q: string) => {
      if (repoId === '') return;
      const ticket = ++requestSeq.current;
      setLoading(true);
      setExhausted(false);
      cursorRef.current = undefined;
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (q.trim()) params.set('q', q.trim());
        const page = await api.get<RepoNodePage>(`/api/repos/${repoId}/nodes?${params}`);
        // A newer keystroke (or a repo switch) already superseded this one.
        if (ticket !== requestSeq.current) return;
        setNodes(page.items);
        cursorRef.current = page.nextCursor;
        setExhausted(!page.nextCursor);
        setError(null);
      } catch (err) {
        if (ticket !== requestSeq.current) return;
        setNodes([]);
        setExhausted(false);
        setError(errorText(err));
      } finally {
        if (ticket === requestSeq.current) setLoading(false);
      }
    },
    [repoId]
  );

  /** Next (older) page: appends; a no-op while exhausted or already loading. */
  const loadMore = useCallback(async () => {
    if (repoId === '' || loading || loadingMore || !cursorRef.current) return;
    const ticket = ++requestSeq.current;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        cursor: cursorRef.current,
      });
      if (filter.trim()) params.set('q', filter.trim());
      const page = await api.get<RepoNodePage>(`/api/repos/${repoId}/nodes?${params}`);
      if (ticket !== requestSeq.current) return;
      // Dedupe by node id: a commit landing between page fetches would
      // otherwise shift git's skip-based window and duplicate an entry.
      const seen = new Set(nodes.map((n) => n.node));
      setNodes((prev) => [...prev, ...page.items.filter((n) => !seen.has(n.node))]);
      cursorRef.current = page.nextCursor;
      setExhausted(!page.nextCursor);
      setError(null);
    } catch (err) {
      if (ticket !== requestSeq.current) return;
      setError(errorText(err));
    } finally {
      if (ticket === requestSeq.current) setLoadingMore(false);
    }
  }, [repoId, loading, loadingMore, filter, nodes]);

  /** Open the popup, choosing the side with room for it. */
  const openList = useCallback(() => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (rect) {
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      // Prefer downwards; flip only when below is too tight and above is roomier.
      const flip = below < 240 && above > below;
      setPlacement({ flip, maxHeight: Math.max(160, Math.min(420, flip ? above : below)) });
    }
    setOpen(true);
  }, []);

  // Fetch the first page when the popup opens or the typed filter changes
  // (debounced: this runs on every keystroke). The committed value is
  // deliberately not used as the filter: after picking a node, reopening
  // should show the recent list, not the single commit the input now holds.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void load(filter), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, filter, load]);

  // Light dismiss: a pointer press outside the wrapper closes the popup.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // A resize changes how much room is left above/below the input, so the
  // side and height chosen on open can go stale while the list is showing.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', openList);
    return () => window.removeEventListener('resize', openList);
  }, [open, openList]);

  const commit = (node: string) => {
    onChange(node);
    setQuery(node);
    setFilter('');
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      if (nodes.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => {
        const next = i + delta;
        if (next < 0) return nodes.length - 1;
        if (next >= nodes.length) return 0;
        return next;
      });
      return;
    }
    if (e.key === 'Enter') {
      if (open && active >= 0 && nodes[active]) {
        // Selecting an option must not also submit the form.
        e.preventDefault();
        commit(nodes[active].node);
      }
      return;
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  // Infinite scroll: near the bottom of the popup, fetch the next older page.
  // Scrolling (not the option list) drives this so keyboard navigation does
  // not trigger loads.
  const onPopupScroll = () => {
    const el = popupRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) void loadMore();
  };

  const showPopup = open && repoId !== '';
  const activeId = active >= 0 && nodes[active] ? `${listId}-${active}` : undefined;

  return (
    <div className="combobox" ref={wrapRef}>
      <div className="combobox-control">
        <input
          ref={inputRef}
          id={inputId}
          role="combobox"
          aria-expanded={showPopup}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showPopup ? activeId : undefined}
          aria-label={inputId ? undefined : label}
          value={query}
          placeholder={placeholder}
          required={required}
          autoComplete="off"
          disabled={repoId === ''}
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            // Filtering uses its own state: the committed value must not act
            // as the filter when the popup reopens (see the effect below).
            setFilter(next);
            onChange(next);
            if (!open) openList();
            setActive(-1);
          }}
          onFocus={() => {
            if (!open) openList();
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="combobox-toggle"
          aria-label={showPopup ? t('nodePicker.collapse') : t('nodePicker.expand')}
          aria-expanded={showPopup}
          disabled={repoId === ''}
          // Keep focus on the input so the list stays anchored to it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!open) openList();
            else setOpen(false);
            inputRef.current?.focus();
          }}
        >
          <span aria-hidden="true">▾</span>
        </button>
      </div>

      {showPopup && (
        <div
          ref={popupRef}
          className={`combobox-popup${placement.flip ? ' flip' : ''}`}
          style={{ maxBlockSize: placement.maxHeight }}
          onScroll={onPopupScroll}
        >
          {loading && nodes.length === 0 && <p className="combobox-status">{t('common.loading')}</p>}
          {error && (
            <p className="combobox-status error" role="status">
              {error}
            </p>
          )}
          {!error && !loading && nodes.length === 0 && (
            <p className="combobox-status">
              {filter.trim() ? t('nodePicker.noMatch', { filter: filter.trim() }) : t('nodePicker.empty')}
            </p>
          )}
          {nodes.length > 0 && (
            <ul className="combobox-list" id={listId} role="listbox" aria-label={label}>
              {nodes.map((n, i) => (
                <li
                  key={n.node}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={`combobox-option${i === active ? ' active' : ''}`}
                  // mousedown (not click) so the input does not blur first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(n.node);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="combobox-option-head">
                    <span className="mono combobox-node" title={n.node}>
                      {shortNode(n.node)}
                    </span>
                    <span className="combobox-meta">
                      {n.author || t('nodePicker.unknownAuthor')} · {formatDate(n.date)}
                    </span>
                  </span>
                  <span className="combobox-message">{n.message || t('nodePicker.noMessage')}</span>
                </li>
              ))}
            </ul>
          )}
          {loadingMore && <p className="combobox-status">{t('nodePicker.loadingMore')}</p>}
          {!loadingMore && exhausted && nodes.length > 0 && (
            <p className="combobox-status combobox-end">{t('nodePicker.reachedEnd')}</p>
          )}
          <p className="combobox-hint">
            {t('nodePicker.hint')}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * A 40-char SHA crowds out the author and message; show the short form (the
 * full value is in the title and is what gets submitted).
 */
function shortNode(node: string): string {
  return /^[0-9a-f]{40}$/i.test(node) ? node.slice(0, 10) : node;
}

/** Compact local date; falls back to the raw value if it cannot be parsed. */
function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
