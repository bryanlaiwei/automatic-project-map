import { Check, Laptop, Sparkles, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui";

function Step({ done, title, detail, action }: { done: boolean; title: string; detail: string; action?: ReactNode }) {
  return (
    <li className="flex items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-zinc-50">
      <span
        className={
          done
            ? "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white"
            : "mt-0.5 size-5 shrink-0 rounded-full border-2 border-dashed border-zinc-300"
        }
      >
        {done ? <Check className="size-3.5" strokeWidth={3} /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-zinc-900">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{detail}</p>
      </div>
      {action}
    </li>
  );
}

export function EmptyMap({
  pendingAnalysis,
  onConnectHelper,
  onInvite,
  canInvite,
}: {
  pendingAnalysis: number;
  onConnectHelper: () => void;
  onInvite: () => void;
  canInvite: boolean;
}) {
  return (
    <div className="animate-in w-[min(440px,calc(100vw-48px))] rounded-2xl bg-white/95 p-6 shadow-xl ring-1 shadow-zinc-900/5 ring-zinc-200 backdrop-blur">
      <div className="flex size-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
        <Sparkles className="size-5" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-zinc-900">Connected.</h2>
      <p className="mt-1 text-sm leading-relaxed text-zinc-600">Your feature map will appear as PRs, workflow runs, or local agent activity arrive.</p>
      {pendingAnalysis > 0 ? (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200 ring-inset">
          {pendingAnalysis} update{pendingAnalysis === 1 ? " is" : "s are"} waiting for AI analysis.
        </p>
      ) : null}
      <ul className="-mx-3 mt-5 space-y-0.5">
        <Step done title="Repository connected" detail="New pull requests and Actions runs show up automatically." />
        <Step
          done={false}
          title="Collect agent sessions"
          detail="Run the local helper to include Codex, Claude Code and Cursor work from folders you choose."
          action={
            <Button size="sm" icon={<Laptop className="size-3.5" />} onClick={onConnectHelper}>
              Set up
            </Button>
          }
        />
        {canInvite ? (
          <Step
            done={false}
            title="Invite teammates"
            detail="Optional. Everyone sees the same map."
            action={
              <Button size="sm" icon={<UserPlus className="size-3.5" />} onClick={onInvite}>
                Invite
              </Button>
            }
          />
        ) : null}
      </ul>
    </div>
  );
}
