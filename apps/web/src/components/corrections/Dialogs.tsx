import { GitPullRequest, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { GraphFeature, WorkItemDetail } from "../../api";
import { sessionName } from "../../format";
import { parseExcerpt } from "../panel/excerpt";
import { cx } from "../helpers";
import { AgentBadge, Button, Dialog, ErrorNote, Field, StateDot, inputClass } from "../ui";

type Submit = () => Promise<void>;

function useSubmit(onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(work: Submit) {
    setBusy(true);
    setError(null);
    try {
      await work();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, reset: () => setError(null) };
}

function ChoiceList<T extends { id: string }>({
  items,
  selected,
  onSelect,
  render,
  empty,
}: {
  items: T[];
  selected: string | null;
  onSelect: (id: string) => void;
  render: (item: T) => ReactNode;
  empty: string;
}) {
  if (items.length === 0) {
    return <p className="rounded-lg bg-zinc-50 px-3 py-6 text-center text-sm text-zinc-500">{empty}</p>;
  }
  return (
    <div className="max-h-72 space-y-1 overflow-y-auto rounded-xl bg-zinc-50 p-1.5 ring-1 ring-zinc-200 ring-inset">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          className={cx(
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
            item.id === selected ? "bg-white text-indigo-900 shadow-sm ring-2 ring-indigo-500" : "text-zinc-700 hover:bg-white",
          )}
        >
          {render(item)}
        </button>
      ))}
    </div>
  );
}

export function MoveDialog({
  open,
  onClose,
  currentFeatureId,
  features,
  onMove,
}: {
  open: boolean;
  onClose: () => void;
  currentFeatureId: string;
  features: GraphFeature[];
  onMove: (featureId: string) => Promise<void>;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const submit = useSubmit(onClose);
  const options = features.filter((feature) => feature.id !== currentFeatureId);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Move to another feature"
      description="Future analysis keeps it where you put it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!choice} loading={submit.busy} onClick={() => choice && void submit.run(() => onMove(choice))}>
            Move
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ChoiceList
          items={options}
          selected={choice}
          onSelect={setChoice}
          empty="There is no other feature yet."
          render={(feature) => (
            <>
              <span className="min-w-0 flex-1 truncate font-medium">{feature.title}</span>
              <span className="shrink-0 text-xs text-zinc-400">{feature.workItems.length} items</span>
            </>
          )}
        />
        <ErrorNote>{submit.error}</ErrorNote>
      </div>
    </Dialog>
  );
}

export function MergeWorkItemDialog({
  open,
  onClose,
  current,
  features,
  onMerge,
}: {
  open: boolean;
  onClose: () => void;
  current: { id: string; title: string };
  features: GraphFeature[];
  onMerge: (survivingId: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const submit = useSubmit(onClose);
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return features.flatMap((feature) =>
      feature.workItems
        .filter((item) => item.id !== current.id && (needle === "" || item.title.toLowerCase().includes(needle) || feature.title.toLowerCase().includes(needle)))
        .map((item) => ({ ...item, featureTitle: feature.title })),
    );
  }, [features, current.id, query]);
  const target = options.find((item) => item.id === choice);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Merge into another work item"
      description={
        <>
          Use this when “{current.title}” is the same work as another item. Its evidence and pull requests move over, and links to it keep
          working.
        </>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!choice} loading={submit.busy} onClick={() => choice && void submit.run(() => onMerge(choice))}>
            {target ? `Merge into “${target.title.length > 28 ? `${target.title.slice(0, 27)}…` : target.title}”` : "Merge"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search work items" className={cx(inputClass, "pl-9")} />
        </div>
        <ChoiceList
          items={options}
          selected={choice}
          onSelect={setChoice}
          empty="No other work items match."
          render={(item) => (
            <>
              <StateDot state={item.state} />
              <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
              <span className="max-w-[40%] shrink-0 truncate text-xs text-zinc-400">{item.featureTitle}</span>
            </>
          )}
        />
        <ErrorNote>{submit.error}</ErrorNote>
      </div>
    </Dialog>
  );
}

export function MergeFeatureDialog({
  open,
  onClose,
  current,
  features,
  onMerge,
}: {
  open: boolean;
  onClose: () => void;
  current: { id: string; title: string };
  features: GraphFeature[];
  onMerge: (survivingId: string) => Promise<void>;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const submit = useSubmit(onClose);
  const options = features.filter((feature) => feature.id !== current.id);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Merge into another feature"
      description={<>All work items in “{current.title}” move to the feature you choose, and this feature is removed from the map.</>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!choice} loading={submit.busy} onClick={() => choice && void submit.run(() => onMerge(choice))}>
            Merge
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ChoiceList
          items={options}
          selected={choice}
          onSelect={setChoice}
          empty="There is no other feature to merge into."
          render={(feature) => (
            <>
              <span className="min-w-0 flex-1 truncate font-medium">{feature.title}</span>
              <span className="shrink-0 text-xs text-zinc-400">{feature.workItems.length} items</span>
            </>
          )}
        />
        <ErrorNote>{submit.error}</ErrorNote>
      </div>
    </Dialog>
  );
}

export function SplitDialog({
  open,
  onClose,
  detail,
  onSplit,
}: {
  open: boolean;
  onClose: () => void;
  detail: WorkItemDetail;
  onSplit: (input: { title: string; evidenceIds: string[]; artifactIds: string[] }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [evidence, setEvidence] = useState<Set<string>>(new Set());
  const [artifacts, setArtifacts] = useState<Set<string>>(new Set());
  const submit = useSubmit(onClose);
  const pullEvidence = new Map(detail.pullRequests.map((pull) => [pull.artifactId, pull]));
  const sessionEvidence = detail.evidence.filter((item) => item.kind === "session_excerpt");
  const total = detail.pullRequests.length + sessionEvidence.length;
  const chosen = evidence.size + artifacts.size;

  function toggle(set: Set<string>, update: (next: Set<string>) => void, id: string) {
    const next = new Set(set);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    update(next);
    submit.reset();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Split into a new work item"
      description="Pick the pull requests and session excerpts that belong to separate work. They move to a new item and will not be attached here again."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={title.trim() === "" || chosen === 0 || chosen === total}
            loading={submit.busy}
            onClick={() => void submit.run(() => onSplit({ title: title.trim(), evidenceIds: [...evidence], artifactIds: [...artifacts] }))}
          >
            Split out {chosen > 0 ? chosen : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="New work item title">
          <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="What is the separate work?" className={inputClass} />
        </Field>
        <div className="max-h-80 space-y-1.5 overflow-y-auto">
          {detail.pullRequests.map((pull) => (
            <label key={pull.artifactId} className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 ring-1 ring-zinc-200 hover:bg-zinc-50">
              <input
                type="checkbox"
                checked={artifacts.has(pull.artifactId)}
                onChange={() => toggle(artifacts, setArtifacts, pull.artifactId)}
                className="mt-0.5 size-4 accent-indigo-600"
              />
              <GitPullRequest className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              <span className="min-w-0 text-sm text-zinc-800">
                {pull.title} <span className="text-zinc-400">#{pull.number}</span>
              </span>
            </label>
          ))}
          {sessionEvidence.map((item) => {
            const first = parseExcerpt(item.excerpt)[0];
            return (
              <label key={item.id} className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 ring-1 ring-zinc-200 hover:bg-zinc-50">
                <input type="checkbox" checked={evidence.has(item.id)} onChange={() => toggle(evidence, setEvidence, item.id)} className="mt-0.5 size-4 accent-indigo-600" />
                <AgentBadge source={item.source} size={18} />
                <span className="min-w-0 text-sm">
                  <span className="block text-xs text-zinc-500">{sessionName(item.source, item.sessionId)}</span>
                  <span className="line-clamp-2 text-zinc-800">{first?.text ?? item.excerpt}</span>
                </span>
              </label>
            );
          })}
          {pullEvidence.size + sessionEvidence.length === 0 ? <p className="text-sm text-zinc-500">Nothing to split out yet.</p> : null}
        </div>
        {chosen > 0 && chosen === total ? <p className="text-xs text-amber-700">Leave at least one item here.</p> : null}
        <ErrorNote>{submit.error}</ErrorNote>
      </div>
    </Dialog>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  danger = false,
  requireText,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  requireText?: string;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const submit = useSubmit(onClose);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={onClose} data-autofocus>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={requireText !== undefined && typed !== requireText}
            loading={submit.busy}
            onClick={() => void submit.run(onConfirm)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {requireText !== undefined || submit.error ? (
        <div className="space-y-3">
          {requireText !== undefined ? (
            <Field label={`Type ${requireText} to confirm`}>
              <input value={typed} onChange={(event) => setTyped(event.target.value)} className={inputClass} autoComplete="off" />
            </Field>
          ) : null}
          <ErrorNote>{submit.error}</ErrorNote>
        </div>
      ) : null}
    </Dialog>
  );
}
