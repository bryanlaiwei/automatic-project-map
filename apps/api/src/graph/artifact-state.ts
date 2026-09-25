import { z } from "zod";

export const pullRequestStateSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  author: z.string().nullable(),
  headSha: z.string(),
  mergedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  commits: z.array(z.object({ sha: z.string(), message: z.string() })),
  reviews: z.array(
    z.object({
      reviewId: z.number().int(),
      reviewer: z.string(),
      decision: z.string(),
      submittedAt: z.string(),
    }),
  ),
  updatedAt: z.string(),
});

export type PullRequestState = z.infer<typeof pullRequestStateSchema>;

const runAttemptSchema = z.object({
  attempt: z.number().int(),
  status: z.string(),
  conclusion: z.string().nullable(),
  updatedAt: z.string(),
});

const runJobSchema = z.object({
  jobId: z.number().int(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  attempt: z.number().int(),
  updatedAt: z.string(),
});

export const workflowRunStateSchema = z.object({
  runId: z.number().int(),
  status: z.string(),
  conclusion: z.string().nullable(),
  attempt: z.number().int(),
  headSha: z.string(),
  pullRequestNumbers: z.array(z.number().int()),
  attempts: z.array(runAttemptSchema),
  jobs: z.array(runJobSchema),
  updatedAt: z.string(),
});

export type WorkflowRunState = z.infer<typeof workflowRunStateSchema>;
export type WorkflowRunJob = z.infer<typeof runJobSchema>;
export type WorkflowRunAttempt = z.infer<typeof runAttemptSchema>;

/** The parts of a pull request a viewer sees in an expanded work item. */
export function visiblePullRequest(state: PullRequestState) {
  return {
    title: state.title,
    state: state.state,
    draft: state.draft,
    merged: state.merged,
    reviews: state.reviews.map((review) => `${review.reviewer}:${review.decision}`),
  };
}

export function visibleWorkflowRun(state: WorkflowRunState) {
  return {
    status: state.status,
    conclusion: state.conclusion,
    attempt: state.attempt,
    jobs: state.jobs.map((job) => `${job.name}:${job.attempt}:${job.status}:${job.conclusion ?? ""}`),
  };
}
