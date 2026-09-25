import { z } from "zod";

/**
 * The only shape the model may answer with. Every field is required and nullable instead of optional so
 * the same schema works as an OpenAI strict structured output.
 *
 * References are aliases from the context: E1.. for new evidence, W1.. for work items, F1.. for features,
 * and "new:<name>" for something created earlier in the same proposal.
 */
const evidenceRefs = z.array(z.string()).describe("E aliases from this batch that support the operation.");
const inferredState = z.enum(["planned", "in_progress"]).nullable();

export const createFeatureOperation = z.object({
  op: z.literal("create_feature"),
  ref: z.string().describe('A new alias such as "new:password-reset".'),
  title: z.string(),
  summary: z.string(),
  evidence: evidenceRefs,
});

export const createWorkItemOperation = z.object({
  op: z.literal("create_work_item"),
  ref: z.string(),
  feature: z.string().describe("An F alias or the ref of a feature created earlier in this proposal."),
  title: z.string(),
  summary: z.string(),
  state: inferredState,
  evidence: evidenceRefs,
});

export const attachOperation = z.object({
  op: z.literal("attach"),
  work_item: z.string(),
  evidence: evidenceRefs,
});

export const updateWorkItemOperation = z.object({
  op: z.literal("update_work_item"),
  work_item: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  state: inferredState,
  evidence: evidenceRefs,
});

export const updateFeatureOperation = z.object({
  op: z.literal("update_feature"),
  feature: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  evidence: evidenceRefs,
});

export const moveWorkItemOperation = z.object({
  op: z.literal("move_work_item"),
  work_item: z.string(),
  feature: z.string(),
  evidence: evidenceRefs,
});

export const addDependencyOperation = z.object({
  op: z.literal("add_dependency"),
  from: z.string().describe("The work item that waits."),
  to: z.string().describe("The work item it waits for."),
  evidence: evidenceRefs,
});

export const setBlockedOperation = z.object({
  op: z.literal("set_blocked"),
  work_item: z.string(),
  blocked: z.boolean(),
  reason: z.string().nullable(),
  evidence: evidenceRefs,
});

export const proposalOperationSchema = z.union([
  createFeatureOperation,
  createWorkItemOperation,
  attachOperation,
  updateWorkItemOperation,
  updateFeatureOperation,
  moveWorkItemOperation,
  addDependencyOperation,
  setBlockedOperation,
]);

export const proposalSchema = z.object({
  operations: z.array(proposalOperationSchema),
});

export type Proposal = z.infer<typeof proposalSchema>;
export type ProposalOperation = z.infer<typeof proposalOperationSchema>;

export const proposalLimits = {
  titleChars: 120,
  summaryChars: 800,
  reasonChars: 300,
  operations: 60,
};
