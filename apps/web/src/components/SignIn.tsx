import { GitPullRequest, Laptop, Workflow } from "lucide-react";
import { useState } from "react";
import { GithubMark, LogoMark } from "./GithubMark";
import { Button, ErrorNote } from "./ui";

export function SignIn({ onSignIn }: { onSignIn: () => Promise<string | null> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden px-4 py-16">
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ backgroundImage: "radial-gradient(#d4d4d8 1.2px, transparent 1.2px)", backgroundSize: "22px 22px" }}
        aria-hidden
      />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-indigo-200/40 blur-3xl" aria-hidden />
      <div className="animate-in relative w-full max-w-md rounded-3xl bg-white/90 p-8 shadow-xl ring-1 shadow-zinc-900/5 ring-zinc-200 backdrop-blur">
        <LogoMark className="size-11" />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-zinc-900">Automatic Project Map</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-zinc-600">
          A live map of what your team is building, assembled from pull requests, CI and coding-agent sessions. Nobody has to update a board.
        </p>
        <ul className="mt-6 space-y-2.5 text-sm text-zinc-700">
          <li className="flex items-center gap-2.5">
            <GitPullRequest className="size-4 text-emerald-600" /> Pull request and CI state straight from GitHub
          </li>
          <li className="flex items-center gap-2.5">
            <Laptop className="size-4 text-sky-600" /> Work from Codex, Claude Code and Cursor
          </li>
          <li className="flex items-center gap-2.5">
            <Workflow className="size-4 text-violet-600" /> Grouped into features you can click through
          </li>
        </ul>
        <Button
          variant="primary"
          className="mt-8 h-11 w-full bg-zinc-900 text-[15px] hover:bg-zinc-800"
          icon={<GithubMark className="size-5" />}
          loading={busy}
          onClick={() => {
            setBusy(true);
            void onSignIn().then((message) => {
              setError(message);
              setBusy(false);
            });
          }}
        >
          Continue with GitHub
        </Button>
        {error ? (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}
      </div>
    </div>
  );
}
