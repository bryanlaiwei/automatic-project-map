import { createContext, useContext } from "react";

export type ToastTone = "success" | "error";

export const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}
