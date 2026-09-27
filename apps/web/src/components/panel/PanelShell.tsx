import { X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../ui";

export function PanelShell({ onClose, header, children }: { onClose: () => void; header?: ReactNode; children: ReactNode }) {
  return (
    <aside
      className="panel-in absolute top-3 right-3 bottom-3 z-20 flex w-[min(440px,calc(100%-24px))] flex-col overflow-hidden rounded-2xl bg-white shadow-xl ring-1 shadow-zinc-900/5 ring-zinc-200"
      aria-label="Details"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-100 pr-2 pl-4">
        <div className="min-w-0 flex-1 truncate text-sm text-zinc-500">{header}</div>
        <IconButton label="Close details (Esc)" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-8">{children}</div>
    </aside>
  );
}

export function PanelMessage({ children }: { children: ReactNode }) {
  return <div className="flex min-h-40 items-center justify-center text-center text-sm text-zinc-500">{children}</div>;
}
