import type { Basis, WorkItemState } from "./api";

export const stateOrder: WorkItemState[] = ["in_progress", "in_review", "planned", "merged", "closed", "unknown"];

export const stateMeta: Record<WorkItemState, { label: string; dot: string; bar: string; chip: string }> = {
  planned: { label: "Planned", dot: "bg-slate-400", bar: "bg-slate-300", chip: "bg-slate-100 text-slate-700 ring-slate-200" },
  in_progress: { label: "In progress", dot: "bg-sky-500", bar: "bg-sky-500", chip: "bg-sky-50 text-sky-700 ring-sky-200" },
  in_review: { label: "In review", dot: "bg-amber-500", bar: "bg-amber-400", chip: "bg-amber-50 text-amber-800 ring-amber-200" },
  merged: { label: "Merged", dot: "bg-violet-500", bar: "bg-violet-500", chip: "bg-violet-50 text-violet-700 ring-violet-200" },
  closed: { label: "Closed", dot: "bg-rose-400", bar: "bg-rose-300", chip: "bg-rose-50 text-rose-700 ring-rose-200" },
  unknown: { label: "Unknown", dot: "bg-zinc-300", bar: "bg-zinc-200", chip: "bg-zinc-100 text-zinc-600 ring-zinc-200" },
};

export function describeCounts(counts: Partial<Record<WorkItemState, number>>): string {
  const parts = stateOrder.flatMap((state) => {
    const count = counts[state];
    return count ? [`${count} ${stateMeta[state].label.toLowerCase()}`] : [];
  });
  return parts.length > 0 ? parts.join(" · ") : "No work items yet";
}

export const agentMeta: Record<string, { label: string; short: string; className: string }> = {
  codex: { label: "Codex", short: "Cx", className: "bg-zinc-900 text-white" },
  claude_code: { label: "Claude Code", short: "CC", className: "bg-[#d97757] text-white" },
  cursor: { label: "Cursor", short: "Cu", className: "bg-zinc-700 text-white" },
};

export function agentLabel(source: string): string {
  return agentMeta[source]?.label ?? source;
}

export function sessionName(source: string, sessionId: string | null): string {
  const short = sessionId ? sessionId.replace(/^.*[/:]/, "").slice(0, 8) : null;
  return short ? `${agentLabel(source)} session · ${short}` : `${agentLabel(source)} session`;
}

export function basisLabel(basis: Basis): string {
  switch (basis) {
    case "observed":
      return "From GitHub";
    case "inferred":
      return "Inferred by AI";
    case "human":
      return "Set by a person";
    default: {
      const unhandled: never = basis;
      return unhandled;
    }
  }
}

export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) {
    return "never";
  }
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${days} d ago`;
  }
  return new Date(iso).toLocaleDateString();
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Accepts "owner/name", "github.com/owner/name" or a full GitHub URL. */
export function parseRepository(value: string): { owner: string; name: string } | null {
  const cleaned = value
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^(www\.)?github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(cleaned);
  return match?.[1] && match[2] ? { owner: match[1], name: match[2] } : null;
}
