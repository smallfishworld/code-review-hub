import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface FlashMessage {
  kind: 'ok' | 'error';
  text: string;
}

interface FlashState {
  flash: FlashMessage | null;
  ok: (text: string) => void;
  fail: (text: string) => void;
  clear: () => void;
}

const FlashContext = createContext<FlashState | null>(null);

/** ariaNotify() is not in the DOM typings yet. */
type AriaNotifyDocument = Document & { ariaNotify?: (message: string) => void };

const AUTO_DISMISS_MS = 6000;

/**
 * Owns the single toast region for the whole app, so every page reports
 * results into the same container (easier to find with a screen reader).
 */
export function FlashProvider({ children }: { children: ReactNode }) {
  const [flash, setFlash] = useState<FlashMessage | null>(null);
  const ok = useCallback((text: string) => setFlash({ kind: 'ok', text }), []);
  const fail = useCallback((text: string) => setFlash({ kind: 'error', text }), []);
  const clear = useCallback(() => setFlash(null), []);
  const value = useMemo(() => ({ flash, ok, fail, clear }), [flash, ok, fail, clear]);

  return (
    <FlashContext.Provider value={value}>
      {children}
      <ToastRegion flash={flash} onDismiss={clear} />
    </FlashContext.Provider>
  );
}

export function useFlash(): FlashState {
  const ctx = useContext(FlashContext);
  if (!ctx) throw new Error('useFlash must be used inside FlashProvider');
  return ctx;
}

/**
 * Toast region: one persistent container, rendered as `popover="manual"` so it
 * sits in the top layer, never light-dismisses, and can be closed explicitly.
 * Success messages auto-dismiss (paused while focus is inside the toast);
 * errors stay until dismissed.
 */
function ToastRegion({ flash, onDismiss }: { flash: FlashMessage | null; onDismiss: () => void }) {
  const regionId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLParagraphElement>(null);

  // Keep the popover in sync with the message state.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const open = el.matches(':popover-open');
    if (flash && !open) el.showPopover();
    else if (!flash && open) el.hidePopover();
  }, [flash]);

  // Announce the message: ariaNotify() where available, otherwise write into
  // the always-present polite live region (cleared first so a repeated
  // message is announced again).
  useEffect(() => {
    const live = liveRef.current;
    if (!flash) {
      if (live) live.textContent = '';
      return;
    }
    const doc = document as AriaNotifyDocument;
    if (typeof doc.ariaNotify === 'function') {
      doc.ariaNotify(flash.text);
      return;
    }
    if (!live) return;
    live.textContent = '';
    const timer = setTimeout(() => {
      live.textContent = flash.text;
    }, 30);
    return () => clearTimeout(timer);
  }, [flash]);

  // Auto-dismiss successes; pause while focus is inside the toast.
  useEffect(() => {
    if (!flash || flash.kind === 'error') return;
    const el = ref.current;
    let timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    const pause = () => clearTimeout(timer);
    const resume = () => {
      clearTimeout(timer);
      timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    };
    el?.addEventListener('focusin', pause);
    el?.addEventListener('focusout', resume);
    return () => {
      clearTimeout(timer);
      el?.removeEventListener('focusin', pause);
      el?.removeEventListener('focusout', resume);
    };
  }, [flash, onDismiss]);

  return (
    <>
      <p ref={liveRef} className="visually-hidden" aria-live="polite" aria-atomic="true" />
      <div
        ref={ref}
        id={regionId}
        popover="manual"
        role="region"
        aria-label="通知"
        className="toast-region"
      >
        {flash && (
          <div className={`toast ${flash.kind}`}>
            <span className="toast-text">{flash.text}</span>
            <button type="button" className="toast-close" aria-label="关闭通知" onClick={onDismiss}>
              ×
            </button>
          </div>
        )}
      </div>
    </>
  );
}
