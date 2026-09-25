import { useEffect, useState } from "react";
import { ApiError } from "../../api";

/**
 * Loads a detail record and reloads it whenever the map revision changes, keeping the previous record on
 * screen while the new one arrives.
 */
export function useDetail<T>(load: () => Promise<T>, key: string, revision: number) {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null; missing: boolean }>({
    key,
    data: null,
    error: null,
    missing: false,
  });
  useEffect(() => {
    let cancelled = false;
    load()
      .then((data) => {
        if (!cancelled) {
          setState({ key, data, error: null, missing: false });
        }
      })
      .catch((reason: unknown) => {
        if (cancelled) {
          return;
        }
        const missing = reason instanceof ApiError && reason.status === 404;
        setState((current) => ({
          key,
          data: current.key === key ? current.data : null,
          error: reason instanceof Error ? reason.message : "Could not load details.",
          missing,
        }));
      });
    return () => {
      cancelled = true;
    };
    // load is recreated each render; the key and revision decide when to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision]);
  const current = state.key === key ? state : { data: null, error: null, missing: false };
  return { data: current.data, error: current.error, missing: current.missing, loading: current.data === null && current.error === null };
}
