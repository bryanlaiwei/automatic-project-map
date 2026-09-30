import { createHash } from "node:crypto";
import { evidenceRowChars, type SessionMessage } from "@apm/shared";

export type SessionExcerpt = {
  records: SessionMessage[];
  excerpt: string;
  observedAt: string;
};

const omittedOnly = /^(\s*\[tool output omitted\]\s*)+$/;

/**
 * Record ids are only unique inside one read for some adapters, so a message is identified by its id,
 * role, time and text together.
 */
export function recordKey(message: SessionMessage): string {
  return createHash("sha256")
    .update(`${message.id}\u001f${message.role}\u001f${message.occurredAt}\u001f${message.text}`)
    .digest("hex")
    .slice(0, 32);
}

export function sessionExcerpts(messages: readonly SessionMessage[]): SessionExcerpt[] {
  const parts: SessionExcerpt[] = [];
  let current: { records: SessionMessage[]; lines: string[]; chars: number; observedAt: string } | null = null;
  for (const message of messages) {
    const text = message.text.trim();
    if (text === "" || omittedOnly.test(text)) {
      continue;
    }
    // Continuation lines are indented so only a real role header starts a line; message text cannot pose as a request.
    const body = text.replace(/\r\n|[\n\r\u2028\u2029]/g, "\n  ");
    const line = `${message.role === "user" ? "User" : "Agent"} (${message.occurredAt}): ${body}`;
    if (current && current.chars + 2 + line.length > evidenceRowChars) {
      parts.push({ records: current.records, excerpt: current.lines.join("\n\n"), observedAt: current.observedAt });
      current = null;
    }
    current ??= { records: [], lines: [], chars: 0, observedAt: message.occurredAt };
    current.records.push(message);
    current.lines.push(line);
    current.chars += (current.lines.length > 1 ? 2 : 0) + line.length;
    if (Date.parse(message.occurredAt) > Date.parse(current.observedAt)) {
      current.observedAt = message.occurredAt;
    }
  }
  if (current) {
    parts.push({ records: current.records, excerpt: current.lines.join("\n\n"), observedAt: current.observedAt });
  }
  return parts;
}

export function pullRequestExcerpts(input: {
  number: number;
  title: string;
  body: string;
  commits: ReadonlyArray<{ message: string }>;
  files: ReadonlyArray<{ filename: string }>;
}): string[] {
  const lines = [`Pull request #${input.number}: ${input.title.trim()}`];
  const body = input.body.trim();
  if (body !== "") {
    lines.push("", "Description:", body);
  }
  const commits = input.commits
    .map((commit) => commit.message.split("\n")[0]?.trim() ?? "")
    .filter((message) => message !== "");
  if (commits.length > 0) {
    lines.push("", "Commits:", ...commits.map((message) => `- ${message}`));
  }
  const files = input.files.map((file) => file.filename);
  if (files.length > 0) {
    lines.push("", "Files:", ...files.map((filename) => `- ${filename}`));
  }
  return splitEvidenceText(lines.join("\n"));
}

/** Splits source text into rows of at most evidenceRowChars without dropping characters. */
export function splitEvidenceText(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const parts: string[] = [];
  for (let offset = 0; offset < text.length; offset += evidenceRowChars) {
    parts.push(text.slice(offset, offset + evidenceRowChars));
  }
  return parts;
}

export function textFingerprint(title: string, body: string): string {
  return createHash("sha256").update(`${title}\u001f${body}`).digest("hex");
}

export type ReferenceTarget = {
  artifactId: string;
  number: number;
  shas: readonly string[];
};

/**
 * Pull requests a session names by URL in this repository, or by a commit SHA that belongs to exactly one
 * observed pull request. A bare "#12" is too ambiguous to count.
 */
export function explicitReferences(
  text: string,
  repository: { owner: string; name: string },
  targets: readonly ReferenceTarget[],
): string[] {
  const found = new Set<string>();
  const byNumber = new Map(targets.map((target) => [target.number, target.artifactId]));
  const urlPattern = new RegExp(
    `github\\.com/${escapeRegExp(repository.owner)}/${escapeRegExp(repository.name)}/pull/(\\d+)`,
    "gi",
  );
  for (const match of text.matchAll(urlPattern)) {
    const artifactId = byNumber.get(Number(match[1]));
    if (artifactId) {
      found.add(artifactId);
    }
  }
  for (const match of text.matchAll(/\b[0-9a-f]{7,40}\b/gi)) {
    const candidate = match[0].toLowerCase();
    const owners = targets.filter((target) => target.shas.some((sha) => sha.toLowerCase().startsWith(candidate)));
    if (owners.length === 1 && owners[0]) {
      found.add(owners[0].artifactId);
    }
  }
  return [...found];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
