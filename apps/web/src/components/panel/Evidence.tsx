import { GitPullRequest } from "lucide-react";
import { useState } from "react";
import type { Basis, EvidenceDetail } from "../../api";
import { agentLabel, sessionName } from "../../format";
import { cx } from "../helpers";
import { AgentBadge, TimeAgo } from "../ui";
import { parseExcerpt } from "./excerpt";

const linkLabel: Record<Basis, string> = {
  observed: "From GitHub",
  inferred: "Linked by AI",
  human: "Linked by a person",
};

function Clamp({ text, lines }: { text: string; lines: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 90 || text.split("\n").length > lines;
  return (
    <div>
      <p className={cx("text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-700", !open && long && "line-clamp-4")}>{text}</p>
      {long ? (
        <button type="button" onClick={() => setOpen((value) => !value)} className="mt-1 text-xs font-medium text-indigo-600 hover:text-indigo-500">
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

export function EvidenceCard({ evidence }: { evidence: EvidenceDetail }) {
  const [expanded, setExpanded] = useState(false);
  const isSession = evidence.kind === "session_excerpt";
  const messages = isSession ? parseExcerpt(evidence.excerpt) : [];
  const shownMessages = expanded ? messages : messages.slice(0, 3);
  const agent = agentLabel(evidence.source);

  return (
    <article className="rounded-xl bg-white p-3 ring-1 ring-zinc-200">
      <header className="flex items-center gap-2">
        {isSession ? (
          <AgentBadge source={evidence.source} size={20} />
        ) : (
          <span className="inline-flex size-5 items-center justify-center rounded-md bg-emerald-50 text-emerald-600">
            <GitPullRequest className="size-3.5" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-700">
          {isSession ? sessionName(evidence.source, evidence.sessionId) : "Pull request description"}
        </span>
        <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500">{linkLabel[evidence.basis]}</span>
      </header>
      <div className="mt-2.5 space-y-2.5">
        {isSession ? (
          shownMessages.map((message, index) => (
            <div key={index} className={cx("rounded-lg px-2.5 py-2", message.role === "User" ? "bg-indigo-50/70" : "bg-zinc-50")}>
              <p className="mb-0.5 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                {message.role === "User" ? "Request" : agent}
              </p>
              <Clamp text={message.text} lines={4} />
            </div>
          ))
        ) : (
          <Clamp text={evidence.excerpt} lines={6} />
        )}
        {messages.length > shownMessages.length ? (
          <button type="button" onClick={() => setExpanded(true)} className="text-xs font-medium text-indigo-600 hover:text-indigo-500">
            Show {messages.length - shownMessages.length} more messages
          </button>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] text-zinc-400">
        Observed <TimeAgo iso={evidence.observedAt} />
      </p>
    </article>
  );
}

export function EvidenceList({ evidence }: { evidence: EvidenceDetail[] }) {
  const [showAll, setShowAll] = useState(false);
  if (evidence.length === 0) {
    return <p className="text-sm text-zinc-500">No session excerpts or pull request descriptions linked yet.</p>;
  }
  const shown = showAll ? evidence : evidence.slice(0, 4);
  return (
    <div className="space-y-2.5">
      {shown.map((item) => (
        <EvidenceCard key={item.id} evidence={item} />
      ))}
      {evidence.length > shown.length ? (
        <button type="button" onClick={() => setShowAll(true)} className="text-xs font-medium text-indigo-600 hover:text-indigo-500">
          Show {evidence.length - shown.length} more
        </button>
      ) : null}
    </div>
  );
}
