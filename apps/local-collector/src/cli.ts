// Reads command-line arguments and either prints events for one log file or starts the local helper.
// The helper is the long-running process the web app pairs with.

import { CollectorLoop, defaultLogRoots, defaultScanIntervalMs, describeLogRoots } from "./collector-loop.js";
import type { SessionAgentId } from "./contract/adapter.js";
import { startLocalServer } from "./local-server.js";
import { LocalDb } from "./local-db.js";
import { collectSession } from "./parse-file.js";

const agents: readonly SessionAgentId[] = ["codex", "cursor", "claude_code"];

const parseUsage =
  "usage: npm start -w @apm/local-collector -- <file> <trackingStartedAt> <codex|cursor|claude_code> <root...>";

export type CliIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type CliResult = { exitCode: number };

export async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<CliResult> {
  if (argv[0] === "serve") {
    const port = Number(env.APM_HELPER_PORT ?? env.APM_COLLECTOR_PORT ?? 47321);
    const dbPath = env.APM_HELPER_DB ?? env.APM_COLLECTOR_DB ?? "collector.sqlite";
    const db = new LocalDb(dbPath);
    const logRoots = defaultLogRoots(env);
    const loop = new CollectorLoop({
      db,
      logRoots,
      scanIntervalMs: Number(env.APM_SCAN_INTERVAL_MS ?? defaultScanIntervalMs),
      log: (line) => io.log(line),
    });
    const server = await startLocalServer({
      db,
      port,
      webOrigin: env.WEB_ORIGIN ?? "http://127.0.0.1:5173",
      logRoots,
      status: () => loop.status(),
      scanNow: () => loop.tick(),
    });
    loop.start();
    const address = server.address();
    const bound = address && typeof address !== "string" ? address.port : port;
    io.log(`helper listening on http://127.0.0.1:${bound}`);
    io.log(`watching agent logs: ${describeLogRoots(logRoots).join(", ")}`);
    return { exitCode: 0 };
  }
  return runParse(argv, io);
}

function runParse(argv: string[], io: CliIo): CliResult {
  const [filePath, trackingStartedAt, agent, ...selectedRoots] = argv;
  if (!filePath || !trackingStartedAt || !isAgent(agent)) {
    io.log("helper ready");
    io.log(parseUsage);
    return { exitCode: 0 };
  }
  const result = collectSession({
    agent,
    filePath,
    projectId: "00000000-0000-4000-8000-000000000000",
    trackingStartedAt,
    selectedRoots,
  });
  io.log(JSON.stringify(result, null, 2));
  return { exitCode: 0 };
}

function isAgent(value: string | undefined): value is SessionAgentId {
  return agents.some((agent) => agent === value);
}
