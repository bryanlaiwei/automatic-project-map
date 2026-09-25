import type { PoolClient } from "pg";
import { explicitReferences, truncate, type ReferenceTarget } from "./evidence.js";
import type { LockedProject } from "./graph-store.js";
import type { WorkItemState } from "./state.js";

export const contextLimits = {
  evidencePerBatch: 12,
  workItems: 30,
  lexicalMatches: 10,
  recentWorkItems: 8,
  features: 60,
  earlierExcerptsPerSession: 2,
  earlierExcerptChars: 1500,
  scannedWorkItems: 500,
};

export type ContextEvidence = {
  alias: string;
  id: string;
  kind: "session_excerpt" | "pull_request";
  source: string;
  session: string | null;
  sessionKey: string | null;
  observedAt: string;
  excerpt: string;
  pullRequestNumber: number | null;
  artifactId: string | null;
  referencedPullRequests: number[];
  hasUserMessage: boolean;
};

export type ContextWorkItem = {
  alias: string;
  id: string;
  featureAlias: string;
  title: string;
  summary: string;
  state: WorkItemState;
  blocked: boolean;
  pullRequests: number[];
  sessions: string[];
  reasons: string[];
};

export type ContextFeature = {
  alias: string;
  id: string;
  title: string;
  summary: string;
};

export type EarlierExcerpt = {
  session: string;
  observedAt: string;
  excerpt: string;
  workItems: string[];
};

export type InterpretationContext = {
  project: { owner: string; name: string };
  baseRevision: number;
  evidence: ContextEvidence[];
  workItems: ContextWorkItem[];
  features: ContextFeature[];
  earlier: EarlierExcerpt[];
};

type EvidenceRow = {
  id: string;
  kind: "session_excerpt" | "pull_request";
  source: string;
  session_id: string | null;
  artifact_id: string | null;
  excerpt: string;
  observed_at: Date;
  number: number | null;
};

type WorkItemRow = {
  id: string;
  feature_id: string;
  title: string;
  summary: string;
  state: WorkItemState;
  blocked: boolean;
  pulls: number[];
  sessions: Array<{ source: string; session_id: string }>;
};

export function sessionLabel(source: string, sessionId: string): string {
  return `${source} session ${sessionId.slice(0, 8)}`;
}

export async function buildContext(
  client: PoolClient,
  project: LockedProject,
  evidenceIds: readonly string[],
): Promise<InterpretationContext> {
  const evidenceRows = await client.query<EvidenceRow>(
    `select e.id, e.kind, e.source, e.session_id, e.artifact_id, e.excerpt, e.observed_at, a.number
     from evidence e
     left join artifacts a on a.id = e.artifact_id
     where e.id = any($1::uuid[])
     order by e.observed_at, e.id`,
    [evidenceIds],
  );
  const targets = await pullRequestTargets(client, project.id);
  const numberByArtifact = new Map(targets.map((target) => [target.artifactId, target.number]));
  const evidence: ContextEvidence[] = evidenceRows.rows.map((row, index) => {
    const referenced = row.kind === "session_excerpt" ? explicitReferences(row.excerpt, project, targets) : [];
    return {
      alias: `E${index + 1}`,
      id: row.id,
      kind: row.kind,
      source: row.source,
      session: row.session_id ? sessionLabel(row.source, row.session_id) : null,
      sessionKey: row.session_id ? `${row.source}\u0000${row.session_id}` : null,
      observedAt: row.observed_at.toISOString(),
      excerpt: row.excerpt,
      pullRequestNumber: row.number,
      artifactId: row.artifact_id,
      referencedPullRequests: referenced.flatMap((id) => {
        const number = numberByArtifact.get(id);
        return number === undefined ? [] : [number];
      }),
      hasUserMessage: row.kind === "session_excerpt" && /^User \(/m.test(row.excerpt),
    };
  });

  const reasons = new Map<string, Set<string>>();
  const addReason = (id: string, reason: string) => {
    const set = reasons.get(id) ?? new Set<string>();
    set.add(reason);
    reasons.set(id, set);
  };

  const sessions = uniqueSessions(evidenceRows.rows);
  if (sessions.length > 0) {
    const sameSession = await client.query<{ work_item_id: string; source: string; session_id: string }>(
      `select distinct we.work_item_id, e.source, e.session_id
       from evidence e
       join work_item_evidence we on we.evidence_id = e.id
       join work_items wi on wi.id = we.work_item_id and wi.retired_into is null
       where e.project_id = $1
         and (e.source, e.session_id) in (select * from unnest($2::text[], $3::text[]))`,
      [project.id, sessions.map((item) => item.source), sessions.map((item) => item.sessionId)],
    );
    for (const row of sameSession.rows) {
      addReason(row.work_item_id, `earlier work in ${sessionLabel(row.source, row.session_id)}`);
    }
  }

  const artifactIds = [
    ...new Set([
      ...evidence.flatMap((item) => (item.artifactId ? [item.artifactId] : [])),
      ...evidenceRows.rows.flatMap((row) =>
        row.kind === "session_excerpt" ? explicitReferences(row.excerpt, project, targets) : [],
      ),
    ]),
  ];
  if (artifactIds.length > 0) {
    const linked = await client.query<{ work_item_id: string; number: number }>(
      `select distinct wa.work_item_id, a.number
       from work_item_artifacts wa
       join artifacts a on a.id = wa.artifact_id
       join work_items wi on wi.id = wa.work_item_id and wi.retired_into is null
       where wa.artifact_id = any($1::uuid[])`,
      [artifactIds],
    );
    for (const row of linked.rows) {
      addReason(row.work_item_id, `linked to pull request #${row.number}`);
    }
  }

  const all = await client.query<WorkItemRow>(
    `select wi.id, wi.feature_id, wi.title, wi.summary, wi.state, wi.blocked,
            coalesce((select array_agg(distinct a.number) from work_item_artifacts wa
                      join artifacts a on a.id = wa.artifact_id
                      where wa.work_item_id = wi.id and a.kind = 'pull_request'), '{}') as pulls,
            coalesce((select json_agg(distinct jsonb_build_object('source', e.source, 'session_id', e.session_id))
                      from work_item_evidence we join evidence e on e.id = we.evidence_id
                      where we.work_item_id = wi.id and e.session_id is not null), '[]') as sessions
     from work_items wi
     where wi.project_id = $1 and wi.retired_into is null
     order by wi.updated_at desc
     limit $2`,
    [project.id, contextLimits.scannedWorkItems],
  );
  for (const row of all.rows.slice(0, contextLimits.recentWorkItems)) {
    addReason(row.id, "recently updated");
  }
  const evidenceTokens = tokens(evidence.map((item) => item.excerpt).join("\n"));
  const lexical = all.rows
    .map((row) => ({ id: row.id, score: overlap(evidenceTokens, tokens(`${row.title}\n${row.summary}`)) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, contextLimits.lexicalMatches);
  for (const item of lexical) {
    addReason(item.id, "similar wording");
  }

  const priority = (id: string) => {
    const set = reasons.get(id) ?? new Set<string>();
    return [...set].some((reason) => reason.startsWith("linked to") || reason.startsWith("earlier work")) ? 0 : 1;
  };
  const chosen = all.rows
    .filter((row) => reasons.has(row.id))
    .sort((a, b) => priority(a.id) - priority(b.id))
    .slice(0, contextLimits.workItems);

  const features = await client.query<{ id: string; title: string; summary: string }>(
    `select id, title, summary from feature_groups
     where project_id = $1 and retired_into is null
     order by (id = any($2::uuid[])) desc, updated_at desc
     limit $3`,
    [project.id, [...new Set(chosen.map((row) => row.feature_id))], contextLimits.features],
  );
  const featureAlias = new Map(features.rows.map((row, index) => [row.id, `F${index + 1}`]));
  const workItemAlias = new Map(chosen.map((row, index) => [row.id, `W${index + 1}`]));

  const workItems: ContextWorkItem[] = chosen.flatMap((row) => {
    const feature = featureAlias.get(row.feature_id);
    const alias = workItemAlias.get(row.id);
    if (!feature || !alias) {
      return [];
    }
    return [
      {
        alias,
        id: row.id,
        featureAlias: feature,
        title: row.title,
        summary: row.summary,
        state: row.state,
        blocked: row.blocked,
        pullRequests: [...row.pulls].sort((a, b) => a - b),
        sessions: row.sessions.map((item) => sessionLabel(item.source, item.session_id)),
        reasons: [...(reasons.get(row.id) ?? [])],
      },
    ];
  });

  const earlier = sessions.length === 0 ? [] : await earlierExcerpts(client, project.id, sessions, evidenceIds, workItemAlias);

  return {
    project: { owner: project.owner, name: project.name },
    baseRevision: project.revision,
    evidence,
    workItems,
    features: features.rows.map((row) => ({
      alias: featureAlias.get(row.id) ?? "",
      id: row.id,
      title: row.title,
      summary: row.summary,
    })),
    earlier,
  };
}

async function pullRequestTargets(client: PoolClient, projectId: string): Promise<ReferenceTarget[]> {
  const result = await client.query<{ id: string; number: number; head_sha: string | null; commits: string[] | null }>(
    `select id, number, head_sha,
            (select array_agg(value->>'sha') from jsonb_array_elements(state->'commits') value) as commits
     from artifacts
     where project_id = $1 and kind = 'pull_request'
     order by source_updated_at desc
     limit 500`,
    [projectId],
  );
  return result.rows.map((row) => ({
    artifactId: row.id,
    number: row.number,
    shas: [...(row.head_sha ? [row.head_sha] : []), ...(row.commits ?? [])],
  }));
}

function uniqueSessions(rows: readonly EvidenceRow[]): Array<{ source: string; sessionId: string }> {
  const seen = new Map<string, { source: string; sessionId: string }>();
  for (const row of rows) {
    if (row.session_id) {
      seen.set(`${row.source}\u0000${row.session_id}`, { source: row.source, sessionId: row.session_id });
    }
  }
  return [...seen.values()];
}

async function earlierExcerpts(
  client: PoolClient,
  projectId: string,
  sessions: ReadonlyArray<{ source: string; sessionId: string }>,
  batchEvidenceIds: readonly string[],
  workItemAlias: ReadonlyMap<string, string>,
): Promise<EarlierExcerpt[]> {
  const result = await client.query<{
    source: string;
    session_id: string;
    excerpt: string;
    observed_at: Date;
    work_items: string[];
  }>(
    `select source, session_id, excerpt, observed_at, work_items
     from (
       select e.source, e.session_id, e.excerpt, e.observed_at,
              coalesce((select array_agg(we.work_item_id::text) from work_item_evidence we where we.evidence_id = e.id), '{}') as work_items,
              row_number() over (partition by e.source, e.session_id order by e.observed_at desc) as rank
       from evidence e
       where e.project_id = $1
         and e.kind = 'session_excerpt'
         and not (e.id = any($4::uuid[]))
         and (e.source, e.session_id) in (select * from unnest($2::text[], $3::text[]))
     ) ranked
     where rank <= $5
     order by observed_at`,
    [
      projectId,
      sessions.map((item) => item.source),
      sessions.map((item) => item.sessionId),
      batchEvidenceIds,
      contextLimits.earlierExcerptsPerSession,
    ],
  );
  return result.rows.map((row) => ({
    session: sessionLabel(row.source, row.session_id),
    observedAt: row.observed_at.toISOString(),
    excerpt: truncate(row.excerpt, contextLimits.earlierExcerptChars),
    workItems: row.work_items.flatMap((id) => {
      const alias = workItemAlias.get(id);
      return alias ? [alias] : [];
    }),
  }));
}

const stopwords = new Set([
  "that", "this", "with", "from", "have", "will", "would", "could", "should", "there", "their", "about", "into",
  "then", "than", "when", "what", "which", "while", "where", "were", "been", "also", "just", "like", "make",
  "need", "want", "they", "them", "your", "some", "more", "only", "file", "files", "code", "user", "agent",
]);

function tokens(text: string): Set<string> {
  const found = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []) {
    if (!stopwords.has(word)) {
      found.add(word);
    }
  }
  return found;
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const word of b) {
    if (a.has(word)) {
      count += 1;
    }
  }
  return count;
}

/** The context as plain text for the model. Source text is quoted data, never instructions. */
export function renderContext(context: InterpretationContext): string {
  const lines: string[] = [`Repository: ${context.project.owner}/${context.project.name}`, ""];
  lines.push("## Existing features");
  if (context.features.length === 0) {
    lines.push("(none yet)");
  }
  for (const feature of context.features) {
    lines.push(`${feature.alias}: ${feature.title}`, `  Summary: ${feature.summary}`);
  }
  lines.push("", "## Candidate work items");
  if (context.workItems.length === 0) {
    lines.push("(none yet)");
  }
  for (const item of context.workItems) {
    lines.push(
      `${item.alias} (in ${item.featureAlias}): ${item.title}`,
      `  State: ${item.state}${item.blocked ? ", blocked" : ""}`,
      `  Summary: ${item.summary}`,
      ...(item.pullRequests.length > 0 ? [`  Pull requests: ${item.pullRequests.map((number) => `#${number}`).join(", ")}`] : []),
      ...(item.sessions.length > 0 ? [`  Sessions: ${item.sessions.join(", ")}`] : []),
      `  Shown because: ${item.reasons.join("; ")}`,
    );
  }
  if (context.earlier.length > 0) {
    lines.push("", "## Earlier in the same sessions (context only, cannot be cited)");
    for (const item of context.earlier) {
      lines.push(
        `<earlier session="${item.session}" at="${item.observedAt}" attached_to="${item.workItems.join(",") || "nothing"}">`,
        quoted(item.excerpt),
        "</earlier>",
      );
    }
  }
  lines.push("", "## New evidence (cite these by alias)");
  for (const item of context.evidence) {
    const origin = item.kind === "pull_request" ? `pull request #${item.pullRequestNumber ?? "?"}` : (item.session ?? item.source);
    const references =
      item.referencedPullRequests.length > 0
        ? ` references="${item.referencedPullRequests.map((number) => `#${number}`).join(",")}"`
        : "";
    lines.push(`<evidence alias="${item.alias}" from="${origin}" at="${item.observedAt}"${references}>`, quoted(item.excerpt), "</evidence>");
  }
  return lines.join("\n");
}

/** Keeps quoted source text from closing the tag it sits in. */
function quoted(text: string): string {
  return text.replace(/<\/(evidence|earlier)/gi, "< /$1");
}
