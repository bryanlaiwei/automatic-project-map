import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Ban, ChevronDown } from "lucide-react";
import { memo, useContext } from "react";
import type { GraphFeature } from "../../api";
import { describeCounts } from "../../format";
import { cx } from "../helpers";
import { ContributorStack, StateBar, StateDot } from "../ui";
import { MapActionsContext } from "./actions";
import { cardWidth, collapsedHeight, maxRows, rowHeight } from "./layout";

export type FeatureNodeData = {
  feature: GraphFeature;
  expanded: boolean;
  selected: boolean;
  selectedWorkItemId: string | null;
};

export type FeatureFlowNode = Node<FeatureNodeData, "feature">;

function FeatureNodeView({ data }: NodeProps<FeatureFlowNode>) {
  const actions = useContext(MapActionsContext);
  const { feature, expanded, selected, selectedWorkItemId } = data;
  const blocked = feature.workItems.filter((item) => item.blocked).length;
  const shown = feature.workItems.slice(0, maxRows);
  const hidden = feature.workItems.length - shown.length;

  return (
    <div
      className={cx(
        "group rounded-2xl bg-white text-left shadow-[0_1px_2px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.04)] ring-1 transition-[box-shadow,ring-color] duration-150",
        selected ? "ring-2 ring-indigo-500 shadow-lg shadow-indigo-500/10" : "ring-zinc-200 hover:shadow-md hover:ring-zinc-300",
      )}
      style={{ width: cardWidth }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="!pointer-events-none !opacity-0" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="!pointer-events-none !opacity-0" />
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => {
          actions.selectFeature(feature.id);
          actions.toggle(feature.id);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            actions.selectFeature(feature.id);
            actions.toggle(feature.id);
          }
        }}
        className="flex cursor-pointer flex-col justify-between rounded-2xl p-4 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        style={{ height: collapsedHeight }}
      >
        <div className="flex items-start gap-2">
          <h3 className="line-clamp-2 min-w-0 flex-1 text-[15px] leading-snug font-semibold text-zinc-900">{feature.title}</h3>
          <div className="flex shrink-0 items-center gap-1.5 pt-px">
            <ContributorStack contributors={feature.contributors} max={3} size={18} />
            <ChevronDown className={cx("size-4 text-zinc-400 transition-transform duration-200", expanded && "rotate-180")} aria-hidden />
          </div>
        </div>
        <div>
          <StateBar counts={feature.counts} />
          <p className="mt-2.5 flex min-w-0 items-center gap-1.5 text-xs text-zinc-500" title={describeCounts(feature.counts)}>
            {blocked > 0 ? (
              <span className="inline-flex shrink-0 items-center gap-1 font-medium text-rose-600">
                <Ban className="size-3" aria-hidden />
                {blocked} blocked
                <span className="text-zinc-300">·</span>
              </span>
            ) : null}
            <span className="truncate">{describeCounts(feature.counts)}</span>
          </p>
        </div>
      </div>
      {expanded ? (
        <div className="nodrag border-t border-zinc-100 px-1.5 py-1.5">
          {feature.workItems.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-zinc-400">No work items in this feature.</p>
          ) : null}
          {shown.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => actions.selectWorkItem(item.id)}
              className={cx(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors",
                item.id === selectedWorkItemId ? "bg-indigo-50 text-indigo-900 ring-1 ring-indigo-200 ring-inset" : "text-zinc-700 hover:bg-zinc-50",
              )}
              style={{ height: rowHeight }}
            >
              <StateDot state={item.state} />
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              {item.blocked ? <Ban className="size-3.5 shrink-0 text-rose-500" aria-label="Blocked" /> : null}
              {item.pullRequests.length > 0 ? (
                <span className="shrink-0 font-mono text-[11px] text-zinc-400">#{item.pullRequests[item.pullRequests.length - 1]}</span>
              ) : null}
            </button>
          ))}
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => actions.selectFeature(feature.id)}
              className="flex w-full items-center rounded-lg px-2.5 text-left text-xs font-medium text-indigo-600 hover:bg-indigo-50"
              style={{ height: rowHeight }}
            >
              Show {hidden} more in details
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const FeatureNode = memo(FeatureNodeView);
