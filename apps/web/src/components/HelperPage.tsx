import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  addHelperFolder,
  api,
  errorMessage,
  pairLocalHelper,
  readHelperOverview,
  removeHelperFolder,
  removeHelperPairing,
  scanHelper,
  type HelperFolder,
  type HelperOverview,
  type HelperPairing,
  type HelperProjectStatus,
  type HelperStatus,
} from "../api";
import { agentLabel, formatDateTime } from "../format";
import { supabase } from "../supabase";
import { LogoMark } from "./GithubMark";
import { cx } from "./helpers";
import { useToast } from "./toast-context";
import { AgentBadge, Button, ErrorNote, Field, Spinner, inputClass } from "./ui";

/** Names for pairings saved before the helper recorded them, read from the signed-in account when there is one. */
function useProjectNames(): Map<string, string> {
  const [names, setNames] = useState(() => new Map<string, string>());
  useEffect(() => {
    let cancelled = false;
    void supabase?.auth.getSession().then(async ({ data }) => {
      const token = data.session?.access_token;
      if (!token) {
        return;
      }
      const list = await api.projects(token).catch(() => null);
      if (!cancelled && list) {
        setNames(new Map(list.projects.map((project) => [project.id, `${project.owner}/${project.name}`])));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return names;
}

export function HelperPage() {
  const toast = useToast();
  const names = useProjectNames();
  const focusId = new URLSearchParams(window.location.search).get("project");
  const [overview, setOverview] = useState<HelperOverview | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [scanning, setScanning] = useState(false);

  const reload = useCallback(async () => {
    const next = await readHelperOverview();
    setOverview(next);
    return next;
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(timer);
  }, [reload]);

  async function run(action: () => Promise<void>, success: string, fallback: string): Promise<boolean> {
    setError(null);
    try {
      await action();
      await reload();
      toast(success);
      return true;
    } catch (reason) {
      setError(errorMessage(reason, fallback));
      return false;
    }
  }

  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const code = String(data.get("code") ?? "").trim();
    const apiUrl = String(data.get("apiUrl") ?? "").trim();
    setPairing(true);
    if (await run(() => pairLocalHelper(code, apiUrl), "Project connected.", "Pairing failed.")) {
      form.reset();
    }
    setPairing(false);
  }

  async function scan() {
    setScanning(true);
    await run(scanHelper, "Scan finished.", "Scan failed.");
    setScanning(false);
  }

  const nameOf = (pairing: Pick<HelperPairing, "projectId" | "projectName">) =>
    pairing.projectName ?? names.get(pairing.projectId) ?? `Project ${pairing.projectId.slice(0, 8)}`;
  const pairings = overview
    ? [...overview.pairings].sort((a, b) => Number(b.projectId === focusId) - Number(a.projectId === focusId))
    : [];
  const pairedIds = new Set(pairings.map((entry) => entry.projectId));
  const orphanFolders = overview ? overview.folders.filter((folder) => folder.enabled && !pairedIds.has(folder.projectId)) : [];

  return (
    <div className="relative min-h-full">
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ backgroundImage: "radial-gradient(#d4d4d8 1.2px, transparent 1.2px)", backgroundSize: "22px 22px" }}
        aria-hidden
      />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-indigo-200/40 blur-3xl" aria-hidden />
      <main className="relative mx-auto w-[min(40rem,calc(100%-2rem))] py-14">
        <header className="mb-6 flex items-start gap-3.5">
          <LogoMark className="size-11 shrink-0" />
          <div>
            <p className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Automatic Project Map</p>
            <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-zinc-900">Local helper</h1>
            <p className="mt-1 text-sm leading-relaxed text-zinc-600">
              Collects Codex, Claude Code, and Cursor sessions on this computer. Each project collects from the folders you choose for it.
            </p>
          </div>
        </header>

        {error ? (
          <div className="mb-3">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}

        {overview === undefined ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : overview === null ? (
          <ErrorNote>The helper is not running on this computer. Start it with npm run dev:helper.</ErrorNote>
        ) : (
          <div className="space-y-3.5">
            {pairings.length === 0 ? (
              <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
                <h2 className="text-sm font-semibold text-zinc-900">No projects yet</h2>
                <p className="mt-1 text-sm leading-relaxed text-zinc-600">
                  Open a project in the web app and use Settings → Local helper → “Connect this computer”, or paste a pairing code below.
                </p>
              </section>
            ) : (
              pairings.map((entry) => (
                <ProjectCard
                  key={entry.projectId}
                  pairing={entry}
                  name={nameOf(entry)}
                  focused={entry.projectId === focusId}
                  status={overview.status?.projects.find((project) => project.projectId === entry.projectId)}
                  folders={overview.folders.filter((folder) => folder.enabled && folder.projectId === entry.projectId)}
                  onAddFolder={(path) => run(() => addHelperFolder(entry.projectId, path), "Folder added.", "Could not add that folder.")}
                  onRemoveFolder={(id) => run(() => removeHelperFolder(id), "Folder removed.", "Could not remove that folder.")}
                  onDisconnect={() =>
                    run(() => removeHelperPairing(entry.projectId), `${nameOf(entry)} disconnected from this computer.`, "Could not disconnect that project.")
                  }
                />
              ))
            )}

            {orphanFolders.length > 0 ? (
              <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-amber-200">
                <h2 className="text-sm font-semibold text-zinc-900">Not collecting</h2>
                <p className="mt-1 text-sm leading-relaxed text-zinc-600">
                  These folders belong to projects this computer is no longer connected to. Connect the project again to collect from them, or remove them.
                </p>
                <ul className="mt-3 divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200">
                  {orphanFolders.map((folder) => (
                    <FolderRow
                      key={folder.id}
                      folder={folder}
                      detail={names.get(folder.projectId) ?? `Project ${folder.projectId.slice(0, 8)}`}
                      onRemove={() => run(() => removeHelperFolder(folder.id), "Folder removed.", "Could not remove that folder.")}
                    />
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
              <h2 className="text-sm font-semibold text-zinc-900">Connect with a code</h2>
              <p className="mt-1 text-sm leading-relaxed text-zinc-600">
                If the web app could not reach this helper, it shows a pairing code. Paste it here. Projects already connected keep collecting.
              </p>
              <form className="mt-4 space-y-3" onSubmit={(event) => void pair(event)}>
                <Field label="Pairing code">
                  <input name="code" required autoComplete="one-time-code" spellCheck={false} placeholder="Paste the code from the web app" className={inputClass} />
                </Field>
                <Field label="API URL">
                  <input name="apiUrl" required spellCheck={false} defaultValue={pairings[0]?.apiUrl ?? "http://127.0.0.1:4000"} className={inputClass} />
                </Field>
                <Button type="submit" variant="secondary" loading={pairing}>
                  Connect
                </Button>
              </form>
            </section>

            <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-900">Collection</h2>
                  <p className="mt-1 text-sm text-zinc-600">Agent logs watched on this computer.</p>
                </div>
                {overview.status ? (
                  <Button size="sm" loading={scanning} onClick={() => void scan()}>
                    Scan now
                  </Button>
                ) : null}
              </div>
              {overview.logRoots.length === 0 ? (
                <p className="mt-3 text-sm text-zinc-500">No agent log directories were found on this computer.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {overview.logRoots.map((root) => (
                    <li key={root.id} className="flex items-center gap-2.5">
                      <AgentBadge source={root.id} size={22} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-900">{agentLabel(root.id)}</p>
                        <p className="font-mono text-xs break-all text-zinc-500">{root.path}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {overview.status ? <TotalRows status={overview.status} /> : null}
            </section>
          </div>
        )}

        <p className="mt-4 text-center text-sm text-zinc-500">
          <a href="/" className="font-medium text-zinc-700 hover:text-indigo-600">
            Back to the map
          </a>
        </p>
      </main>
    </div>
  );
}

function ProjectCard({
  pairing,
  name,
  focused,
  status,
  folders,
  onAddFolder,
  onRemoveFolder,
  onDisconnect,
}: {
  pairing: HelperPairing;
  name: string;
  focused: boolean;
  status: HelperProjectStatus | undefined;
  folders: HelperFolder[];
  onAddFolder: (path: string) => Promise<boolean>;
  onRemoveFolder: (id: string) => Promise<boolean>;
  onDisconnect: () => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const expired = status?.needsPairing === true;
  const tone = expired ? "bg-amber-400" : folders.length === 0 ? "bg-amber-400" : "bg-emerald-500";
  const summary = expired
    ? "The server no longer accepts this computer for this project. Reconnect it from the project’s Settings → Local helper."
    : folders.length === 0
      ? "No folders yet, so no sessions are collected. Add the folder where you work on this project."
      : `Collecting from ${folders.length} folder${folders.length === 1 ? "" : "s"} · last upload ${status?.lastUploadAt ? formatDateTime(status.lastUploadAt) : "not yet"}${status && status.queued > 0 ? ` · ${status.queued} waiting` : ""}`;

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const path = String(new FormData(form).get("path") ?? "").trim();
    setAdding(true);
    if (await onAddFolder(path)) {
      form.reset();
    }
    setAdding(false);
  }

  return (
    <section className={cx("rounded-2xl bg-white p-4 shadow-sm ring-1", focused ? "ring-2 ring-indigo-300" : "ring-zinc-200")}>
      <div className="flex items-start gap-3">
        <span className={cx("mt-1.5 size-2.5 shrink-0 rounded-full", tone)} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-zinc-900">{name}</h2>
          <p className="mt-1 text-sm leading-relaxed text-zinc-600">{summary}</p>
          <p className="mt-0.5 text-xs text-zinc-500">Sessions started after {formatDateTime(pairing.trackingStartedAt)} are collected.</p>
          {status?.lastError && !expired ? <p className="mt-1 text-xs text-rose-600">{status.lastError}</p> : null}
        </div>
        <Button
          size="sm"
          variant="ghost"
          loading={disconnecting}
          onClick={() => {
            setDisconnecting(true);
            void onDisconnect().finally(() => setDisconnecting(false));
          }}
        >
          Disconnect
        </Button>
      </div>

      {folders.length > 0 ? (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200">
          {folders.map((folder) => (
            <FolderRow
              key={folder.id}
              folder={folder}
              removing={removingId === folder.id}
              onRemove={() => {
                setRemovingId(folder.id);
                return onRemoveFolder(folder.id).finally(() => setRemovingId(null));
              }}
            />
          ))}
        </ul>
      ) : null}

      <form className="mt-3 flex gap-2" onSubmit={(event) => void add(event)}>
        <input
          name="path"
          required
          spellCheck={false}
          placeholder="/path/to/your/clone"
          aria-label={`Folder for ${name}`}
          autoFocus={focused && folders.length === 0}
          className={cx(inputClass, "font-mono text-xs")}
        />
        <Button type="submit" variant={folders.length === 0 ? "primary" : "secondary"} className="shrink-0" loading={adding}>
          Add folder
        </Button>
      </form>

      {status && status.paused.length > 0 ? (
        <div className="mt-3">
          <p className="text-sm text-zinc-600">Paused sessions. Their log file was replaced or shortened.</p>
          <ul className="mt-2 space-y-1.5">
            {status.paused.map((item) => (
              <li key={`${item.provider}:${item.sessionId}`} className="flex items-center gap-2 text-sm text-zinc-700">
                <AgentBadge source={item.provider} size={18} />
                <span className="font-mono text-xs">{item.sessionId}</span>
                <span className="text-xs text-zinc-500">{item.reason ?? "paused"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function FolderRow({
  folder,
  detail,
  removing = false,
  onRemove,
}: {
  folder: HelperFolder;
  detail?: string;
  removing?: boolean;
  onRemove: () => Promise<boolean>;
}) {
  return (
    <li className="flex items-center gap-3 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs break-all text-zinc-700">{folder.canonicalPath}</p>
        {detail ? <p className="mt-0.5 text-xs text-zinc-500">{detail}</p> : null}
      </div>
      <Button size="sm" variant="ghost" loading={removing} onClick={() => void onRemove()}>
        Remove
      </Button>
    </li>
  );
}

function TotalRows({ status }: { status: HelperStatus }) {
  const rows: Array<[string, string]> = [
    ["Last scan", status.lastScanAt ? formatDateTime(status.lastScanAt) : "Not yet"],
    ["Last upload", status.lastUploadAt ? formatDateTime(status.lastUploadAt) : "Not yet"],
    ["Waiting to upload", String(status.queued)],
    ["Uploaded since start", String(status.uploaded)],
    ["Dropped since start", String(status.dropped)],
  ];
  if (status.nextUploadAt) {
    rows.push(["Next upload attempt", formatDateTime(status.nextUploadAt)]);
  }
  return (
    <dl className="mt-4 divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-4 px-3.5 py-2.5">
          <dt className="text-sm text-zinc-500">{label}</dt>
          <dd className="text-right text-sm text-zinc-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
