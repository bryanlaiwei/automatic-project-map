import {
  evaluateSessionEligibility,
  serializeIngestedSession,
  SESSION_CHUNK_BYTES,
  sha256Hex,
  splitSessionBytes,
} from "@apm/shared";
import { collectSession, loadIngestedSession, type AgentId } from "./collect.js";
import {
  createFetchSessionUploadTransport,
  uploadSessionChunks,
  type SessionUploadAck,
  type SessionUploadTransport,
} from "./upload.js";

const defaultApiUrl = "http://127.0.0.1:4000";
const agents: readonly AgentId[] = ["codex", "cursor", "claude_code"];

const parseUsage =
  "usage: npm start -w @apm/collector -- <file> <trackingStartedAt> <codex|cursor|claude_code> <root...>";
const uploadUsage = [
  "usage: npm start -w @apm/collector -- upload <file> <codex|cursor|claude_code> <projectId> <trackingStartedAt> <root...>",
  "The API URL defaults to http://127.0.0.1:4000. Override it with APM_API_URL or --api-url.",
  "Set APM_ACCESS_TOKEN in the environment. Do not pass the token as an argument.",
].join("\n");

export type CliIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type CliResult = { exitCode: number };

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  fetchImpl?: typeof fetch,
): Promise<CliResult> {
  const token = env.APM_ACCESS_TOKEN?.trim() ?? "";
  if (argv[0] !== "upload") {
    return runParse(argv, io);
  }
  try {
    return await runUpload(argv.slice(1), env, token, io, fetchImpl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed.";
    io.error(redact(`Upload failed: ${message}`, token));
    return { exitCode: 1 };
  }
}

function runParse(argv: string[], io: CliIo): CliResult {
  const [filePath, trackingStartedAt, agent, ...selectedRoots] = argv;
  if (!filePath || !trackingStartedAt || !isAgent(agent)) {
    io.log("collector ready");
    io.log(parseUsage);
    io.log(uploadUsage);
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

async function runUpload(
  argv: string[],
  env: NodeJS.ProcessEnv,
  token: string,
  io: CliIo,
  fetchImpl?: typeof fetch,
): Promise<CliResult> {
  const parsed = parseUploadArgs(argv, env);
  if (!parsed.ok) {
    io.error(parsed.message);
    io.error(uploadUsage);
    return { exitCode: 1 };
  }
  if (token === "") {
    io.error("APM_ACCESS_TOKEN is missing. Set it to the Supabase access token for the signed-in user. Do not pass the token on the command line.");
    return { exitCode: 1 };
  }

  const session = loadIngestedSession({
    agent: parsed.args.agent,
    filePath: parsed.args.filePath,
    selectedRoots: parsed.args.selectedRoots,
  });
  const decision = evaluateSessionEligibility({
    createdAt: session.createdAt,
    trackingStartedAt: parsed.args.trackingStartedAt,
    workingFolder: session.workingFolder,
    selectedRoots: session.selectedRoots,
  });
  if (!decision.eligible) {
    io.error(`Session was not uploaded (${decision.reason}).`);
    return { exitCode: 1 };
  }

  const serialized = serializeIngestedSession(session);
  const pieces = splitSessionBytes(serialized, SESSION_CHUNK_BYTES);
  const contentSha256 = sha256Hex(Buffer.concat(pieces));
  let newlySent = 0;
  const transport = countingTransport(
    createFetchSessionUploadTransport({
      baseUrl: parsed.args.apiUrl,
      token,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    () => {
      newlySent += 1;
    },
  );
  const before = await transport.status({
    projectId: parsed.args.projectId,
    source: session.source,
    sessionId: session.sessionId,
    contentSha256,
  });
  const alreadyOnServer = chunksAlreadyOnServer(before, pieces.length, contentSha256);
  const ack = await uploadSessionChunks({
    projectId: parsed.args.projectId,
    session,
    transport,
  });
  io.log(
    [
      `bytes: ${Buffer.byteLength(serialized)}`,
      `chunks: ${pieces.length}`,
      `already on server: ${alreadyOnServer}`,
      `newly sent: ${newlySent}`,
      `complete: ${ack.complete}`,
      `stored: ${ack.stored}`,
      `reason: ${ack.reason}`,
      `eventsStored: ${ack.eventsStored}`,
    ].join("\n"),
  );
  if (!ack.complete || ack.stored !== true) {
    io.error(redact("Upload failed: the server did not store this session.", token));
    return { exitCode: 1 };
  }
  return { exitCode: 0 };
}

function chunksAlreadyOnServer(status: SessionUploadAck, chunkCount: number, contentSha256: string): number {
  if (status.contentSha256 !== contentSha256) {
    return 0;
  }
  if (status.complete) {
    return chunkCount;
  }
  return status.acknowledged.length;
}

function countingTransport(inner: SessionUploadTransport, onSend: () => void): SessionUploadTransport {
  return {
    status: (input) => inner.status(input),
    reset: (input) => inner.reset(input),
    async send(chunk) {
      const ack = await inner.send(chunk);
      onSend();
      return ack;
    },
  };
}

type UploadArgs = {
  filePath: string;
  agent: AgentId;
  projectId: string;
  trackingStartedAt: string;
  selectedRoots: string[];
  apiUrl: string;
};

function parseUploadArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): { ok: true; args: UploadArgs } | { ok: false; message: string } {
  const positional: string[] = [];
  let apiUrl = env.APM_API_URL?.trim() || defaultApiUrl;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (
      arg === "--token" ||
      arg === "--access-token" ||
      arg === "--apm-access-token" ||
      arg.startsWith("--token=") ||
      arg.startsWith("--access-token=") ||
      arg.startsWith("--apm-access-token=")
    ) {
      return {
        ok: false,
        message: "Do not pass the access token on the command line. Set APM_ACCESS_TOKEN in the environment.",
      };
    }
    if (arg === "--api-url" || arg.startsWith("--api-url=")) {
      const value = arg === "--api-url" ? argv[index + 1] : arg.slice("--api-url=".length);
      if (arg === "--api-url") {
        index += 1;
      }
      if (!value || value.startsWith("--")) {
        return { ok: false, message: "Pass an API URL after --api-url, or set APM_API_URL." };
      }
      apiUrl = value;
      continue;
    }
    if (arg.startsWith("--")) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      return { ok: false, message: `Unknown option ${name}.` };
    }
    positional.push(arg);
  }

  const [filePath, agent, projectId, trackingStartedAt, ...selectedRoots] = positional;
  if (!filePath || !isAgent(agent) || !projectId || !trackingStartedAt || selectedRoots.length === 0) {
    return { ok: false, message: "Session file, agent, project id, tracking start time, and at least one root are required." };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    return { ok: false, message: "Project id must be a UUID from the projects table." };
  }
  if (Number.isNaN(Date.parse(trackingStartedAt))) {
    return { ok: false, message: "Tracking start time must be an ISO-8601 timestamp." };
  }
  return {
    ok: true,
    args: { filePath, agent, projectId, trackingStartedAt, selectedRoots, apiUrl },
  };
}

function isAgent(value: string | undefined): value is AgentId {
  return agents.some((agent) => agent === value);
}

function redact(text: string, token: string): string {
  if (token === "") {
    return text;
  }
  return text.split(token).join("[redacted]");
}
