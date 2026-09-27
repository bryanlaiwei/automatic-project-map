import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { PullRequestDetail, WorkflowRun } from "../../api";
import { cx } from "../helpers";
import { Avatar } from "../ui";

function pullState(pull: PullRequestDetail): { label: string; icon: ReactNode; className: string } {
  if (pull.merged) {
    return { label: "Merged", icon: <GitMerge className="size-4" />, className: "text-violet-600 bg-violet-50" };
  }
  if (pull.state === "closed") {
    return { label: "Closed", icon: <GitPullRequestClosed className="size-4" />, className: "text-rose-600 bg-rose-50" };
  }
  if (pull.draft) {
    return { label: "Draft", icon: <GitPullRequestDraft className="size-4" />, className: "text-zinc-500 bg-zinc-100" };
  }
  return { label: "Open", icon: <GitPullRequest className="size-4" />, className: "text-emerald-600 bg-emerald-50" };
}

type Outcome = "passed" | "failed" | "neutral" | "running";

function outcome(status: string, conclusion: string | null): Outcome {
  if (status !== "completed") {
    return "running";
  }
  switch (conclusion) {
    case "success":
      return "passed";
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "action_required":
      return "failed";
    default:
      return "neutral";
  }
}

const outcomeMeta: Record<Outcome, { label: string; icon: ReactNode }> = {
  passed: { label: "passed", icon: <CircleCheck className="size-4 text-emerald-600" /> },
  failed: { label: "failed", icon: <CircleX className="size-4 text-rose-600" /> },
  neutral: { label: "finished", icon: <CircleMinus className="size-4 text-zinc-400" /> },
  running: { label: "running", icon: <CircleDashed className="size-4 animate-spin text-amber-500 [animation-duration:3s]" /> },
};

function latestReviews(pull: PullRequestDetail) {
  const byReviewer = new Map<string, PullRequestDetail["reviews"][number]>();
  for (const review of [...pull.reviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    byReviewer.set(review.reviewer, review);
  }
  return [...byReviewer.values()].filter((review) => review.decision.toLowerCase() !== "commented");
}

function RunRow({ run }: { run: WorkflowRun }) {
  const [open, setOpen] = useState(false);
  const result = outcome(run.status, run.conclusion);
  const earlier = run.attempts.filter((attempt) => attempt.attempt < run.attempt);
  const earlierFailed = earlier.some((attempt) => outcome(attempt.status, attempt.conclusion) === "failed");
  const jobs = run.jobs.filter((job) => job.attempt === run.attempt);
  return (
    <div className="rounded-lg bg-zinc-50 px-2.5 py-2">
      <div className="flex items-center gap-2">
        {outcomeMeta[result].icon}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={jobs.length === 0}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[13px] text-zinc-700 disabled:cursor-default"
        >
          <span className="truncate">
            CI {outcomeMeta[result].label}
            {run.attempt > 1 ? <span className="text-zinc-500"> · attempt {run.attempt}</span> : null}
            {earlierFailed ? <span className="text-zinc-500"> · an earlier attempt failed</span> : null}
          </span>
          {jobs.length > 0 ? <ChevronRight className={cx("size-3.5 shrink-0 text-zinc-400 transition-transform", open && "rotate-90")} /> : null}
        </button>
        <a href={run.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-zinc-500 hover:text-zinc-900" title="Open workflow run on GitHub">
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      {open ? (
        <ul className="mt-2 space-y-1 border-t border-zinc-200 pt-2">
          {jobs.map((job) => (
            <li key={`${job.jobId}-${job.attempt}`} className="flex items-center gap-2 text-xs text-zinc-600">
              <span className="scale-90">{outcomeMeta[outcome(job.status, job.conclusion)].icon}</span>
              <span className="truncate">{job.name || `Job ${job.jobId}`}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function PullRequestCard({ pull }: { pull: PullRequestDetail }) {
  const state = pullState(pull);
  const reviews = latestReviews(pull);
  return (
    <article className="rounded-xl bg-white p-3 ring-1 ring-zinc-200">
      <div className="flex items-start gap-2.5">
        <span className={cx("mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg", state.className)} title={state.label}>
          {state.icon}
        </span>
        <div className="min-w-0 flex-1">
          <a href={pull.url} target="_blank" rel="noreferrer" className="group block text-sm leading-snug font-medium text-zinc-900 hover:text-indigo-600">
            {pull.title} <span className="font-normal text-zinc-400 group-hover:text-indigo-400">#{pull.number}</span>
          </a>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
            <span className="font-medium">{state.label}</span>
            {pull.author ? (
              <span className="inline-flex items-center gap-1">
                <Avatar login={pull.author} size={14} />@{pull.author}
              </span>
            ) : null}
            {reviews.map((review) => (
              <span
                key={review.reviewer}
                className={cx(
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-px",
                  review.decision.toLowerCase() === "approved" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800",
                )}
              >
                {review.decision.toLowerCase() === "approved" ? "Approved" : "Changes requested"} by @{review.reviewer}
              </span>
            ))}
          </div>
        </div>
      </div>
      {pull.runs.length > 0 ? (
        <div className="mt-2.5 space-y-1.5">
          {pull.runs.slice(0, 3).map((run) => (
            <RunRow key={run.artifactId} run={run} />
          ))}
        </div>
      ) : null}
    </article>
  );
}
