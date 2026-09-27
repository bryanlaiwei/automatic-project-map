import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { GraphFeature, Relationship } from "../../api";

export type XY = { x: number; y: number };

export const cardWidth = 300;
export const collapsedHeight = 128;
export const rowHeight = 36;
export const maxRows = 8;
const listPadding = 12;
const emptyListHeight = 44;
const gapX = 56;
const gapY = 48;
const columns = 4;

/** Card heights are fixed by content counts so layout never waits for the DOM to measure them. */
export function cardHeight(feature: GraphFeature, expanded: boolean): number {
  if (!expanded) {
    return collapsedHeight;
  }
  const count = feature.workItems.length;
  if (count === 0) {
    return collapsedHeight + emptyListHeight;
  }
  const rows = Math.min(count, maxRows) + (count > maxRows ? 1 : 0);
  return collapsedHeight + rows * rowHeight + listPadding;
}

function overlaps(a: XY, b: XY): boolean {
  return a.x < b.x + cardWidth + gapX / 2 && a.x + cardWidth + gapX / 2 > b.x && a.y < b.y + collapsedHeight + gapY / 2 && a.y + collapsedHeight + gapY / 2 > b.y;
}

/**
 * Gives features without a saved position the first free grid cell, in graph order. Saved positions are
 * never changed, so existing nodes stay where people left them as new work arrives.
 */
export function placeNewFeatures(features: readonly GraphFeature[], saved: ReadonlyMap<string, XY>): Map<string, XY> {
  const occupied = [...saved.values()];
  const placed = new Map<string, XY>();
  let cell = 0;
  for (const feature of features) {
    if (saved.has(feature.id)) {
      continue;
    }
    for (;;) {
      const candidate = { x: (cell % columns) * (cardWidth + gapX), y: Math.floor(cell / columns) * (collapsedHeight + gapY) };
      cell += 1;
      if (!occupied.some((position) => overlaps(candidate, position))) {
        placed.set(feature.id, candidate);
        occupied.push(candidate);
        break;
      }
    }
  }
  return placed;
}

/** Where a dragged card lands: the drop point, or the nearest spot below it that does not cover another card. */
export function freeSpot(featureId: string, drop: XY, saved: ReadonlyMap<string, XY>): XY {
  const others = [...saved].filter(([id]) => id !== featureId).map(([, position]) => position);
  const covers = (candidate: XY) =>
    others.some(
      (other) =>
        candidate.x < other.x + cardWidth + 16 &&
        candidate.x + cardWidth + 16 > other.x &&
        candidate.y < other.y + collapsedHeight + 16 &&
        candidate.y + collapsedHeight + 16 > other.y,
    );
  for (let step = 0; step < 200; step += 1) {
    const candidate = { x: drop.x, y: drop.y + step * 8 };
    if (!covers(candidate)) {
      return candidate;
    }
  }
  return drop;
}

/** Dependencies between work items drawn once per pair of features, pointing from the prerequisite. */
export function featureEdges(features: readonly GraphFeature[], relationships: readonly Relationship[]) {
  const featureOf = new Map<string, string>();
  const titles = new Map<string, string>();
  for (const feature of features) {
    titles.set(feature.id, feature.title);
    for (const item of feature.workItems) {
      featureOf.set(item.id, feature.id);
    }
  }
  const edges = new Map<string, { id: string; source: string; target: string; count: number; label: string }>();
  for (const relationship of relationships) {
    const waiting = featureOf.get(relationship.from);
    const prerequisite = featureOf.get(relationship.to);
    if (!waiting || !prerequisite || waiting === prerequisite) {
      continue;
    }
    const id = `${prerequisite}->${waiting}`;
    const existing = edges.get(id);
    if (existing) {
      existing.count += 1;
      continue;
    }
    edges.set(id, {
      id,
      source: prerequisite,
      target: waiting,
      count: 1,
      label: `${titles.get(waiting) ?? "Feature"} waits for ${titles.get(prerequisite) ?? "feature"}`,
    });
  }
  return [...edges.values()];
}

const elk = new ELK();

/** Arranges every feature from scratch: prerequisites to the left of the work that waits for them. */
export async function tidyLayout(features: readonly GraphFeature[], relationships: readonly Relationship[]): Promise<Map<string, XY>> {
  const edges = featureEdges(features, relationships);
  const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const result = new Map<string, XY>();
  let offsetY = 0;
  if (connected.size > 0) {
    const input: ElkNode = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.spacing.nodeNode": String(gapY),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(gapX + 24),
        "elk.spacing.componentComponent": String(gapY),
        "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
        "elk.padding": "[top=0,left=0,bottom=0,right=0]",
      },
      children: features.filter((feature) => connected.has(feature.id)).map((feature) => ({ id: feature.id, width: cardWidth, height: collapsedHeight })),
      edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
    };
    const graph = await elk.layout(input);
    for (const child of graph.children ?? []) {
      result.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    }
    offsetY = (graph.height ?? 0) + gapY * 1.5;
  }
  const loose = features.filter((feature) => !connected.has(feature.id));
  const looseColumns = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(loose.length))));
  loose.forEach((feature, index) => {
    result.set(feature.id, {
      x: (index % looseColumns) * (cardWidth + gapX),
      y: offsetY + Math.floor(index / looseColumns) * (collapsedHeight + gapY),
    });
  });
  return result;
}

/**
 * Where cards are drawn. An expanded card pushes the cards below it down by its extra height, for display
 * only, so collapsing it puts everything back.
 */
export function displayPositions(
  features: readonly GraphFeature[],
  saved: ReadonlyMap<string, XY>,
  expanded: ReadonlySet<string>,
): Map<string, XY> {
  const shown = new Map<string, XY>();
  for (const feature of features) {
    const position = saved.get(feature.id);
    if (position) {
      shown.set(feature.id, { ...position });
    }
  }
  const byTop = features.filter((feature) => shown.has(feature.id)).sort((a, b) => (shown.get(a.id)?.y ?? 0) - (shown.get(b.id)?.y ?? 0));
  for (const feature of byTop) {
    if (!expanded.has(feature.id)) {
      continue;
    }
    const top = shown.get(feature.id);
    if (!top) {
      continue;
    }
    const extra = cardHeight(feature, true) - collapsedHeight;
    for (const other of byTop) {
      const position = shown.get(other.id);
      if (!position || other.id === feature.id) {
        continue;
      }
      const below = position.y >= top.y + collapsedHeight - 1;
      const sameColumn = position.x < top.x + cardWidth && position.x + cardWidth > top.x;
      if (below && sameColumn) {
        position.y += extra;
      }
    }
  }
  return shown;
}
