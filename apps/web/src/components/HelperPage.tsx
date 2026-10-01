import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  addHelperFolder,
  errorMessage,
  pairLocalHelper,
  readHelperOverview,
  removeHelperFolder,
  scanHelper,
  type HelperOverview,
} from "../api";
import { agentLabel, formatDateTime } from "../format";
import { LogoMark } from "./GithubMark";
import { useToast } from "./toast-context";
import { AgentBadge, Button, ErrorNote, Field, Spinner, inputClass } from "./ui";

export function HelperPage() {
  const toast = useToast();
  const [overview, setOverview] = useState<HelperOverview | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const next = await readHelperOverview();
    setOverview(next);
    return next;
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const code = String(data.get("code") ?? "").trim();
    const apiUrl = String(data.get("apiUrl") ?? "").trim();
    setPairing(true);
    setError(null);
    try {
      await pairLocalHelper(code, apiUrl);
      await reload();
      toast("Helper paired.");
    } catch (reason) {
      setError(errorMessage(reason, "Pairing failed."));
    } finally {
      setPairing(false);
    }
  }

  async function addFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const path = String(data.get("path") ?? "").trim();
    setAdding(true);
    setError(null);
    try {
      await addHelperFolder(path);
      form.reset();
      await reload();
      toast("Folder added.");
    } catch (reason) {
      setError(errorMessage(reason, "Could not add that folder."));
    } finally {
      setAdding(false);
    }
  }

  async function removeFolder(id: string) {
    setRemovingId(id);
    setError(null);
    try {
      await removeHelperFolder(id);
      await reload();
      toast("Folder removed.");
    } catch (reason) {
      setError(errorMessage(reason, "Could not remove that folder."));
    } finally {
      setRemovingId(null);
    }
  }

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      await scanHelper();
      await reload();
      toast("Scan finished.");
    } catch (reason) {
      setError(errorMessage(reason, "Scan failed."));
    } finally {
      setScanning(false);
    }
  }

  const paired = overview?.pairing ?? null;
  const needsPairing = !paired || overview?.status?.needsPairing === true;
  const tone = !paired ? "bg-zinc-300" : overview?.status?.needsPairing ? "bg-amber-400" : "bg-emerald-500";
  const title = !paired ? "Not connected" : overview?.status?.needsPairing ? "Connection expired" : "Connected";

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
              Collects Codex, Claude Code, and Cursor sessions from folders you choose on this computer.
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
            <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
              <div className="flex items-start gap-3">
                <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${tone}`} />
                <div>
                  <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
                  {paired && !overview.status?.needsPairing ? (
                    <p className="mt-1 text-sm leading-relaxed text-zinc-600">
                      Paired to project <code className="font-mono text-xs text-zinc-700">{paired.projectId}</code>.
                      <span className="mt-0.5 block">Tracking started {formatDateTime(paired.trackingStartedAt)}.</span>
                    </p>
                  ) : (
                    <p className="mt-1 text-sm leading-relaxed text-zinc-600">
                      {paired
                        ? "The server no longer accepts this helper’s token. Connect it again from the web app, or paste a new code."
                        : "Not paired yet. Use “Connect this computer” in the web app, or paste a pairing code here."}
                    </p>
                  )}
                </div>
              </div>
              {needsPairing ? (
                <form className="mt-4 space-y-3" onSubmit={(event) => void pair(event)}>
                  <Field label="Pairing code">
                    <input name="code" required autoComplete="one-time-code" spellCheck={false} placeholder="Paste the code from the web app" className={inputClass} />
                  </Field>
                  <Field label="API URL">
                    <input name="apiUrl" required spellCheck={false} defaultValue={paired?.apiUrl ?? "http://127.0.0.1:4000"} className={inputClass} />
                  </Field>
                  <Button type="submit" variant="primary" loading={pairing}>
                    Pair
                  </Button>
                </form>
              ) : null}
            </section>

            <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
              <h2 className="text-sm font-semibold text-zinc-900">Folders</h2>
              <p className="mt-1 text-sm leading-relaxed text-zinc-600">Only sessions whose working folder is inside one of these folders are uploaded.</p>
              {overview.folders.length === 0 ? (
                <p className="mt-3 text-sm text-zinc-500">No folders yet. Add a project directory and only sessions inside it are uploaded.</p>
              ) : (
                <ul className="mt-3 divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200">
                  {overview.folders.map((folder) => (
                    <li key={folder.id} className="flex items-center gap-3 px-3.5 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-xs break-all text-zinc-700">{folder.canonicalPath}</p>
                        {folder.enabled ? null : <p className="mt-0.5 text-xs text-zinc-500">Paused</p>}
                      </div>
                      <Button size="sm" variant="ghost" loading={removingId === folder.id} onClick={() => void removeFolder(folder.id)}>
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {paired ? (
                <form className="mt-4 space-y-3" onSubmit={(event) => void addFolder(event)}>
                  <Field label="Folder path">
                    <input name="path" required spellCheck={false} placeholder="/path/to/project" className={inputClass} />
                  </Field>
                  <Button type="submit" variant="primary" loading={adding}>
                    Add folder
                  </Button>
                </form>
              ) : (
                <p className="mt-3 text-sm text-zinc-500">Pair this computer before choosing folders.</p>
              )}
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
              {overview.status ? <StatusRows status={overview.status} /> : null}
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

function StatusRows({ status }: { status: NonNullable<HelperOverview["status"]> }) {
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
    <>
      <dl className="mt-4 divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 px-3.5 py-2.5">
            <dt className="text-sm text-zinc-500">{label}</dt>
            <dd className="text-right text-sm text-zinc-900">{value}</dd>
          </div>
        ))}
      </dl>
      {status.lastError ? (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200 ring-inset">Last problem: {status.lastError}</p>
      ) : null}
      {status.paused.length > 0 ? (
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
    </>
  );
}
