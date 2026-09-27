import { CircleAlert, CircleCheck } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { cx } from "./helpers";
import { ToastContext, type ToastTone } from "./toast-context";

type Toast = { id: number; message: string; tone: ToastTone };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((message: string, tone: ToastTone = "success") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), tone === "error" ? 6000 : 3000);
  }, []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx(
              "pointer-events-auto flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-medium shadow-lg ring-1 animate-in",
              toast.tone === "success" ? "bg-zinc-900 text-white ring-zinc-800" : "bg-white text-rose-700 ring-rose-200",
            )}
          >
            {toast.tone === "success" ? <CircleCheck className="size-4 text-emerald-400" /> : <CircleAlert className="size-4" />}
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
