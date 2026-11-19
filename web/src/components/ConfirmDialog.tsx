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

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface ConfirmState {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmState | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/**
 * Promise-based confirmation built on the native <dialog>. The browser owns
 * the modal semantics (inert page, focus containment, Esc, focus return), so
 * there is no focus trap or key handler here.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...options, confirmLabel: options.confirmLabel ?? '确认', resolve });
      }),
    []
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending && !dialog.open) {
      dialog.returnValue = '';
      dialog.showModal();
    } else if (!pending && dialog.open) {
      dialog.close();
    }
  }, [pending]);

  // Read the chosen button from returnValue, then reset it: Esc and the back
  // gesture set no value, and a stale value would leak into the next open.
  const handleClose = () => {
    const dialog = dialogRef.current;
    const confirmed = dialog?.returnValue === 'confirm';
    if (dialog) dialog.returnValue = '';
    pending?.resolve(confirmed);
    setPending(null);
  };

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <dialog
        ref={dialogRef}
        className="confirm"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onClose={handleClose}
      >
        {pending && (
          <>
            <h2 id={titleId}>{pending.title}</h2>
            <p id={bodyId} className="confirm-body">
              {pending.body}
            </p>
            <form method="dialog" className="actions">
              {/* Safe action first, and autofocused for destructive flows. */}
              <button value="cancel" autoFocus={pending.danger}>
                取消
              </button>
              <button
                value="confirm"
                className={pending.danger ? 'danger' : 'primary'}
                autoFocus={!pending.danger}
              >
                {pending.confirmLabel}
              </button>
            </form>
          </>
        )}
      </dialog>
    </ConfirmContext.Provider>
  );
}

/** Ask the user to confirm an action; resolves false on Esc / cancel. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx.confirm;
}
