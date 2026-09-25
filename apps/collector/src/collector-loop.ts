import { homedir } from "node:os";
import { join } from "node:path";
import { ChangeTracker } from "./change-tracker.js";
import { runCollectionPass, type AgentId, type LogRoots } from "./collect-pass.js";
import { createFetchEventTransport, flushOutbox, type EventUploadTransport } from "./flush.js";
import type { LocalDb, PairingRecord } from "./local-db.js";

export const defaultScanIntervalMs = 30_000;
const maxUploadBackoffMs = 5 * 60_000;

export type CollectorStatus = {
  paired: boolean;
  needsPairing: boolean;
  selectedFolders: number;
  lastScanAt: string | null;
  lastUploadAt: string | null;
  queued: number;
  uploaded: number;
  dropped: number;
  paused: Array<{ provider: string; sessionId: string; reason: string | null }>;
  lastError: string | null;
  nextUploadAt: string | null;
};

export function defaultLogRoots(env: NodeJS.ProcessEnv, home: string = homedir()): LogRoots {
  const roots: LogRoots = {
    codex: env.APM_CODEX_SESSIONS?.trim() || join(home, ".codex", "sessions"),
    claude_code: env.APM_CLAUDE_PROJECTS?.trim() || join(home, ".claude", "projects"),
  };
  const cursor = env.APM_CURSOR_SESSIONS?.trim();
  if (cursor) {
    roots.cursor = cursor;
  }
  return roots;
}

export function describeLogRoots(roots: LogRoots): string[] {
  const agents: AgentId[] = ["codex", "claude_code", "cursor"];
  return agents.flatMap((agent) => {
    const root = roots[agent];
    return root ? [`${agent}: ${root}`] : [];
  });
}

export function uploadBackoffMs(failures: number): number {
  if (failures <= 0) {
    return 0;
  }
  return Math.min(5_000 * 2 ** (failures - 1), maxUploadBackoffMs);
}

export class CollectorLoop {
  private readonly changes = new ChangeTracker();
  private readonly transportFor: (pairing: PairingRecord) => EventUploadTransport;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private failures = 0;
  private nextUploadAt = 0;
  private pairedDevice: string | null = null;
  private running: Promise<CollectorStatus> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: CollectorStatus = {
    paired: false,
    needsPairing: false,
    selectedFolders: 0,
    lastScanAt: null,
    lastUploadAt: null,
    queued: 0,
    uploaded: 0,
    dropped: 0,
    paused: [],
    lastError: null,
    nextUploadAt: null,
  };

  constructor(
    private readonly options: {
      db: LocalDb;
      logRoots: LogRoots;
      scanIntervalMs?: number;
      transportFor?: (pairing: PairingRecord) => EventUploadTransport;
      now?: () => number;
      log?: (line: string) => void;
    },
  ) {
    this.transportFor =
      options.transportFor ??
      ((pairing) => createFetchEventTransport({ baseUrl: pairing.apiUrl, token: pairing.deviceToken }));
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  status(): CollectorStatus {
    return { ...this.current, paused: [...this.current.paused] };
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.scanIntervalMs ?? defaultScanIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Scans once and uploads what is queued. Calls that overlap a running pass wait for it. */
  tick(): Promise<CollectorStatus> {
    this.running ??= this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce(): Promise<CollectorStatus> {
    const { db } = this.options;
    const pairing = db.getPairing();
    if (!pairing) {
      this.pairedDevice = null;
      this.current = { ...this.current, paired: false, needsPairing: false, selectedFolders: 0, queued: 0, paused: [] };
      return this.status();
    }
    if (pairing.deviceId !== this.pairedDevice) {
      this.pairedDevice = pairing.deviceId;
      this.failures = 0;
      this.nextUploadAt = 0;
      this.current = { ...this.current, needsPairing: false, lastError: null, nextUploadAt: null };
    }

    const roots = db
      .folders()
      .filter((folder) => folder.enabled && folder.projectId === pairing.projectId)
      .map((folder) => folder.canonicalPath)
      .sort();
    this.changes.useScope([pairing.projectId, pairing.trackingStartedAt, ...roots].join("\u0000"));

    let scanError: string | null = null;
    try {
      if (roots.length > 0) {
        runCollectionPass({
          db,
          projectId: pairing.projectId,
          trackingStartedAt: pairing.trackingStartedAt,
          selectedRoots: roots,
          logRoots: this.options.logRoots,
          changes: this.changes,
        });
      }
      this.current.lastScanAt = new Date(this.now()).toISOString();
    } catch (error) {
      scanError = `Scan failed: ${error instanceof Error ? error.message : "unknown error"}`;
      this.log(scanError);
    }

    try {
      const staleProject = db.dropOtherProjects(pairing.projectId);
      if (staleProject > 0) {
        this.current.dropped += staleProject;
        this.log(`dropped ${staleProject} queued events for a project this helper is no longer paired with`);
      }
      await this.upload(pairing);
    } catch (error) {
      this.current.lastError = `Upload failed: ${error instanceof Error ? error.message : "unknown error"}`;
      this.log(this.current.lastError);
    }
    if (scanError !== null) {
      this.current.lastError = scanError;
    }

    this.current = {
      ...this.current,
      paired: true,
      selectedFolders: roots.length,
      queued: db.pendingEvents().length,
      paused: db.pausedSessions(pairing.projectId),
      nextUploadAt: this.nextUploadAt > this.now() ? new Date(this.nextUploadAt).toISOString() : null,
    };
    return this.status();
  }

  private async upload(pairing: PairingRecord): Promise<void> {
    if (this.options.db.pendingEvents().length === 0 || this.now() < this.nextUploadAt) {
      return;
    }
    const result = await flushOutbox(this.options.db, this.transportFor(pairing), { projectId: pairing.projectId });
    this.current.uploaded += result.acknowledged.length;
    this.current.dropped += result.rejected.length;
    for (const rejected of result.rejected) {
      this.log(`server rejected ${rejected.eventId} (${rejected.reason}); dropped it from the queue`);
    }
    if (result.error === null) {
      this.failures = 0;
      this.nextUploadAt = 0;
      this.current.lastError = null;
      this.current.needsPairing = false;
      if (result.acknowledged.length > 0) {
        this.current.lastUploadAt = new Date(this.now()).toISOString();
        this.log(`uploaded ${result.acknowledged.length} events`);
      }
      return;
    }
    this.failures += 1;
    this.nextUploadAt = this.now() + uploadBackoffMs(this.failures);
    this.current.lastError = result.error;
    this.current.needsPairing = result.unauthorized;
    this.log(
      result.unauthorized
        ? "upload refused: this helper needs to be paired again"
        : `upload failed (${result.error}); retrying in ${Math.round(uploadBackoffMs(this.failures) / 1000)}s`,
    );
  }
}
