import { ArrowRight, Ban, Combine, CornerDownRight, Ellipsis, FolderInput, Scissors, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Graph, type WorkItemDetail } from "../../api";
import { ConfirmDialog, MergeWorkItemDialog, MoveDialog, SplitDialog } from "../corrections/Dialogs";
import { useToast } from "../toast-context";
import { ContributorList, EditableTitle, IconButton, Menu, SectionTitle, Spinner, StateChip } from "../ui";
import { EvidenceList } from "./Evidence";
import { History } from "./History";
import { PanelMessage } from "./PanelShell";
import { PullRequestCard } from "./PullRequests";
import { useDetail } from "./useDetail";

function stateExplanation(detail: WorkItemDetail): string {
  const { value, basis } = detail.state;
  if (basis === "observed") {
    switch (value) {
      case "merged":
        return "From GitHub: a pull request was merged and none are still open.";
      case "in_review":
        return "From GitHub: a pull request is open and ready for review.";
      case "in_progress":
        return "From GitHub: only draft pull requests are open.";
      case "closed":
        return "From GitHub: its pull requests were closed without merging.";
      default:
        return "From GitHub.";
    }
  }
  if (basis === "human") {
    return "Set by a person.";
  }
  switch (value) {
    case "planned":
      return "Someone asked for this in an agent session. No work on it has been seen yet.";
    case "in_progress":
      return detail.pullRequests.length > 0
        ? "Agent sessions show more work after its pull requests closed."
        : "Agent sessions show work on this. No pull request has been seen yet.";
    default:
      return "There is not enough activity to tell yet.";
  }
}

type DialogKind = "move" | "merge" | "split" | { dismiss: string } | null;

export function WorkItemPanel({
  token,
  projectId,
  workItemId,
  graph,
  onSelectWorkItem,
  onSelectFeature,
  onChanged,
  onGone,
}: {
  token: string;
  projectId: string;
  workItemId: string;
  graph: Graph;
  onSelectWorkItem: (id: string) => void;
  onSelectFeature: (id: string) => void;
  onChanged: () => Promise<void>;
  onGone: () => void;
}) {
  const toast = useToast();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const { data, error, missing, loading } = useDetail(() => api.workItem(token, projectId, workItemId), workItemId, graph.revision);
  const item = data?.workItem;

  useEffect(() => {
    if (item && item.id !== workItemId) {
      onSelectWorkItem(item.id);
    }
  }, [item, workItemId, onSelectWorkItem]);

  useEffect(() => {
    if (missing) {
      onGone();
    }
  }, [missing, onGone]);

  if (loading) {
    return (
      <PanelMessage>
        <Spinner />
      </PanelMessage>
    );
  }
  if (!item) {
    return <PanelMessage>{error ?? "This work item is no longer on the map."}</PanelMessage>;
  }

  const featureTitle = (id: string) => graph.features.find((entry) => entry.id === id)?.title ?? null;
  const dismissing = typeof dialog === "object" && dialog !== null ? item.relationships.find((relationship) => relationship.id === dialog.dismiss) : undefined;

  return (
    <div className="space-y-7">
      <div>
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={() => onSelectFeature(item.feature.id)}
            className="-ml-1 flex min-w-0 items-center gap-1 rounded-md px-1 text-xs font-semibold tracking-wide text-indigo-600 uppercase hover:bg-indigo-50"
          >
            <span className="truncate">{item.feature.title}</span>
          </button>
          <Menu
            trigger={(toggle) => (
              <IconButton label="Work item actions" onClick={toggle} className="-mt-1.5 -mr-1.5">
                <Ellipsis className="size-4" />
              </IconButton>
            )}
            items={[
              { label: "Move to another feature…", icon: <FolderInput className="size-4" />, onSelect: () => setDialog("move"), disabled: graph.features.length < 2 },
              { label: "Merge into another item…", icon: <Combine className="size-4" />, onSelect: () => setDialog("merge") },
              {
                label: "Split into a new item…",
                icon: <Scissors className="size-4" />,
                onSelect: () => setDialog("split"),
                disabled: item.pullRequests.length + item.evidence.filter((entry) => entry.kind === "session_excerpt").length < 2,
              },
            ]}
          />
        </div>
        <EditableTitle
          label="Rename work item"
          value={item.title.value}
          className="mt-1 text-xl leading-snug font-semibold text-zinc-900"
          onSave={async (title) => {
            await api.correct(token, projectId, { kind: "rename", target: "work_item", id: item.id, title });
            await onChanged();
            toast("Work item renamed");
          }}
        />
        <div className="mt-3 flex items-center gap-2">
          <StateChip state={item.state.value} basis={item.state.basis} />
        </div>
        <p className="mt-1.5 text-xs text-zinc-500">{stateExplanation(item)}</p>
        {item.blocked ? (
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-800 ring-1 ring-rose-200 ring-inset">
            <Ban className="mt-0.5 size-4 shrink-0" />
            <span>
              <span className="font-medium">Blocked.</span> {item.blocked.reason ?? "No reason recorded."}
            </span>
          </div>
        ) : null}
        {item.summary.value ? <p className="mt-4 text-sm leading-relaxed text-zinc-700">{item.summary.value}</p> : null}
      </div>

      <section>
        <SectionTitle>Pull requests</SectionTitle>
        {item.pullRequests.length === 0 ? (
          <p className="text-sm text-zinc-500">No pull request yet.</p>
        ) : (
          <div className="space-y-2.5">
            {item.pullRequests.map((pull) => (
              <PullRequestCard key={pull.artifactId} pull={pull} />
            ))}
          </div>
        )}
      </section>

      {item.relationships.length > 0 ? (
        <section>
          <SectionTitle>Dependencies</SectionTitle>
          <ul className="space-y-1">
            {item.relationships.map((relationship) => (
              <li key={relationship.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50">
                {relationship.direction === "depends_on" ? (
                  <ArrowRight className="size-4 shrink-0 text-zinc-400" aria-hidden />
                ) : (
                  <CornerDownRight className="size-4 shrink-0 text-zinc-400" aria-hidden />
                )}
                <span className="text-xs text-zinc-500">{relationship.direction === "depends_on" ? "Waits for" : "Needed by"}</span>
                <button
                  type="button"
                  onClick={() => onSelectWorkItem(relationship.workItemId)}
                  className="min-w-0 flex-1 truncate text-left text-sm font-medium text-zinc-800 hover:text-indigo-700"
                >
                  {relationship.title}
                </button>
                <IconButton
                  label="This dependency is wrong"
                  onClick={() => setDialog({ dismiss: relationship.id })}
                  className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <X className="size-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <SectionTitle>Evidence</SectionTitle>
        <EvidenceList evidence={item.evidence} />
      </section>

      <section>
        <SectionTitle>Contributors</SectionTitle>
        <ContributorList contributors={item.contributors} />
      </section>

      <section>
        <SectionTitle>History</SectionTitle>
        <History entries={item.history} featureTitle={featureTitle} />
      </section>

      {dialog === "move" ? (
        <MoveDialog
          open
          onClose={() => setDialog(null)}
          currentFeatureId={item.feature.id}
          features={graph.features}
          onMove={async (featureId) => {
            await api.correct(token, projectId, { kind: "move", workItemId: item.id, featureId });
            await onChanged();
            toast(`Moved to “${featureTitle(featureId) ?? "feature"}”`);
          }}
        />
      ) : null}
      {dialog === "merge" ? (
        <MergeWorkItemDialog
          open
          onClose={() => setDialog(null)}
          current={{ id: item.id, title: item.title.value }}
          features={graph.features}
          onMerge={async (survivingId) => {
            await api.correct(token, projectId, { kind: "merge", target: "work_item", retiredId: item.id, survivingId });
            onSelectWorkItem(survivingId);
            await onChanged();
            toast("Work items merged");
          }}
        />
      ) : null}
      {dialog === "split" ? (
        <SplitDialog
          open
          onClose={() => setDialog(null)}
          detail={item}
          onSplit={async (input) => {
            const result = await api.correct(token, projectId, { kind: "split", workItemId: item.id, ...input });
            await onChanged();
            if (result.createdWorkItemId) {
              onSelectWorkItem(result.createdWorkItemId);
            }
            toast("Split into a new work item");
          }}
        />
      ) : null}
      {dismissing ? (
        <ConfirmDialog
          open
          onClose={() => setDialog(null)}
          title="Remove this dependency?"
          description={
            <>
              “{item.title.value}” {dismissing.direction === "depends_on" ? "will no longer wait for" : "will no longer be needed by"} “{dismissing.title}”. Future
              analysis will not add it back.
            </>
          }
          confirmLabel="Remove dependency"
          onConfirm={async () => {
            await api.correct(token, projectId, { kind: "dismiss", relationshipId: dismissing.id });
            await onChanged();
            toast("Dependency removed");
          }}
        />
      ) : null}
    </div>
  );
}
