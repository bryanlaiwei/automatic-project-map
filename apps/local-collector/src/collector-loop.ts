// Runs a scan and an upload about every thirty seconds for every project the helper is paired with.
// Each project has its own folders, token and retry timer, so one project's failures do not hold up another.

import { homedir } from "node:os";
import { agents } from "./agents.js";
import { ChangeTracker } from "./change-tracker.js";
import { runCollectionPass, type LogRoots } from "./collection-pass.js";
import { createFetchEventTransport, flushOutbox, type EventUploadTransport } from "./upload-outbox.js";
import type { LocalDb, PairingRecord } from "./local-db.js";

export const defaultScanIntervalMs = 30_000;
const maxUploadBackoffMs = 5 * 60_000;

type PausedSession = { provider: string; sessionId: string; reason: string | null };

export type ProjectCollectorStatus = {
  projectId: string;
  projectName: string | null;
  trackingStartedAt: string;
  needsPairing: boolean;
  selectedFolders: number;
  lastUploadAt: string | null;
  queued: number;
  paused: PausedSession[];
  lastError: string | null;
  nextUploadAt: string | null;
};

/** Totals across every paired project, plus each project on its own. */
export type CollectorStatus = {
  paired: boolean;
  needsPairing: boolean;
  selectedFolders: number;
  lastScanAt: string | null;
  lastUploadAt: string | null;
  queued: number;
  uploaded: number;
  dropped: number;
  paused: PausedSession[];
  lastError: string | null;
  nextUploadAt: string | null;
  projects: ProjectCollectorStatus[];
};

type ProjectState = {
  deviceId: string;
  changes: ChangeTracker;
  failures: number;
  nextUploadAt: number;
  uploadError: string | null;
  scanError: string | null;
  needsPairing: boolean;
  lastUploadAt: string | null;
};

export function defaultLogRoots(env: NodeJS.ProcessEnv, home: string = homedir()): LogRoots {
  const roots: LogRoots = {};
  for (const agent of agents) {
    const directory = agent.logDirectory(env, home);
    if (directory) {
      roots[agent.id] = directory;
    }
  }
  return roots;
}

export function describeLogRoots(roots: LogRoots): string[] {
  return agents.flatMap((agent) => {
    const root = roots[agent.id];
    return root ? [`${agent.id}: ${root}`] : [];
  });
}

export function uploadBackoffMs(failures: number): number {
  if (failures <= 0) {
    return 0;
  }
  return Math.min(5_000 * 2 ** (failures - 1), maxUploadBackoffMs);
}

export class CollectorLoop {
  private readonly transportFor: (pairing: PairingRecord) => EventUploadTransport;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly projects = new Map<string, ProjectState>();
  private running: Promise<CollectorStatus> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScanAt: string | null = null;
  private uploaded = 0;
  private dropped = 0;
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
    projects: [],
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
    return {
      ...this.current,
      paused: [...this.current.paused],
      projects: this.current.projects.map((project) => ({ ...project, paused: [...project.paused] })),
    };
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
    const pairings = db.pairings();
    const paired = new Set(pairings.map((pairing) => pairing.projectId));
    for (const projectId of this.projects.keys()) {
      if (!paired.has(projectId)) {
        this.projects.delete(projectId);
      }
    }

    const unpaired = db.dropUnpairedProjects();
    if (unpaired > 0) {
      this.dropped += unpaired;
      this.log(`dropped ${unpaired} queued events for projects this helper is no longer paired with`);
    }

    for (const pairing of pairings) {
      await this.runProject(pairing, this.stateFor(pairing));
    }
    if (pairings.length > 0) {
      this.lastScanAt = new Date(this.now()).toISOString();
    }
    this.current = this.summarize(pairings);
    return this.status();
  }

  /** Starts fresh when a project is paired again, so an expired token's backoff does not carry over. */
  private stateFor(pairing: PairingRecord): ProjectState {
    const existing = this.projects.get(pairing.projectId);
    if (existing && existing.deviceId === pairing.deviceId) {
      return existing;
    }
    const state: ProjectState = {
      deviceId: pairing.deviceId,
      changes: existing?.changes ?? new ChangeTracker(),
      failures: 0,
      nextUploadAt: 0,
      uploadError: null,
      scanError: null,
      needsPairing: false,
      lastUploadAt: existing?.lastUploadAt ?? null,
    };
    this.projects.set(pairing.projectId, state);
    return state;
  }

  private async runProject(pairing: PairingRecord, state: ProjectState): Promise<void> {
    const { db } = this.options;
    const roots = db.enabledRoots(pairing.projectId);
    state.changes.useScope([pairing.trackingStartedAt, ...roots].join("\u0000"));

    state.scanError = null;
    try {
      if (roots.length > 0) {
        const pass = runCollectionPass({
          db,
          projectId: pairing.projectId,
          trackingStartedAt: pairing.trackingStartedAt,
          selectedRoots: roots,
          logRoots: this.options.logRoots,
          changes: state.changes,
        });
        for (const failure of pass.failed) {
          this.log(`could not collect ${failure}`);
        }
        const first = pass.failed[0];
        if (first) {
          state.scanError = `Could not collect ${pass.failed.length} session${pass.failed.length === 1 ? "" : "s"}; trying again next scan (${first})`;
        }
      }
    } catch (error) {
      state.changes.forget();
      state.scanError = `Scan failed: ${error instanceof Error ? error.message : "unknown error"}`;
      this.log(state.scanError);
    }

    try {
      const unselected = db.dropUnselected(pairing.projectId, roots);
      if (unselected > 0) {
        this.dropped += unselected;
        this.log(`dropped ${unselected} queued events from sessions outside the selected folders`);
      }
      await this.upload(pairing, state);
    } catch (error) {
      state.uploadError = `Upload failed: ${error instanceof Error ? error.message : "unknown error"}`;
      this.log(state.uploadError);
    }
  }

  private async upload(pairing: PairingRecord, state: ProjectState): Promise<void> {
    const { db } = this.options;
    if (db.pendingCount(pairing.projectId) === 0) {
      if (!state.needsPairing) {
        state.uploadError = null;
      }
      return;
    }
    if (this.now() < state.nextUploadAt) {
      return;
    }
    const result = await flushOutbox(db, this.transportFor(pairing), { projectId: pairing.projectId });
    this.uploaded += result.acknowledged.length;
    this.dropped += result.rejected.length;
    for (const rejected of result.rejected) {
      this.log(`server rejected ${rejected.eventId} (${rejected.reason}); dropped it from the queue`);
    }
    const name = pairing.projectName ?? pairing.projectId;
    if (result.error === null) {
      state.failures = 0;
      state.nextUploadAt = 0;
      state.uploadError = null;
      state.needsPairing = false;
      if (result.acknowledged.length > 0) {
        state.lastUploadAt = new Date(this.now()).toISOString();
        this.log(`uploaded ${result.acknowledged.length} events for ${name}`);
      }
      return;
    }
    state.failures += 1;
    state.nextUploadAt = this.now() + uploadBackoffMs(state.failures);
    state.uploadError = result.error;
    state.needsPairing = result.unauthorized;
    this.log(
      result.unauthorized
        ? `upload refused for ${name}: this helper needs to be paired with it again`
        : `upload for ${name} failed (${result.error}); retrying in ${Math.round(uploadBackoffMs(state.failures) / 1000)}s`,
    );
  }

  private summarize(pairings: PairingRecord[]): CollectorStatus {
    const { db } = this.options;
    const now = this.now();
    const projects = pairings.map((pairing): ProjectCollectorStatus => {
      const state = this.projects.get(pairing.projectId);
      return {
        projectId: pairing.projectId,
        projectName: pairing.projectName,
        trackingStartedAt: pairing.trackingStartedAt,
        needsPairing: state?.needsPairing ?? false,
        selectedFolders: db.enabledRoots(pairing.projectId).length,
        lastUploadAt: state?.lastUploadAt ?? null,
        queued: db.pendingCount(pairing.projectId),
        paused: db.pausedSessions(pairing.projectId),
        lastError: state ? (state.scanError ?? state.uploadError) : null,
        nextUploadAt: state && state.nextUploadAt > now ? new Date(state.nextUploadAt).toISOString() : null,
      };
    });
    const latest = (values: Array<string | null>, pick: (a: string, b: string) => boolean) =>
      values.reduce<string | null>((best, value) => (value !== null && (best === null || pick(value, best)) ? value : best), null);
    return {
      paired: projects.length > 0,
      needsPairing: projects.some((project) => project.needsPairing),
      selectedFolders: projects.reduce((sum, project) => sum + project.selectedFolders, 0),
      lastScanAt: this.lastScanAt,
      lastUploadAt: latest(projects.map((project) => project.lastUploadAt), (a, b) => a > b),
      queued: db.pendingCount(),
      uploaded: this.uploaded,
      dropped: this.dropped,
      paused: projects.flatMap((project) => project.paused),
      lastError: projects.find((project) => project.lastError !== null)?.lastError ?? null,
      nextUploadAt: latest(projects.map((project) => project.nextUploadAt), (a, b) => a < b),
      projects,
    };
  }
}
