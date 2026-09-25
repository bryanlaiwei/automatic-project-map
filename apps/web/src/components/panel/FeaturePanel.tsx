import { Ban, Combine, Ellipsis } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Graph } from "../../api";
import { describeCounts } from "../../format";
import { MergeFeatureDialog } from "../corrections/Dialogs";
import { useToast } from "../toast-context";
import { ContributorList, EditableTitle, IconButton, Menu, SectionTitle, Spinner, StateBar, StateChip } from "../ui";
import { History } from "./History";
import { PanelMessage } from "./PanelShell";
import { useDetail } from "./useDetail";

export function FeaturePanel({
  token,
  projectId,
  featureId,
  graph,
  onSelectWorkItem,
  onSelectFeature,
  onChanged,
  onGone,
}: {
  token: string;
  projectId: string;
  featureId: string;
  graph: Graph;
  onSelectWorkItem: (id: string) => void;
  onSelectFeature: (id: string) => void;
  onChanged: () => Promise<void>;
  onGone: () => void;
}) {
  const toast = useToast();
  const [merging, setMerging] = useState(false);
  const { data, error, missing, loading } = useDetail(() => api.feature(token, projectId, featureId), featureId, graph.revision);
  const feature = data?.feature;
  const overview = graph.features.find((entry) => entry.id === featureId);

  useEffect(() => {
    if (feature && feature.id !== featureId) {
      onSelectFeature(feature.id);
    }
  }, [feature, featureId, onSelectFeature]);

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
  if (!feature) {
    return <PanelMessage>{error ?? "This feature is no longer on the map."}</PanelMessage>;
  }

  const featureTitle = (id: string) => graph.features.find((entry) => entry.id === id)?.title ?? null;

  return (
    <div className="space-y-7">
      <div>
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-semibold tracking-wide text-indigo-600 uppercase">Feature</p>
          <Menu
            trigger={(toggle) => (
              <IconButton label="Feature actions" onClick={toggle} className="-mt-1.5 -mr-1.5">
                <Ellipsis className="size-4" />
              </IconButton>
            )}
            items={[
              {
                label: "Merge into another feature…",
                icon: <Combine className="size-4" />,
                onSelect: () => setMerging(true),
                disabled: graph.features.length < 2,
              },
            ]}
          />
        </div>
        <EditableTitle
          label="Rename feature"
          value={feature.title.value}
          className="mt-1 text-xl leading-snug font-semibold text-zinc-900"
          onSave={async (title) => {
            await api.correct(token, projectId, { kind: "rename", target: "feature", id: feature.id, title });
            await onChanged();
            toast("Feature renamed");
          }}
        />
        {feature.summary.value ? (
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">{feature.summary.value}</p>
        ) : (
          <p className="mt-2 text-sm text-zinc-400">No summary yet.</p>
        )}
        {overview ? (
          <div className="mt-4">
            <StateBar counts={overview.counts} className="h-2" />
            <p className="mt-2 text-xs text-zinc-500">{describeCounts(overview.counts)}</p>
          </div>
        ) : null}
      </div>

      <section>
        <SectionTitle>Work items</SectionTitle>
        {feature.workItems.length === 0 ? (
          <p className="text-sm text-zinc-500">No work items in this feature.</p>
        ) : (
          <ul className="-mx-2 space-y-0.5">
            {feature.workItems.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelectWorkItem(item.id)}
                  className="group flex w-full items-start gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-zinc-50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-900 group-hover:text-indigo-700">
                      <span className="truncate">{item.title}</span>
                      {item.blocked ? <Ban className="size-3.5 shrink-0 text-rose-500" aria-label="Blocked" /> : null}
                    </p>
                    {item.summary ? <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-zinc-500">{item.summary}</p> : null}
                  </div>
                  <StateChip state={item.state} basis={item.stateBasis} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionTitle>Contributors</SectionTitle>
        <ContributorList contributors={feature.contributors} />
      </section>

      <section>
        <SectionTitle>History</SectionTitle>
        <History entries={feature.history} featureTitle={featureTitle} />
      </section>

      {merging ? (
        <MergeFeatureDialog
          open
          onClose={() => setMerging(false)}
          current={{ id: feature.id, title: feature.title.value }}
          features={graph.features}
          onMerge={async (survivingId) => {
            await api.correct(token, projectId, { kind: "merge", target: "feature", retiredId: feature.id, survivingId });
            onSelectFeature(survivingId);
            await onChanged();
            toast("Features merged");
          }}
        />
      ) : null}
    </div>
  );
}
