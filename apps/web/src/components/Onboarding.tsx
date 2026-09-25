import { ArrowRight, LogOut, Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, errorMessage, type Me } from "../api";
import { parseRepository } from "../format";
import { GithubMark, LogoMark } from "./GithubMark";
import { cx } from "./helpers";
import { Avatar, Button, ErrorNote, IconButton, inputClass } from "./ui";

const installUrl = import.meta.env.VITE_GITHUB_APP_INSTALL_URL;

export function Onboarding({
  token,
  me,
  onConnected,
  onJoined,
  onSignOut,
}: {
  token: string;
  me: Me;
  onConnected: (projectId: string) => void;
  onJoined: (projectId: string) => void;
  onSignOut: () => void;
}) {
  const [repository, setRepository] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const parsed = parseRepository(repository);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!parsed) {
      setError("Enter the repository as owner/name, for example acme/web-app.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = await api.connectProject(token, parsed);
      onConnected(body.project.id);
    } catch (reason) {
      setError(errorMessage(reason, "Could not connect the repository."));
    } finally {
      setBusy(false);
    }
  }

  async function join(invitationId: string) {
    setJoining(invitationId);
    setJoinError(null);
    try {
      const body = await api.acceptInvitation(token, invitationId);
      onJoined(body.projectId);
    } catch (reason) {
      setJoinError(errorMessage(reason, "Could not join the project."));
    } finally {
      setJoining(null);
    }
  }

  return (
    <div className="min-h-full">
      <header className="flex h-14 items-center gap-3 px-5">
        <LogoMark className="size-7" />
        <span className="text-sm font-semibold text-zinc-900">Project Map</span>
        <div className="ml-auto flex items-center gap-2 text-sm text-zinc-500">
          {me.user.githubLogin ? <Avatar login={me.user.githubLogin} src={me.user.avatarUrl} size={26} /> : null}
          <span className="hidden sm:inline">{me.user.githubLogin ? `@${me.user.githubLogin}` : me.user.name}</span>
          <IconButton label="Sign out" onClick={onSignOut}>
            <LogOut className="size-4" />
          </IconButton>
        </div>
      </header>

      <main className="mx-auto max-w-xl px-4 pt-10 pb-20">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Set up your project map</h1>
        <p className="mt-2 text-[15px] text-zinc-600">Connect one GitHub repository, or join a teammate’s project.</p>

        {me.invitations.length > 0 ? (
          <section className="mt-8 space-y-2">
            {me.invitations.map((invitation) => (
              <div key={invitation.id} className="animate-in flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-indigo-200">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                  <Mail className="size-4.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-900">
                    {invitation.project.owner}/{invitation.project.name}
                  </p>
                  <p className="truncate text-xs text-zinc-500">{invitation.invitedBy ? `@${invitation.invitedBy} invited you` : "You were invited"}</p>
                </div>
                <Button variant="primary" size="sm" loading={joining === invitation.id} onClick={() => void join(invitation.id)}>
                  Join
                </Button>
              </div>
            ))}
            <ErrorNote>{joinError}</ErrorNote>
          </section>
        ) : null}

        <form onSubmit={(event) => void connect(event)} className="mt-8 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-200">
          <div className="flex items-center gap-2">
            <GithubMark className="size-5 text-zinc-800" />
            <h2 className="text-base font-semibold text-zinc-900">Connect a repository</h2>
          </div>
          <ol className="mt-4 space-y-3 text-sm text-zinc-600">
            <li className="flex gap-3">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600">1</span>
              <span>
                Install the project’s GitHub App on the repository
                {installUrl ? (
                  <>
                    {" "}
                    (
                    <a href={installUrl} target="_blank" rel="noreferrer" className="font-medium text-indigo-600 hover:text-indigo-500">
                      install
                    </a>
                    )
                  </>
                ) : null}
                . It only reads pull requests and Actions runs.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600">2</span>
              <span>Enter the repository below.</span>
            </li>
          </ol>
          <div className="mt-5 flex gap-2">
            <input
              value={repository}
              onChange={(event) => {
                setRepository(event.target.value);
                setError(null);
              }}
              placeholder="owner/repository or GitHub URL"
              aria-label="GitHub repository"
              autoFocus
              className={cx(inputClass, "h-10")}
            />
            <Button type="submit" variant="primary" className="h-10 shrink-0" loading={busy} disabled={!parsed} icon={<ArrowRight className="size-4" />}>
              Connect
            </Button>
          </div>
          {error ? (
            <div className="mt-3">
              <ErrorNote>{error}</ErrorNote>
            </div>
          ) : null}
          <p className="mt-4 text-xs leading-relaxed text-zinc-500">
            Tracking starts when you connect. Earlier pull requests, workflow runs and agent sessions are not imported; an existing pull request appears after
            its next update.
          </p>
        </form>
      </main>
    </div>
  );
}
