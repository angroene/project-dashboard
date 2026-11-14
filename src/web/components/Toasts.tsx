import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type Kind = "info" | "error";
interface Toast {
  id: number;
  message: string;
  kind: Kind;
}
type ToastFn = (message: string, kind?: Kind) => void;

const ToastContext = createContext<ToastFn | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback<ToastFn>((message, kind = "info") => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-3), { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4000);
  }, []);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span>{t.message}</span>
            <button type="button" className="btn ghost btn-icon" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const t = useContext(ToastContext);
  if (!t) throw new Error("useToast must be used inside ToastProvider");
  return t;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path (clipboard permission denied or unavailable)
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Copies and announces the outcome in the live region. */
export function useCopy(): (text: string, what: string) => Promise<void> {
  const toast = useToast();
  return useCallback(
    async (text: string, what: string) => {
      const ok = await copyText(text);
      toast(ok ? `Copied ${what} to clipboard` : `Could not copy ${what}: clipboard unavailable`, ok ? "info" : "error");
    },
    [toast],
  );
}
