export const workItemStates = ["planned", "in_progress", "in_review", "merged", "closed", "unknown"] as const;
export type WorkItemState = (typeof workItemStates)[number];

export type Basis = "observed" | "inferred" | "human";

export type InferredState = "planned" | "in_progress";

export type PullRequestFact = {
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  closedAt: string | null;
};

/**
 * Pull request facts decide the state when a work item has pull requests. A session can only say
 * work is planned or in progress, so an agent saying "done" never becomes merged.
 */
export function computeWorkItemState(input: {
  pullRequests: PullRequestFact[];
  inferredState: InferredState | null;
  inferredStateAt: string | null;
  hasSessionEvidence: boolean;
}): { state: WorkItemState; basis: Basis } {
  const { pullRequests } = input;
  if (pullRequests.length > 0) {
    const open = pullRequests.filter((pull) => pull.state === "open");
    if (open.some((pull) => !pull.draft)) {
      return { state: "in_review", basis: "observed" };
    }
    if (open.length > 0) {
      return { state: "in_progress", basis: "observed" };
    }
    const lastClosed = Math.max(...pullRequests.map((pull) => (pull.closedAt ? Date.parse(pull.closedAt) : 0)));
    if (
      input.inferredState === "in_progress" &&
      input.inferredStateAt !== null &&
      Date.parse(input.inferredStateAt) > lastClosed
    ) {
      return { state: "in_progress", basis: "inferred" };
    }
    return pullRequests.some((pull) => pull.merged)
      ? { state: "merged", basis: "observed" }
      : { state: "closed", basis: "observed" };
  }
  if (input.inferredState) {
    return { state: input.inferredState, basis: "inferred" };
  }
  return input.hasSessionEvidence ? { state: "in_progress", basis: "inferred" } : { state: "unknown", basis: "inferred" };
}
