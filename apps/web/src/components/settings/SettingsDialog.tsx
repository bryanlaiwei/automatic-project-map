import { Activity, ChevronDown, Copy, KeyRound, Laptop, Settings2, Trash2, UserPlus, Users, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, errorMessage, pairLocalHelper, readHelperStatus, type HelperStatus, type ModelProviderId, type ModelSetup, type ProjectSettings, type SupplierModel } from "../../api";
import { formatDateTime, timeAgo } from "../../format";
import { ConfirmDialog } from "../corrections/Dialogs";
import { GithubMark } from "../GithubMark";
import { useToast } from "../toast-context";
import { cx, useNow } from "../helpers";
import { Avatar, Button, ErrorNote, Field, IconButton, Spinner, TimeAgo, inputClass } from "../ui";

export type SettingsTab = "general" | "members" | "helper" | "model" | "health";

const tabs: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
  { id: "general", label: "General", icon: <Settings2 className="size-4" /> },
  { id: "members", label: "Members", icon: <Users className="size-4" /> },
  { id: "helper", label: "Local helper", icon: <Laptop className="size-4" /> },
  { id: "model", label: "Model", icon: <KeyRound className="size-4" /> },
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
                {tab === "model" ? <ModelTab token={token} reload={reload} /> : null}
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
      toast("Helper connected. Choose this project’s folders on the helper page.");
    } catch (reason) {
      setError(reason instanceof TypeError ? "The helper is not running on this computer. Start it with npm run dev:helper." : errorMessage(reason, "Pairing failed."));
      setFallbackCode(code);
    } finally {
      setConnecting(false);
    }
  }

  const running = status !== null && status !== undefined;
  const here = running ? status.projects.find((entry) => entry.projectId === settings.project.id) : undefined;
  const others = running ? status.projects.length - (here ? 1 : 0) : 0;
  const connected = here !== undefined && !here.needsPairing;
  const tone = !running ? "bg-zinc-300" : connected && here.selectedFolders > 0 ? "bg-emerald-500" : "bg-amber-400";

  return (
    <div className="space-y-7">
      <div className="rounded-xl p-4 ring-1 ring-zinc-200">
        <div className="flex items-start gap-3">
          <span className={cx("mt-1.5 size-2.5 shrink-0 rounded-full", tone)} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-zinc-900">This computer</p>
            <p className="mt-0.5 text-sm text-zinc-500">
              {status === undefined
                ? "Checking for the helper…"
                : !running
                  ? "The helper is not running. Start it with npm run dev:helper to collect Codex, Claude Code and Cursor sessions."
                  : !here
                    ? `Running, but not connected to this project yet.${others > 0 ? ` It keeps collecting for ${others} other project${others === 1 ? "" : "s"}.` : ""}`
                    : here.needsPairing
                      ? "The server no longer accepts this computer for this project. Reconnect it."
                      : here.selectedFolders === 0
                        ? "Connected, but no folders are chosen for this project, so no sessions are collected yet."
                        : `${here.selectedFolders} folder${here.selectedFolders === 1 ? "" : "s"} selected · last upload ${timeAgo(here.lastUploadAt, now)}${here.queued > 0 ? ` · ${here.queued} waiting` : ""}`}
            </p>
            {here?.lastError ? <p className="mt-1 text-xs text-rose-600">{here.lastError}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant={connected ? "secondary" : "primary"} loading={connecting} onClick={() => void connect()}>
                {here ? "Reconnect" : "Connect this computer"}
              </Button>
              {connected ? (
                <a
                  href={`/helper?project=${encodeURIComponent(settings.project.id)}`}
                  className={cx(
                    "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium",
                    here.selectedFolders === 0
                      ? "bg-indigo-600 text-white shadow-sm hover:bg-indigo-500"
                      : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
                  )}
                >
                  Choose folders
                </a>
              ) : null}
            </div>
            {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
            {fallbackCode ? (
              <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm text-zinc-600">
                If the helper runs on another computer, open the helper page there and paste this code:
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
                    {device.lastSeenAt ? `Last seen ${timeAgo(device.lastSeenAt, now)}` : "Not seen since connecting"} · connected {timeAgo(device.createdAt, now)}
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

function providerLabel(provider: "openai" | "anthropic" | "gemini" | null): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Gemini";
    case null:
      return "saved";
    default: {
      const unhandled: never = provider;
      return unhandled;
    }
  }
}

function modelSourceLine(model: ProjectSettings["health"]["analysis"]["model"]): string {
  switch (model.source) {
    case "owner":
      return `Using an owner's ${providerLabel(model.provider)} key.`;
    case "server":
      return "Using the server OpenAI key. An owner can replace it from the Model tab.";
    case "none":
      return "No model key yet. An owner can add one in the Model tab.";
    default: {
      const unhandled: never = model.source;
      return unhandled;
    }
  }
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
            {waitingMinutes > 5
              ? analysis.model.source === "none"
                ? " Add a model key in the Model tab, and make sure the worker is running."
                : " The worker may not be running."
              : ""}
          </p>
        ) : (
          <p>Nothing is waiting.</p>
        )}
        <p>{analysis.lastAnalyzedAt ? `Last analyzed ${timeAgo(analysis.lastAnalyzedAt, now)}.` : "Nothing has been analyzed yet."}</p>
        <p>{modelSourceLine(analysis.model)}</p>
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

function ModelTab({ token, reload }: { token: string; reload: () => Promise<void> }) {
  const toast = useToast();
  const [setup, setSetup] = useState<ModelSetup | null>(null);
  const [provider, setProvider] = useState<ModelProviderId>("openai");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<SupplierModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .modelSetup(token)
      .then((value) => {
        if (cancelled) {
          return;
        }
        setSetup(value);
        setProvider(value.credential?.provider ?? "openai");
        setModel(value.credential?.model ?? "");
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(errorMessage(reason, "Could not load the model key."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!setup) {
      return;
    }
    const typed = apiKey.trim();
    const useSaved = typed === "" && setup.credential?.provider === provider;
    if (typed.length < 12 && !useSaved) {
      setModels([]);
      setModelsLoading(false);
      setModelsError(null);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    const handle = window.setTimeout(() => {
      void api
        .supplierModels(token, { provider, apiKey: typed })
        .then((value) => {
          if (cancelled) {
            return;
          }
          const saved = setup.credential?.provider === provider ? setup.credential.model : null;
          const next = saved && !value.models.some((item) => item.id === saved) ? [{ id: saved, label: saved }, ...value.models] : value.models;
          setModels(next);
          setModel((current) => {
            if (next.some((item) => item.id === current)) {
              return current;
            }
            if (saved && next.some((item) => item.id === saved)) {
              return saved;
            }
            const preferred = setup.providers.find((entry) => entry.id === provider)?.defaultModel;
            if (preferred && next.some((item) => item.id === preferred)) {
              return preferred;
            }
            return next[0]?.id ?? "";
          });
          setModelsError(null);
        })
        .catch((reason: unknown) => {
          if (cancelled) {
            return;
          }
          setModels([]);
          setModelsError(errorMessage(reason, "Could not load models."));
        })
        .finally(() => {
          if (!cancelled) {
            setModelsLoading(false);
          }
        });
    }, typed === "" ? 0 : 400);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [apiKey, provider, setup, token]);

  const selected = setup?.providers.find((entry) => entry.id === provider);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveModelCredential(token, { provider, apiKey, model });
      setSetup((current) => (current ? { ...current, credential: saved } : current));
      setApiKey("");
      setShowKey(false);
      setModel(saved.model);
      await reload();
      toast("Model key saved");
    } catch (reason) {
      setError(errorMessage(reason, "Could not save the model key."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteModelCredential(token);
      setSetup((current) => (current ? { ...current, credential: null } : current));
      setApiKey("");
      setModel("");
      setModels([]);
      await reload();
      toast("Model key removed");
    } catch (reason) {
      setError(errorMessage(reason, "Could not remove the model key."));
    } finally {
      setBusy(false);
    }
  }

  if (!setup && !error) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm leading-relaxed text-zinc-500">
        Grouping work into the map uses a model key you provide. OpenAI, Anthropic, and Gemini are supported. The key is stored encrypted, and only its last
        four characters are shown again. Repositories you own are analyzed with your key. When several owners have saved one, the key saved most recently is
        used.
        {setup?.serverFallback
          ? " If no owner has saved a key, analysis uses the server OpenAI key."
          : " If no owner has saved a key, analysis waits until one is added."}
      </p>
      {setup?.credential ? (
        <div className="flex items-start justify-between gap-4 rounded-xl p-4 ring-1 ring-zinc-200">
          <div>
            <p className="text-sm font-medium text-zinc-900">
              {providerLabel(setup.credential.provider)}
              <span className="font-normal text-zinc-500"> · key ending in {setup.credential.hint}</span>
            </p>
            <p className="mt-0.5 text-sm text-zinc-500">
              Model {setup.credential.model} · updated <TimeAgo iso={setup.credential.updatedAt} />
            </p>
          </div>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
            Remove
          </Button>
        </div>
      ) : null}
      {setup ? (
        <form onSubmit={(event) => void save(event)} className="space-y-4">
          <Field label="Supplier" hint={selected?.keyHint}>
            <div className="relative">
              <select
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value as ModelProviderId);
                  setModel("");
                  setModels([]);
                }}
                className={cx(inputClass, "appearance-none pr-9")}
              >
                {setup.providers.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-zinc-400" />
            </div>
          </Field>
          <Field
            label="Model"
            hint={
              modelsLoading
                ? "Loading models from this supplier."
                : models.length > 0
                  ? "Models from this supplier that can generate text."
                  : "Paste an API key to load this supplier's models."
            }
          >
            <div className="relative">
              <select
                value={models.some((item) => item.id === model) ? model : ""}
                onChange={(event) => setModel(event.target.value)}
                disabled={modelsLoading || models.length === 0}
                className={cx(inputClass, "appearance-none pr-9 disabled:bg-zinc-50 disabled:text-zinc-500")}
              >
                {models.length === 0 ? (
                  <option value="">{modelsLoading ? "Loading models…" : "Paste an API key to load models"}</option>
                ) : (
                  models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label === item.id ? item.id : `${item.label} (${item.id})`}
                    </option>
                  ))
                )}
              </select>
              <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-zinc-400" />
            </div>
          </Field>
          <Field label="API key" hint={setup.credential ? `Paste a new key to replace the one ending in ${setup.credential.hint}.` : "Paste the key from the supplier."}>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className={cx(inputClass, "pr-16")}
              />
              <button
                type="button"
                onClick={() => setShowKey((value) => !value)}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-xs font-medium text-zinc-500 hover:text-zinc-800"
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
          </Field>
          <ErrorNote>{modelsError}</ErrorNote>
          <ErrorNote>{error}</ErrorNote>
          <Button type="submit" variant="primary" loading={busy} disabled={apiKey.trim() === "" || model === "" || modelsLoading}>
            Save key
          </Button>
        </form>
      ) : (
        <ErrorNote>{error}</ErrorNote>
      )}
    </div>
  );
}
