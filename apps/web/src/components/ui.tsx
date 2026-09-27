import { Check, LoaderCircle, Pencil, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Basis, Contributors, WorkItemState } from "../api";
import { agentMeta, basisLabel, stateMeta, timeAgo } from "../format";
import { cx, useNow } from "./helpers";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: ReactNode;
  loading?: boolean;
};

export function Button({ variant = "secondary", size = "md", icon, loading = false, className, children, disabled, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-indigo-600 text-white shadow-sm hover:bg-indigo-500",
        variant === "secondary" && "bg-white text-zinc-800 shadow-sm ring-1 ring-zinc-200 ring-inset hover:bg-zinc-50",
        variant === "ghost" && "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
        variant === "danger" && "bg-rose-600 text-white shadow-sm hover:bg-rose-500",
        className,
      )}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx(
        "inline-flex size-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function StateDot({ state, className }: { state: WorkItemState; className?: string }) {
  return <span className={cx("inline-block size-2 shrink-0 rounded-full", stateMeta[state].dot, className)} aria-hidden />;
}

export function StateChip({ state, basis }: { state: WorkItemState; basis?: Basis }) {
  return (
    <span
      className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", stateMeta[state].chip)}
      title={basis ? basisLabel(basis) : undefined}
    >
      <StateDot state={state} />
      {stateMeta[state].label}
    </span>
  );
}

export function StateBar({ counts, className }: { counts: Partial<Record<WorkItemState, number>>; className?: string }) {
  const entries = (Object.keys(stateMeta) as WorkItemState[])
    .map((state) => [state, counts[state] ?? 0] as const)
    .filter(([, count]) => count > 0);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return (
    <div className={cx("flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-zinc-100", className)}>
      {entries.map(([state, count]) => (
        <div key={state} className={cx("h-full first:rounded-l-full last:rounded-r-full", stateMeta[state].bar)} style={{ width: `${(count / total) * 100}%` }} />
      ))}
    </div>
  );
}

export function Avatar({ login, src, size = 20, className }: { login: string; src?: string | null; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const url = src ?? `https://github.com/${encodeURIComponent(login)}.png?size=${size * 2}`;
  if (failed) {
    return (
      <span
        className={cx("inline-flex shrink-0 items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-700 uppercase", className)}
        style={{ width: size, height: size, fontSize: size * 0.45 }}
        title={`@${login}`}
      >
        {login.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      title={`@${login}`}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className={cx("shrink-0 rounded-full bg-zinc-100 ring-1 ring-white", className)}
    />
  );
}

export function AgentBadge({ source, size = 20 }: { source: string; size?: number }) {
  const meta = agentMeta[source] ?? { label: source, short: source.slice(0, 2), className: "bg-zinc-500 text-white" };
  return (
    <span
      className={cx("inline-flex shrink-0 items-center justify-center rounded-md font-semibold ring-1 ring-white", meta.className)}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      title={meta.label}
    >
      {meta.short}
    </span>
  );
}

export function ContributorStack({ contributors, max = 4, size = 20 }: { contributors: Contributors; max?: number; size?: number }) {
  const all = [
    ...contributors.agents.map((agent) => ({ key: `a:${agent}`, node: <AgentBadge source={agent} size={size} /> })),
    ...contributors.people.map((login) => ({ key: `p:${login}`, node: <Avatar login={login} size={size} /> })),
  ];
  if (all.length === 0) {
    return null;
  }
  const shown = all.slice(0, max);
  return (
    <div className="flex items-center -space-x-1">
      {shown.map((entry) => (
        <span key={entry.key} className="inline-flex">
          {entry.node}
        </span>
      ))}
      {all.length > max ? <span className="pl-2 text-xs text-zinc-500">+{all.length - max}</span> : null}
    </div>
  );
}

export function ContributorList({ contributors }: { contributors: Contributors }) {
  if (contributors.agents.length + contributors.people.length === 0) {
    return <p className="text-sm text-zinc-500">No contributors recorded yet.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {contributors.agents.map((agent) => (
        <span key={agent} className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 py-0.5 pr-2.5 pl-0.5 text-xs font-medium text-zinc-700">
          <AgentBadge source={agent} size={18} />
          {agentMeta[agent]?.label ?? agent}
        </span>
      ))}
      {contributors.people.map((login) => (
        <a
          key={login}
          href={`https://github.com/${login}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 py-0.5 pr-2.5 pl-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200"
        >
          <Avatar login={login} size={18} />@{login}
        </a>
      ))}
    </div>
  );
}

export function TimeAgo({ iso, className }: { iso: string | null; className?: string }) {
  const now = useNow();
  if (!iso) {
    return null;
  }
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className={className}>
      {timeAgo(iso, now)}
    </time>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx("size-4 animate-spin text-zinc-400", className)} aria-label="Loading" />;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">{children}</h3>
      {action}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const first = panel.current?.querySelector<HTMLElement>("input, select, textarea, button[data-autofocus]");
    first?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-950/30 p-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        className={cx("w-full rounded-2xl bg-white shadow-2xl ring-1 ring-zinc-200 animate-in", wide ? "max-w-2xl" : "max-w-md")}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
            {description ? <div className="mt-1 text-sm text-zinc-500">{description}</div> : null}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mt-1 -mr-2">
            <X className="size-4" />
          </IconButton>
        </div>
        {children ? <div className="px-5 pt-4">{children}</div> : null}
        <div className="flex justify-end gap-2 px-5 pt-5 pb-5">{footer}</div>
      </div>
    </div>
  );
}

export function EditableTitle({
  value,
  onSave,
  className,
  label,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
  className?: string;
  label: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const committing = useRef(false);

  async function commit() {
    if (committing.current) {
      return;
    }
    const next = draft.replace(/\s+/g, " ").trim();
    if (next === "" || next === value) {
      setEditing(false);
      setDraft(value);
      return;
    }
    committing.current = true;
    setSaving(true);
    try {
      await onSave(next.slice(0, 120));
      setEditing(false);
    } finally {
      committing.current = false;
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(value);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={draft}
          maxLength={120}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => void commit()}
          aria-label={label}
          className={cx("min-w-0 flex-1 rounded-md border border-indigo-300 bg-white px-1.5 py-0.5 outline-none ring-2 ring-indigo-100", className)}
        />
        <IconButton label="Save" onMouseDown={(event) => event.preventDefault()} onClick={() => void commit()}>
          {saving ? <Spinner /> : <Check className="size-4" />}
        </IconButton>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      className={cx("group -mx-1.5 flex items-start gap-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-zinc-100", className)}
      title={label}
    >
      <span className="min-w-0">{value}</span>
      <Pencil className="mt-1 size-3.5 shrink-0 text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
    </button>
  );
}

export function Menu({ trigger, items }: { trigger: (open: () => void) => ReactNode; items: Array<{ label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      {trigger(() => setOpen((value) => !value))}
      {open ? (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-xl bg-white p-1 shadow-lg ring-1 ring-zinc-200 animate-in">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cx(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm disabled:opacity-40",
                item.danger ? "text-rose-600 hover:bg-rose-50" : "text-zinc-700 hover:bg-zinc-100",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-zinc-800">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm ring-1 ring-zinc-200 ring-inset placeholder:text-zinc-400 focus:ring-2 focus:ring-indigo-500 focus:outline-none";

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) {
    return null;
  }
  return <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200 ring-inset">{children}</p>;
}
