import { useState } from "react";
import type { HistoryEntry, WorkItemState } from "../../api";
import { stateMeta } from "../../format";
import { cx } from "../helpers";
import { TimeAgo } from "../ui";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function stringField(value: unknown, key: string): string | null {
  const found = field(value, key);
  return typeof found === "string" ? found : null;
}

function stateLabel(value: unknown): string {
  return typeof value === "string" && value in stateMeta ? stateMeta[value as WorkItemState].label.toLowerCase() : "unknown";
}

function pullRequestChange(before: unknown, after: unknown): string {
  const number = field(after, "number");
  const prefix = typeof number === "number" ? `Pull request #${number}` : "Pull request";
  if (field(after, "merged") === true && field(before, "merged") !== true) {
    return `${prefix} was merged`;
  }
  if (field(after, "state") === "closed" && field(before, "state") !== "closed") {
    return `${prefix} was closed without merging`;
  }
  if (field(after, "state") === "open" && field(before, "state") === "closed") {
    return `${prefix} was reopened`;
  }
  if (field(before, "draft") === true && field(after, "draft") === false) {
    return `${prefix} is ready for review`;
  }
  if (field(before, "draft") === false && field(after, "draft") === true) {
    return `${prefix} went back to draft`;
  }
  if (stringField(before, "title") !== stringField(after, "title")) {
    return `${prefix} was retitled`;
  }
  return `${prefix} was updated`;
}

function ciChange(after: unknown): string {
  const conclusion = stringField(after, "conclusion");
  const status = stringField(after, "status");
  const attempt = field(after, "attempt");
  const suffix = typeof attempt === "number" && attempt > 1 ? ` on attempt ${attempt}` : "";
  if (conclusion === "success") {
    return `CI passed${suffix}`;
  }
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") {
    return `CI failed${suffix}`;
  }
  if (conclusion === "cancelled") {
    return `CI was cancelled${suffix}`;
  }
  return status === "completed" ? `CI finished${suffix}` : `CI is running${suffix}`;
}

function describeChange(entry: HistoryEntry, featureTitle: (id: string) => string | null): string {
  const { before, after } = entry;
  switch (entry.change) {
    case "created": {
      const splitFrom = field(after, "splitFrom");
      return splitFrom ? "Created by splitting another work item" : "Created";
    }
    case "title":
      return `Renamed from “${stringField(before, "title") ?? "?"}” to “${stringField(after, "title") ?? "?"}”`;
    case "summary":
      return "Summary updated";
    case "moved": {
      const target = stringField(after, "featureId");
      const title = target ? featureTitle(target) : null;
      return title ? `Moved to “${title}”` : "Moved to another feature";
    }
    case "evidence_attached": {
      const ids = field(after, "evidenceIds");
      const count = Array.isArray(ids) ? ids.length : 1;
      return count === 1 ? "New evidence attached" : `${count} pieces of evidence attached`;
    }
    case "state":
      return `State changed from ${stateLabel(field(before, "state"))} to ${stateLabel(field(after, "state"))}`;
    case "pull_request_updated":
      return pullRequestChange(before, after);
    case "pull_request_reviewed": {
      const number = field(after, "number");
      return typeof number === "number" ? `Pull request #${number} was reviewed` : "Pull request was reviewed";
    }
    case "ci_updated":
      return ciChange(after);
    case "blocked":
      return `Marked blocked: ${stringField(after, "reason") ?? "no reason given"}`;
    case "unblocked":
      return "No longer blocked";
    case "merged":
      return `Merged “${stringField(after, "retiredTitle") ?? "another item"}” into this`;
    case "merged_into":
      return "Merged into another item";
    case "split": {
      const evidence = field(after, "evidenceIds");
      const artifacts = field(after, "artifactIds");
      const count = (Array.isArray(evidence) ? evidence.length : 0) + (Array.isArray(artifacts) ? artifacts.length : 0);
      return `Split ${count} item${count === 1 ? "" : "s"} into a new work item`;
    }
    default:
      return entry.change.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  }
}

function who(entry: HistoryEntry): string {
  switch (entry.basis) {
    case "human":
      return entry.actor ? `@${entry.actor}` : "a person";
    case "inferred":
      return "AI";
    case "observed":
      return "GitHub";
    default: {
      const unhandled: never = entry.basis;
      return unhandled;
    }
  }
}

const dotClass: Record<HistoryEntry["basis"], string> = {
  human: "bg-indigo-500",
  inferred: "bg-fuchsia-400",
  observed: "bg-zinc-400",
};

export function History({ entries, featureTitle }: { entries: HistoryEntry[]; featureTitle: (id: string) => string | null }) {
  const [showAll, setShowAll] = useState(false);
  if (entries.length === 0) {
    return <p className="text-sm text-zinc-500">No changes recorded yet.</p>;
  }
  const shown = showAll ? entries : entries.slice(0, 6);
  return (
    <div>
      <ol className="relative space-y-3 border-l border-zinc-200 pl-4">
        {shown.map((entry, index) => (
          <li key={`${entry.revision}-${entry.change}-${index}`} className="relative">
            <span className={cx("absolute top-1.5 -left-[21px] size-2.5 rounded-full ring-4 ring-white", dotClass[entry.basis])} aria-hidden />
            <p className="text-sm text-zinc-800">{describeChange(entry, featureTitle)}</p>
            <p className="mt-0.5 text-xs text-zinc-500">
              {who(entry)} · <TimeAgo iso={entry.at} />
            </p>
          </li>
        ))}
      </ol>
      {entries.length > shown.length ? (
        <button type="button" onClick={() => setShowAll(true)} className="mt-3 text-xs font-medium text-indigo-600 hover:text-indigo-500">
          Show {entries.length - shown.length} older changes
        </button>
      ) : null}
    </div>
  );
}
