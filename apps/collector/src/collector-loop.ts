// Runs a scan and an upload about every thirty seconds while the helper is paired.
// It skips the scan when no folders are selected and waits longer after an upload failure.

import { homedir } from "node:os";
import { join } from "node:path";
import { ChangeTracker } from "./change-tracker.js";
import type { SessionAgentId } from "./contract/adapter.js";
import { runCollectionPass, type LogRoots } from "./collection-pass.js";
import { createFetchEventTransport, flushOutbox, type EventUploadTransport } from "./upload-outbox.js";
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
  const agents: SessionAgentId[] = ["codex", "claude_code", "cursor"];
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
  private uploadError: string | null = null;
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
    // The scan below is synchronous; let the request that triggered it answer first.
    await new Promise((resolve) => setImmediate(resolve));
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
      this.uploadError = null;
      this.current = { ...this.current, needsPairing: false, nextUploadAt: null };
    }

    const roots = db.enabledRoots(pairing.projectId);
    this.changes.useScope([pairing.projectId, pairing.trackingStartedAt, ...roots].join("\u0000"));

    let scanError: string | null = null;
    try {
      if (roots.length > 0) {
        const pass = runCollectionPass({
          db,
          projectId: pairing.projectId,
          trackingStartedAt: pairing.trackingStartedAt,
          selectedRoots: roots,
          logRoots: this.options.logRoots,
          changes: this.changes,
        });
        for (const failure of pass.failed) {
          this.log(`could not collect ${failure}`);
        }
        const first = pass.failed[0];
        if (first) {
          scanError = `Could not collect ${pass.failed.length} session${pass.failed.length === 1 ? "" : "s"}; trying again next scan (${first})`;
        }
      }
      this.current.lastScanAt = new Date(this.now()).toISOString();
    } catch (error) {
      this.changes.forget();
      scanError = `Scan failed: ${error instanceof Error ? error.message : "unknown error"}`;
      this.log(scanError);
    }

    try {
      const staleProject = db.dropOtherProjects(pairing.projectId);
      if (staleProject > 0) {
        this.current.dropped += staleProject;
        this.log(`dropped ${staleProject} queued events for a project this helper is no longer paired with`);
      }
      const unselected = db.dropUnselected(pairing.projectId, roots);
      if (unselected > 0) {
        this.current.dropped += unselected;
        this.log(`dropped ${unselected} queued events from sessions outside the selected folders`);
      }
      await this.upload(pairing);
    } catch (error) {
      this.uploadError = `Upload failed: ${error instanceof Error ? error.message : "unknown error"}`;
      this.log(this.uploadError);
    }

    this.current = {
      ...this.current,
      paired: true,
      selectedFolders: roots.length,
      queued: db.pendingCount(),
      paused: db.pausedSessions(pairing.projectId),
      lastError: scanError ?? this.uploadError,
      nextUploadAt: this.nextUploadAt > this.now() ? new Date(this.nextUploadAt).toISOString() : null,
    };
    return this.status();
  }

  private async upload(pairing: PairingRecord): Promise<void> {
    if (this.options.db.pendingCount() === 0) {
      if (!this.current.needsPairing) {
        this.uploadError = null;
      }
      return;
    }
    if (this.now() < this.nextUploadAt) {
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
      this.uploadError = null;
      this.current.needsPairing = false;
      if (result.acknowledged.length > 0) {
        this.current.lastUploadAt = new Date(this.now()).toISOString();
        this.log(`uploaded ${result.acknowledged.length} events`);
      }
      return;
    }
    this.failures += 1;
    this.nextUploadAt = this.now() + uploadBackoffMs(this.failures);
    this.uploadError = result.error;
    this.current.needsPairing = result.unauthorized;
    this.log(
      result.unauthorized
        ? "upload refused: this helper needs to be paired again"
        : `upload failed (${result.error}); retrying in ${Math.round(uploadBackoffMs(this.failures) / 1000)}s`,
    );
  }
}
