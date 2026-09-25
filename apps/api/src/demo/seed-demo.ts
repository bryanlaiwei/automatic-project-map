import { SCHEMA_VERSION, type NormalizedEvent } from "@apm/shared";
import type { Pool } from "pg";
import { getPool } from "../db.js";
import { loadEnvFile } from "../env.js";
import type { InterpretationContext } from "../graph/context.js";
import { processProject, type Interpreter } from "../graph/process.js";
import type { Proposal, ProposalOperation } from "../graph/proposal.js";
import { ingestEvents } from "../ingest-events.js";
import { insertEvents } from "../store.js";

/**
 * Builds a sample project for a signed-in person so the map can be explored without an OpenAI key.
 * Events go through the real facts and interpretation stages; a scripted interpreter stands in for the
 * model and groups each sample by the work item it was written for.
 *
 *   npm run demo:seed -w @apm/api -- <github-login-or-email>
 *   npm run demo:seed -w @apm/api -- <github-login-or-email> --remove
 */

const demoOwner = "demo";
const demoName = "shop-app";

const features = {
  checkout: { title: "Checkout", summary: "Paying for an order and what happens right after." },
  account: { title: "Account & sign-in", summary: "How people sign in, recover access and stay secure." },
  promotions: { title: "Promotions", summary: "Discount codes: managing them and using them at checkout." },
  search: { title: "Product search", summary: "Finding products by name and description." },
} as const;

type FeatureKey = keyof typeof features;

const items: Record<string, { feature: FeatureKey; title: string; summary: string; state: "planned" | "in_progress" | null }> = {
  reset: { feature: "account", title: "Password reset by email", summary: "Emails a one-hour reset link and lets people choose a new password.", state: "in_progress" },
  ratelimit: { feature: "account", title: "Rate limit login attempts", summary: "Limits POST /login to five attempts per minute per IP.", state: "in_progress" },
  google: { feature: "account", title: "Sign in with Google", summary: "Requested as the next sign-in option. Not started.", state: "planned" },
  stripe: { feature: "checkout", title: "Stripe payment form", summary: "Card payment on the checkout page using Stripe Elements.", state: "in_progress" },
  emails: { feature: "checkout", title: "Order confirmation emails", summary: "Sends a receipt email once payment succeeds.", state: "in_progress" },
  discount: { feature: "checkout", title: "Apply discount codes at checkout", summary: "A code field on checkout that validates codes and updates the total.", state: "in_progress" },
  promoApi: { feature: "promotions", title: "Promotions admin API", summary: "Create, list and expire discount codes from the admin area.", state: "in_progress" },
  analytics: { feature: "promotions", title: "Discount usage dashboard", summary: "Requested: a chart of how often each code is used.", state: "planned" },
  search: { feature: "search", title: "Full-text product search", summary: "Postgres full-text search over product names and descriptions.", state: "in_progress" },
  ranking: { feature: "search", title: "Search result ranking", summary: "Rank results by popularity as well as text match.", state: "in_progress" },
};

type ItemKey = keyof typeof items;

type Fixture =
  | { kind: "session"; item: ItemKey; agent: "codex" | "claude_code" | "cursor"; session: string; hoursAgo: number; turns: Array<["user" | "assistant", string]>; dependsOn?: ItemKey; blocked?: string }
  | { kind: "pull"; item: ItemKey; id: number; number: number; title: string; body: string; hoursAgo: number; author: string; draft?: boolean; state?: "open" | "closed"; merged?: boolean }
  | { kind: "run"; pull: number; runId: number; attempt: number; conclusion: "success" | "failure" | null; hoursAgo: number; jobs: string[] }
  | { kind: "review"; pullId: number; reviewer: string; decision: string; hoursAgo: number };

const fixtures: Fixture[] = [
  {
    kind: "session",
    item: "reset",
    agent: "codex",
    session: "demo-codex-reset",
    hoursAgo: 60,
    turns: [
      ["user", "Add password reset by email. The link should expire after an hour."],
      ["assistant", "Added a password_reset_tokens table, POST /auth/password-reset to send the email, and a reset page that checks the token."],
    ],
  },
  { kind: "pull", item: "reset", id: 7038, number: 38, title: "Password reset by email", body: "Reset tokens with a one hour expiry, the reset email, and the new-password page.", hoursAgo: 58, author: "bryanlaiwei" },
  { kind: "run", pull: 38, runId: 91038, attempt: 1, conclusion: "success", hoursAgo: 57, jobs: ["test", "lint"] },
  { kind: "pull", item: "reset", id: 7038, number: 38, title: "Password reset by email", body: "Reset tokens with a one hour expiry, the reset email, and the new-password page.", hoursAgo: 50, author: "bryanlaiwei", state: "closed", merged: true },
  {
    kind: "session",
    item: "search",
    agent: "codex",
    session: "demo-codex-search",
    hoursAgo: 48,
    turns: [
      ["user", "Add full-text product search using Postgres tsvector on name and description."],
      ["assistant", "Added a generated tsvector column with a GIN index and GET /products/search?q=. Results come back in about 20 ms on the sample data."],
    ],
  },
  { kind: "pull", item: "search", id: 7040, number: 40, title: "Full-text product search", body: "Generated tsvector column, GIN index and the search endpoint.", hoursAgo: 46, author: "octocat" },
  { kind: "run", pull: 40, runId: 91040, attempt: 1, conclusion: "success", hoursAgo: 45, jobs: ["test", "lint"] },
  { kind: "pull", item: "search", id: 7040, number: 40, title: "Full-text product search", body: "Generated tsvector column, GIN index and the search endpoint.", hoursAgo: 40, author: "octocat", state: "closed", merged: true },
  {
    kind: "session",
    item: "stripe",
    agent: "codex",
    session: "demo-codex-stripe",
    hoursAgo: 38,
    turns: [
      ["user", "Build the Stripe payment form on the checkout page."],
      ["assistant", "Added Stripe Elements to the checkout page, a POST /payments/intent endpoint, and error states for declined cards."],
    ],
  },
  { kind: "pull", item: "stripe", id: 7041, number: 41, title: "Stripe payment form", body: "Stripe Elements card form, payment intent endpoint and declined-card handling.", hoursAgo: 36, author: "bryanlaiwei" },
  { kind: "run", pull: 41, runId: 91041, attempt: 1, conclusion: "success", hoursAgo: 35, jobs: ["test", "e2e", "lint"] },
  { kind: "review", pullId: 7041, reviewer: "octocat", decision: "approved", hoursAgo: 34 },
  { kind: "pull", item: "stripe", id: 7041, number: 41, title: "Stripe payment form", body: "Stripe Elements card form, payment intent endpoint and declined-card handling.", hoursAgo: 30, author: "bryanlaiwei", state: "closed", merged: true },
  {
    kind: "session",
    item: "emails",
    agent: "claude_code",
    session: "demo-claude-emails",
    hoursAgo: 26,
    dependsOn: "stripe",
    turns: [
      ["user", "Send an order confirmation email after payment succeeds. It needs the payment webhook from the Stripe payment form work."],
      ["assistant", "Added a receipt email template and a handler for the payment_intent.succeeded webhook that sends it once per order."],
    ],
  },
  { kind: "pull", item: "emails", id: 7044, number: 44, title: "Order confirmation emails", body: "Receipt template and the payment_intent.succeeded handler.", hoursAgo: 24, author: "bryanlaiwei" },
  { kind: "run", pull: 44, runId: 91044, attempt: 1, conclusion: "failure", hoursAgo: 23.5, jobs: ["test", "e2e"] },
  { kind: "run", pull: 44, runId: 91044, attempt: 2, conclusion: "success", hoursAgo: 23, jobs: ["test", "e2e"] },
  { kind: "review", pullId: 7044, reviewer: "octocat", decision: "approved", hoursAgo: 20 },
  {
    kind: "session",
    item: "promoApi",
    agent: "codex",
    session: "demo-codex-promo",
    hoursAgo: 20,
    turns: [
      ["user", "Create the promotions admin API: create, list and expire discount codes."],
      ["assistant", "Added a discount_codes table and admin endpoints under /admin/promotions with validation for dates and limits."],
    ],
  },
  { kind: "pull", item: "promoApi", id: 7043, number: 43, title: "Promotions admin API", body: "discount_codes table and CRUD endpoints under /admin/promotions.", hoursAgo: 18, author: "octocat" },
  { kind: "review", pullId: 7043, reviewer: "hubot", decision: "changes_requested", hoursAgo: 16 },
  {
    kind: "session",
    item: "discount",
    agent: "cursor",
    session: "demo-cursor-discount",
    hoursAgo: 12,
    dependsOn: "promoApi",
    turns: [
      ["user", "Apply discount codes at checkout. Validate the code with the promotions admin API and update the total."],
      ["assistant", "Added the code field and total recalculation. Validation is stubbed until the promotions admin API lands."],
    ],
  },
  {
    kind: "session",
    item: "ratelimit",
    agent: "claude_code",
    session: "demo-claude-ratelimit",
    hoursAgo: 9,
    turns: [
      ["user", "People are brute-forcing the login form. Rate limit POST /login per IP."],
      ["assistant", "Added a sliding-window limiter: five attempts per minute per IP, then 429 with a Retry-After header."],
    ],
  },
  { kind: "pull", item: "ratelimit", id: 7045, number: 45, title: "Rate limit login attempts", body: "Sliding-window limiter for POST /login.", hoursAgo: 8, author: "bryanlaiwei", draft: true },
  { kind: "run", pull: 45, runId: 91045, attempt: 1, conclusion: null, hoursAgo: 7.9, jobs: ["test"] },
  {
    kind: "session",
    item: "ranking",
    agent: "cursor",
    session: "demo-cursor-ranking",
    hoursAgo: 5,
    blocked: "Needs product popularity data, which is not collected yet.",
    turns: [
      ["user", "Rank search results by popularity as well as text match."],
      ["assistant", "Started a ranking function, but there is no popularity data yet. We need view and purchase counts per product first."],
    ],
  },
  {
    kind: "session",
    item: "google",
    agent: "codex",
    session: "demo-codex-google",
    hoursAgo: 3,
    turns: [["user", "Next we should add Sign in with Google next to GitHub sign-in."]],
  },
  {
    kind: "session",
    item: "analytics",
    agent: "claude_code",
    session: "demo-claude-analytics",
    hoursAgo: 2,
    turns: [["user", "Later I want a dashboard showing how often each discount code is used."]],
  },
];

function marker(fixture: Extract<Fixture, { kind: "session" | "pull" }>): string {
  return fixture.kind === "session" ? (fixture.turns[0]?.[1] ?? "") : fixture.title;
}

/** Stands in for the model: every sample says which work item it belongs to. */
function scriptedInterpreter(): Interpreter {
  return {
    model: "demo-script",
    promptVersion: "demo",
    async interpret(context: InterpretationContext): Promise<Proposal> {
      const operations: ProposalOperation[] = [];
      const newFeatures = new Set<FeatureKey>();
      const newItems = new Map<ItemKey, Extract<ProposalOperation, { op: "create_work_item" }>>();
      const itemRef = (key: ItemKey) => {
        if (newItems.has(key)) {
          return `new:${key}`;
        }
        return context.workItems.find((item) => item.title === items[key]?.title)?.alias ?? null;
      };
      for (const evidence of context.evidence) {
        const kind = evidence.kind === "session_excerpt" ? "session" : "pull";
        const fixture = fixtures.find(
          (entry): entry is Extract<Fixture, { kind: "session" | "pull" }> => entry.kind === kind && evidence.excerpt.includes(marker(entry)),
        );
        const plan = fixture ? items[fixture.item] : undefined;
        if (!fixture || !plan) {
          continue;
        }
        const existing = itemRef(fixture.item);
        if (existing && !newItems.has(fixture.item)) {
          operations.push({ op: "attach", work_item: existing, evidence: [evidence.alias] });
        } else if (newItems.has(fixture.item)) {
          newItems.get(fixture.item)?.evidence.push(evidence.alias);
        } else {
          const feature = context.features.find((entry) => entry.title === features[plan.feature].title)?.alias;
          if (!feature && !newFeatures.has(plan.feature)) {
            newFeatures.add(plan.feature);
            operations.push({ op: "create_feature", ref: `new:f-${plan.feature}`, ...features[plan.feature], evidence: [evidence.alias] });
          }
          const create = {
            op: "create_work_item" as const,
            ref: `new:${fixture.item}`,
            feature: feature ?? `new:f-${plan.feature}`,
            title: plan.title,
            summary: plan.summary,
            state: plan.state,
            evidence: [evidence.alias],
          };
          newItems.set(fixture.item, create);
          operations.push(create);
        }
        if (fixture.kind === "session" && fixture.dependsOn) {
          const to = itemRef(fixture.dependsOn);
          const from = itemRef(fixture.item);
          if (to && from) {
            operations.push({ op: "add_dependency", from, to, evidence: [evidence.alias] });
          }
        }
        if (fixture.kind === "session" && fixture.blocked) {
          const target = itemRef(fixture.item);
          if (target) {
            operations.push({ op: "set_blocked", work_item: target, blocked: true, reason: fixture.blocked, evidence: [evidence.alias] });
          }
        }
      }
      return { operations };
    },
  };
}

async function findUser(pool: Pool, who: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `select id from auth.users where lower(email) = lower($1) or lower(raw_user_meta_data->>'user_name') = lower($1)`,
    [who.replace(/^@/, "")],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error(`No signed-in user matches "${who}". Sign in to the web app once, then run this again.`);
  }
  return id;
}

async function removeDemo(pool: Pool, userId: string): Promise<number> {
  const result = await pool.query(
    `delete from workspaces w
     using memberships m
     where m.workspace_id = w.id and m.user_id = $1 and w.name = $2`,
    [userId, `${demoOwner}/${demoName}`],
  );
  return result.rowCount ?? 0;
}

async function storeFixture(pool: Pool, projectId: string, repoId: number, fixture: Fixture, at: string, createdAt: Map<string, string>): Promise<void> {
  switch (fixture.kind) {
    case "session": {
      const sessionCreatedAt = createdAt.get(fixture.session) ?? at;
      createdAt.set(fixture.session, sessionCreatedAt);
      const messages = fixture.turns.map(([role, text], index) => ({
        id: `${fixture.session}-${index}`,
        role,
        text,
        occurredAt: new Date(Date.parse(at) + index * 60_000).toISOString(),
      }));
      const common = { schemaVersion: SCHEMA_VERSION, projectId, source: fixture.agent, sourceKey: `${fixture.agent}:${fixture.session}` };
      const result = await ingestEvents(pool, {
        projectId,
        events: [
          {
            ...common,
            eventId: `demo:${projectId}:${fixture.session}:started`,
            occurredAt: sessionCreatedAt,
            details: { kind: "session.started", sessionId: fixture.session, createdAt: sessionCreatedAt, sourceVersion: "demo" },
          },
          {
            ...common,
            eventId: `demo:${projectId}:${fixture.session}:${at}`,
            occurredAt: at,
            details: {
              kind: "session.content_added",
              sessionId: fixture.session,
              createdAt: sessionCreatedAt,
              sourceVersion: "demo",
              recordIds: messages.map((message) => message.id),
              messages,
            },
          },
        ],
      });
      if (result.rejected.length > 0) {
        throw new Error(`Sample session ${fixture.session} was rejected: ${JSON.stringify(result.rejected)}`);
      }
      return;
    }
    case "pull": {
      const event: NormalizedEvent = {
        schemaVersion: SCHEMA_VERSION,
        eventId: `demo:${projectId}:pull:${fixture.id}:${at}`,
        sourceKey: `github:pull_request:${fixture.id}`,
        projectId,
        source: "github",
        occurredAt: at,
        details: {
          kind: "pr.updated",
          repositoryId: repoId,
          pullRequestId: fixture.id,
          number: fixture.number,
          title: fixture.title,
          body: fixture.body,
          url: `https://github.com/${demoOwner}/${demoName}/pull/${fixture.number}`,
          draft: fixture.draft ?? false,
          state: fixture.state ?? "open",
          merged: fixture.merged ?? false,
          headSha: `demo${fixture.number}0000000`,
          updatedAt: at,
          author: fixture.author,
        },
      };
      await insertEvents(pool, [event]);
      return;
    }
    case "run": {
      const status = fixture.conclusion === null ? "in_progress" : "completed";
      await insertEvents(pool, [
        {
          schemaVersion: SCHEMA_VERSION,
          eventId: `demo:${projectId}:run:${fixture.runId}:${fixture.attempt}`,
          sourceKey: `github:workflow_run:${fixture.runId}`,
          projectId,
          source: "github",
          occurredAt: at,
          details: {
            kind: "workflow.updated",
            repositoryId: repoId,
            runId: fixture.runId,
            jobId: null,
            attempt: fixture.attempt,
            status,
            conclusion: fixture.conclusion,
            headSha: `demo${fixture.pull}0000000`,
            pullRequestNumbers: [fixture.pull],
            url: `https://github.com/${demoOwner}/${demoName}/actions/runs/${fixture.runId}`,
            jobs: fixture.jobs.map((name, index) => ({
              jobId: fixture.runId * 10 + index,
              name,
              status,
              conclusion: fixture.conclusion === "failure" && index > 0 ? "success" : fixture.conclusion,
              attempt: fixture.attempt,
            })),
          },
        },
      ]);
      return;
    }
    case "review": {
      await insertEvents(pool, [
        {
          schemaVersion: SCHEMA_VERSION,
          eventId: `demo:${projectId}:review:${fixture.pullId}:${fixture.reviewer}`,
          sourceKey: `github:pull_request_review:${fixture.pullId}`,
          projectId,
          source: "github",
          occurredAt: at,
          details: {
            kind: "pr.reviewed",
            repositoryId: repoId,
            pullRequestId: fixture.pullId,
            reviewId: fixture.pullId * 10 + fixture.reviewer.length,
            reviewer: fixture.reviewer,
            decision: fixture.decision,
            submittedAt: at,
          },
        },
      ]);
      return;
    }
    default: {
      const unhandled: never = fixture;
      throw new Error(`Unhandled fixture ${JSON.stringify(unhandled)}`);
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const who = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (!who) {
    console.error("Usage: npm run demo:seed -w @apm/api -- <github-login-or-email> [--remove]");
    process.exit(1);
  }
  const pool = getPool();
  try {
    const userId = await findUser(pool, who);
    const removed = await removeDemo(pool, userId);
    if (process.argv.includes("--remove")) {
      console.log(removed > 0 ? "Removed the demo project." : "There was no demo project to remove.");
      return;
    }
    const start = Date.now() - 72 * 3_600_000;
    const repoId = -Math.floor(1 + Math.random() * 1_000_000_000);
    const workspace = await pool.query<{ id: string }>(`insert into workspaces (name) values ($1) returning id`, [`${demoOwner}/${demoName}`]);
    const workspaceId = workspace.rows[0]?.id;
    const project = await pool.query<{ id: string }>(
      `insert into projects (workspace_id, github_repo_id, github_owner, github_name, tracking_started_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [workspaceId, repoId, demoOwner, demoName, new Date(start).toISOString()],
    );
    const projectId = project.rows[0]?.id;
    if (!workspaceId || !projectId) {
      throw new Error("Could not create the demo project.");
    }
    await pool.query(`insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')`, [workspaceId, userId]);

    const interpreter = scriptedInterpreter();
    const sessionsCreated = new Map<string, string>();
    for (const fixture of fixtures) {
      const at = new Date(Date.now() - fixture.hoursAgo * 3_600_000).toISOString();
      await storeFixture(pool, projectId, repoId, fixture, at, sessionsCreated);
      await processProject(pool, projectId, { interpreter, quietMs: 0, maxWaitMs: 0 });
    }
    const counts = await pool.query<{ features: string; items: string }>(
      `select (select count(*) from feature_groups where project_id = $1 and retired_into is null) as features,
              (select count(*) from work_items where project_id = $1 and retired_into is null) as items`,
      [projectId],
    );
    console.log(
      `Created ${demoOwner}/${demoName} with ${counts.rows[0]?.features ?? 0} features and ${counts.rows[0]?.items ?? 0} work items. Pick it from the repository menu in the web app.`,
    );
  } finally {
    await pool.end();
  }
}

await main();
