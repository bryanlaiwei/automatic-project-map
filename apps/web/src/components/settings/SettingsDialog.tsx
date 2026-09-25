import { Activity, Copy, ExternalLink, Laptop, Settings2, Trash2, UserPlus, Users, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, errorMessage, helperUrl, pairLocalHelper, readHelperStatus, type HelperStatus, type ProjectSettings } from "../../api";
import { formatDateTime, timeAgo } from "../../format";
import { ConfirmDialog } from "../corrections/Dialogs";
import { GithubMark } from "../GithubMark";
import { useToast } from "../toast-context";
import { cx, useNow } from "../helpers";
import { Avatar, Button, ErrorNote, IconButton, Spinner, TimeAgo, inputClass } from "../ui";

export type SettingsTab = "general" | "members" | "helper" | "health";

const tabs: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
  { id: "general", label: "General", icon: <Settings2 className="size-4" /> },
  { id: "members", label: "Members", icon: <Users className="size-4" /> },
  { id: "helper", label: "Local helper", icon: <Laptop className="size-4" /> },
  { id: "health", label: "Health", icon: <Activity className="size-4" /> },
];

export function SettingsDialog({
  token,
  projectId,
  tab,
  onTab,
  onClose,
  onProjectDeleted,
  onLeft,
}: {
  token: string;
  projectId: string;
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
  onProjectDeleted: () => void;
  onLeft: () => void;
}) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSettings(await api.settings(token, projectId));
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason, "Could not load settings."));
    }
  }, [token, projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"]:not([data-settings])')) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-zinc-950/30 p-4 pt-[8vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-settings
        onMouseDown={(event) => event.stopPropagation()}
        className="animate-in flex h-[min(640px,84vh)] w-full max-w-3xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-zinc-200"
      >
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-zinc-100 bg-zinc-50/60 p-3">
          <p className="px-2.5 pt-1 pb-3 text-sm font-semibold text-zinc-900">Settings</p>
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onTab(entry.id)}
              className={cx(
                "flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                tab === entry.id ? "bg-white font-medium text-zinc-900 shadow-sm ring-1 ring-zinc-200" : "text-zinc-600 hover:bg-white/70 hover:text-zinc-900",
              )}
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-100 pr-3 pl-6">
            <h2 className="text-base font-semibold text-zinc-900">{tabs.find((entry) => entry.id === tab)?.label}</h2>
            <IconButton label="Close settings" onClick={onClose}>
              <X className="size-4" />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            {!settings && !error ? (
              <div className="flex h-40 items-center justify-center">
                <Spinner />
              </div>
            ) : null}
            {settings ? (
              <>
                {tab === "general" ? <GeneralTab token={token} settings={settings} onDeleted={onProjectDeleted} /> : null}
                {tab === "members" ? <MembersTab token={token} settings={settings} reload={reload} onLeft={onLeft} /> : null}
                {tab === "helper" ? <HelperTab token={token} settings={settings} reload={reload} /> : null}
                {tab === "health" ? <HealthTab settings={settings} /> : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-zinc-100 py-3.5 last:border-0">
      <span className="text-sm text-zinc-500">{label}</span>
      <span className="text-right text-sm text-zinc-900">{children}</span>
    </div>
  );
}

function GeneralTab({ token, settings, onDeleted }: { token: string; settings: ProjectSettings; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const repo = `${settings.project.owner}/${settings.project.name}`;
  return (
    <div className="space-y-8">
      <div>
        <Row label="Repository">
          <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium hover:text-indigo-600">
            <GithubMark className="size-4" />
            {repo}
          </a>
        </Row>
        <Row label="Tracking since">{formatDateTime(settings.project.trackingStartedAt)}</Row>
        <Row label="Your role">{settings.role === "owner" ? "Owner" : "Member"}</Row>
      </div>
      <p className="text-sm leading-relaxed text-zinc-500">
        Only activity after tracking started is collected: new pull request and Actions updates, and agent sessions created after that time in the folders
        you choose on each computer.
      </p>
      {settings.role === "owner" ? (
        <div className="rounded-xl p-4 ring-1 ring-rose-200">
          <h3 className="text-sm font-semibold text-rose-700">Delete project</h3>
          <p className="mt-1 text-sm text-zinc-600">Removes the map, its evidence and history, and everyone’s access. Connected helpers stop uploading.</p>
          <Button variant="danger" size="sm" className="mt-3" icon={<Trash2 className="size-4" />} onClick={() => setConfirming(true)}>
            Delete project
          </Button>
        </div>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          open
          onClose={() => setConfirming(false)}
          title="Delete this project?"
          description="This cannot be undone. The GitHub repository itself is not touched."
          confirmLabel="Delete project"
          danger
          requireText={repo}
          onConfirm={async () => {
            await api.deleteProject(token, settings.project.id);
            onDeleted();
          }}
        />
      ) : null}
    </div>
  );
}

function MembersTab({ token, settings, reload, onLeft }: { token: string; settings: ProjectSettings; reload: () => Promise<void>; onLeft: () => void }) {
  const toast = useToast();
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProjectSettings["members"][number] | null>(null);
  const owner = settings.role === "owner";

  async function invite(event: FormEvent) {
    event.preventDefault();
    const name = login.trim().replace(/^@/, "");
    if (!name) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.invite(token, settings.project.id, name);
      setLogin("");
      await reload();
      toast(`Invited @${name}`);
    } catch (reason) {
      setError(errorMessage(reason, "Could not send the invitation."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-7">
      {owner ? (
        <form onSubmit={(event) => void invite(event)} className="space-y-2">
          <label className="block text-sm font-medium text-zinc-800" htmlFor="invite-login">
            Invite a teammate
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-zinc-400">@</span>
              <input
                id="invite-login"
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                placeholder="github-username"
                autoComplete="off"
                className={cx(inputClass, "pl-7")}
              />
            </div>
            <Button type="submit" variant="primary" icon={<UserPlus className="size-4" />} loading={busy} disabled={login.trim() === ""}>
              Invite
            </Button>
          </div>
          <p className="text-xs text-zinc-500">They sign in here with that GitHub account and accept the invitation. Members see the same map.</p>
          <ErrorNote>{error}</ErrorNote>
        </form>
      ) : null}

      <div>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">People</h3>
        <ul className="divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200">
          {settings.members.map((member) => (
            <li key={member.userId} className="flex items-center gap-3 px-3.5 py-3">
              {member.githubLogin ? <Avatar login={member.githubLogin} src={member.avatarUrl} size={32} /> : <span className="size-8 rounded-full bg-zinc-200" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-900">
                  {member.name ?? (member.githubLogin ? `@${member.githubLogin}` : "Unknown member")}
                  {member.you ? <span className="ml-1.5 text-xs font-normal text-zinc-400">(you)</span> : null}
                </p>
                <p className="truncate text-xs text-zinc-500">
                  {member.githubLogin && member.name ? `@${member.githubLogin} · ` : ""}joined <TimeAgo iso={member.joinedAt} />
                </p>
              </div>
              <span
                className={cx(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  member.role === "owner" ? "bg-indigo-50 text-indigo-700" : "bg-zinc-100 text-zinc-600",
                )}
              >
                {member.role === "owner" ? "Owner" : "Member"}
              </span>
              {(owner && !member.you) || (member.you && member.role !== "owner") ? (
                <Button size="sm" variant="ghost" onClick={() => setRemoving(member)}>
                  {member.you ? "Leave" : "Remove"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {settings.invitations.length > 0 ? (
        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Waiting to accept</h3>
          <ul className="divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200">
            {settings.invitations.map((invitation) => (
              <li key={invitation.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <Avatar login={invitation.githubLogin} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-900">@{invitation.githubLogin}</p>
                  <p className="truncate text-xs text-zinc-500">
                    Invited {invitation.invitedBy ? `by @${invitation.invitedBy} ` : ""}
                    <TimeAgo iso={invitation.createdAt} />
                  </p>
                </div>
                {owner ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void api
                        .revokeInvitation(token, settings.project.id, invitation.id)
                        .then(reload)
                        .then(() => toast("Invitation revoked"))
                        .catch((reason: unknown) => toast(errorMessage(reason, "Could not revoke the invitation."), "error"))
                    }
                  >
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {removing ? (
        <ConfirmDialog
          open
          onClose={() => setRemoving(null)}
          title={removing.you ? "Leave this project?" : `Remove ${removing.githubLogin ? `@${removing.githubLogin}` : "this member"}?`}
          description={
            removing.you
              ? "You lose access to the map. Helpers you connected stop uploading."
              : "They lose access to the map, and helpers they connected stop uploading. Their past activity stays on the map."
          }
          confirmLabel={removing.you ? "Leave project" : "Remove"}
          danger
          onConfirm={async () => {
            await api.removeMember(token, settings.project.id, removing.userId);
            if (removing.you) {
              onLeft();
              return;
            }
            await reload();
            toast("Member removed");
          }}
        />
      ) : null}
    </div>
  );
}

function HelperTab({ token, settings, reload }: { token: string; settings: ProjectSettings; reload: () => Promise<void> }) {
  const toast = useToast();
  const [status, setStatus] = useState<HelperStatus | null | undefined>(undefined);
  const [connecting, setConnecting] = useState(false);
  const [fallbackCode, setFallbackCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(10_000);

  useEffect(() => {
    let cancelled = false;
    const check = () =>
      void readHelperStatus().then((next) => {
        if (!cancelled) {
          setStatus(next);
        }
      });
    check();
    const timer = window.setInterval(check, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function connect() {
    setConnecting(true);
    setError(null);
    setFallbackCode(null);
    let code: string;
    try {
      code = (await api.pairingCode(token, settings.project.id)).code;
    } catch (reason) {
      setError(errorMessage(reason, "Could not create a pairing code."));
      setConnecting(false);
      return;
    }
    try {
      await pairLocalHelper(code);
      setStatus(await readHelperStatus());
      await reload();
      toast("Helper connected. Choose folders on the helper page.");
    } catch (reason) {
      setError(reason instanceof TypeError ? "The helper is not running on this computer. Start it with npm run dev:helper." : errorMessage(reason, "Pairing failed."));
      setFallbackCode(code);
    } finally {
      setConnecting(false);
    }
  }

  const running = status !== null && status !== undefined;

  return (
    <div className="space-y-7">
      <div className="rounded-xl p-4 ring-1 ring-zinc-200">
        <div className="flex items-start gap-3">
          <span className={cx("mt-1.5 size-2.5 shrink-0 rounded-full", running ? (status.paired ? "bg-emerald-500" : "bg-amber-400") : "bg-zinc-300")} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-zinc-900">This computer</p>
            <p className="mt-0.5 text-sm text-zinc-500">
              {status === undefined
                ? "Checking for the helper…"
                : !running
                  ? "The helper is not running. Start it with npm run dev:helper to collect Codex, Claude Code and Cursor sessions."
                  : status.paired
                    ? `${status.selectedFolders} folder${status.selectedFolders === 1 ? "" : "s"} selected · last upload ${timeAgo(status.lastUploadAt, now)}${status.queued > 0 ? ` · ${status.queued} waiting` : ""}`
                    : "Running, but not connected to a project yet."}
            </p>
            {running && status.lastError ? <p className="mt-1 text-xs text-rose-600">{status.lastError}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant={running && status.paired ? "secondary" : "primary"} loading={connecting} onClick={() => void connect()}>
                {running && status.paired ? "Reconnect" : "Connect this computer"}
              </Button>
              <a
                href={helperUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
              >
                Choose folders <ExternalLink className="size-3.5" />
              </a>
            </div>
            {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
            {fallbackCode ? (
              <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm text-zinc-600">
                If the helper runs somewhere this page cannot reach, paste this code on its page:
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-white px-2 py-1 font-mono text-xs ring-1 ring-zinc-200">{fallbackCode}</code>
                  <IconButton label="Copy code" onClick={() => void navigator.clipboard.writeText(fallbackCode).then(() => toast("Code copied"))}>
                    <Copy className="size-4" />
                  </IconButton>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Connected helpers</h3>
        {settings.devices.length === 0 ? (
          <p className="text-sm text-zinc-500">No helpers are connected. GitHub activity still appears without one.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200">
            {settings.devices.map((device) => (
              <li key={device.id} className="flex items-center gap-3 px-3.5 py-3">
                <Laptop className="size-5 shrink-0 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-900">
                    {device.label}
                    {device.pairedBy ? <span className="font-normal text-zinc-500"> · @{device.pairedBy}</span> : null}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {device.lastSeenAt ? `Last upload ${timeAgo(device.lastSeenAt, now)}` : "No uploads yet"} · connected {timeAgo(device.createdAt, now)}
                  </p>
                </div>
                {device.yours || settings.role === "owner" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void api
                        .revokeDevice(token, settings.project.id, device.id)
                        .then(reload)
                        .then(() => toast("Helper disconnected"))
                        .catch((reason: unknown) => toast(errorMessage(reason, "Could not disconnect the helper."), "error"))
                    }
                  >
                    Disconnect
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function HealthItem({ tone, title, children }: { tone: "good" | "warn" | "bad" | "idle"; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl p-4 ring-1 ring-zinc-200">
      <span
        className={cx(
          "mt-1.5 size-2.5 shrink-0 rounded-full",
          tone === "good" && "bg-emerald-500",
          tone === "warn" && "bg-amber-400",
          tone === "bad" && "bg-rose-500",
          tone === "idle" && "bg-zinc-300",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-zinc-900">{title}</p>
        <div className="mt-0.5 space-y-0.5 text-sm text-zinc-500">{children}</div>
      </div>
    </div>
  );
}

function HealthTab({ settings }: { settings: ProjectSettings }) {
  const now = useNow(10_000);
  const { github, local, analysis } = settings.health;
  const waitingMinutes = analysis.waitingSince ? (now - Date.parse(analysis.waitingSince)) / 60_000 : 0;
  const analysisTone = analysis.lastFailure || waitingMinutes > 5 ? "warn" : analysis.waiting > 0 ? "good" : analysis.lastAnalyzedAt ? "good" : "idle";
  return (
    <div className="space-y-3">
      <HealthItem tone={github.failedDeliveries > 0 ? "warn" : github.lastDeliveryAt ? "good" : "idle"} title="GitHub">
        <p>{github.lastDeliveryAt ? `Last webhook received ${timeAgo(github.lastDeliveryAt, now)}.` : "No webhooks received yet."}</p>
        {github.waitingDeliveries > 0 ? <p>{github.waitingDeliveries} deliveries are waiting to be processed.</p> : null}
        {github.failedDeliveries > 0 ? <p className="text-amber-700">{github.failedDeliveries} deliveries failed after several attempts.</p> : null}
      </HealthItem>
      <HealthItem tone={local.lastSessionEventAt ? "good" : "idle"} title="Agent sessions">
        <p>{local.lastSessionEventAt ? `Last session activity received ${timeAgo(local.lastSessionEventAt, now)}.` : "No session activity received yet."}</p>
      </HealthItem>
      <HealthItem tone={analysisTone} title="AI analysis">
        {analysis.waiting > 0 ? (
          <p>
            {analysis.waiting} update{analysis.waiting === 1 ? "" : "s"} waiting since {timeAgo(analysis.waitingSince, now)}.
            {waitingMinutes > 5 ? " The worker may not be running, or OPENAI_API_KEY may be missing." : ""}
          </p>
        ) : (
          <p>Nothing is waiting.</p>
        )}
        <p>{analysis.lastAnalyzedAt ? `Last analyzed ${timeAgo(analysis.lastAnalyzedAt, now)}.` : "Nothing has been analyzed yet."}</p>
        {analysis.lastFailure ? (
          <p className="text-amber-700">
            Last attempt failed {timeAgo(analysis.lastFailure.at, now)}: {analysis.lastFailure.error}
          </p>
        ) : null}
        {analysis.gaveUp > 0 ? <p className="text-amber-700">{analysis.gaveUp} updates could not be analyzed after several attempts.</p> : null}
      </HealthItem>
    </div>
  );
}
