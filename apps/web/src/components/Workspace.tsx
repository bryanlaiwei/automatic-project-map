import { ChevronDown, CircleAlert, LoaderCircle, LogOut, Mail, Settings, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errorMessage, type Graph, type Me, type Project } from "../api";
import { timeAgo } from "../format";
import { EmptyMap } from "./EmptyMap";
import { GithubMark, LogoMark } from "./GithubMark";
import { MapCanvas } from "./map/MapCanvas";
import type { MapActions } from "./map/actions";
import { freeSpot, placeNewFeatures, tidyLayout, type XY } from "./map/layout";
import { FeaturePanel } from "./panel/FeaturePanel";
import { PanelShell } from "./panel/PanelShell";
import { WorkItemPanel } from "./panel/WorkItemPanel";
import { SettingsDialog, type SettingsTab } from "./settings/SettingsDialog";
import { useToast } from "./toast-context";
import { cx, useNow } from "./helpers";
import { Avatar, Button, Menu, Spinner } from "./ui";

type Selection = { kind: "feature" | "work_item"; id: string } | null;

const pollMs = 15_000;
const delayedAfterMs = 3 * 60_000;

function useStoredSet(key: string): [Set<string>, (update: (current: Set<string>) => Set<string>) => void] {
  const [value, setValue] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const update = useCallback(
    (change: (current: Set<string>) => Set<string>) => {
      setValue((current) => {
        const next = change(current);
        window.localStorage.setItem(key, JSON.stringify([...next]));
        return next;
      });
    },
    [key],
  );
  return [value, update];
}

export function Workspace({
  token,
  me,
  invitations,
  project,
  projects,
  onSwitchProject,
  onJoined,
  onSignOut,
  onProjectGone,
}: {
  token: string;
  me: Me["user"];
  invitations: Me["invitations"];
  project: Project;
  projects: Project[];
  onSwitchProject: (projectId: string) => void;
  onJoined: (projectId: string) => void;
  onSignOut: () => void;
  onProjectGone: () => void;
}) {
  const toast = useToast();
  const now = useNow();
  const [graph, setGraph] = useState<Graph | null>(null);
  const [saved, setSaved] = useState<Map<string, XY> | null>(null);
  const [offline, setOffline] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [expanded, setExpanded] = useStoredSet(`apm:expanded:${project.id}`);
  const revisionRef = useRef<number | null>(null);
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const load = useCallback(async () => {
    try {
      const [nextGraph, layout] = await Promise.all([api.graph(tokenRef.current, project.id), api.layout(tokenRef.current, project.id)]);
      revisionRef.current = nextGraph.revision;
      setGraph(nextGraph);
      setSaved(new Map(layout.positions.map((position) => [position.nodeId, { x: position.x, y: position.y }])));
      setOffline(false);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) {
        onProjectGone();
        return;
      }
      setOffline(true);
    }
  }, [project.id, onProjectGone]);

  useEffect(() => {
    setGraph(null);
    setSaved(null);
    setSelection(null);
    void load();
  }, [load]);

  useEffect(() => {
    const check = async () => {
      try {
        const { revision } = await api.revision(tokenRef.current, project.id);
        setOffline(false);
        if (revision !== revisionRef.current) {
          await load();
        }
      } catch {
        setOffline(true);
      }
    };
    const timer = window.setInterval(() => void check(), pollMs);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [project.id, load]);

  useEffect(() => {
    if (!graph || !saved) {
      return;
    }
    const missing = graph.features.filter((feature) => !saved.has(feature.id));
    if (missing.length === 0) {
      return;
    }
    let cancelled = false;
    const place = async () => {
      const placed = saved.size === 0 && graph.features.length > 1 ? await tidyLayout(graph.features, graph.relationships) : placeNewFeatures(graph.features, saved);
      if (cancelled) {
        return;
      }
      setSaved((current) => new Map([...(current ?? []), ...placed]));
      await api
        .saveLayout(
          token,
          project.id,
          [...placed].map(([nodeId, position]) => ({ nodeId, ...position })),
        )
        .catch(() => undefined);
    };
    void place();
    return () => {
      cancelled = true;
    };
  }, [graph, saved, token, project.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || settingsTab || document.querySelector('[role="dialog"]')) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsTab]);

  const featureOfWorkItem = useMemo(() => {
    const map = new Map<string, string>();
    for (const feature of graph?.features ?? []) {
      for (const item of feature.workItems) {
        map.set(item.id, feature.id);
      }
    }
    return map;
  }, [graph]);

  const selectWorkItem = useCallback((id: string) => setSelection({ kind: "work_item", id }), []);
  const selectFeature = useCallback((id: string) => setSelection({ kind: "feature", id }), []);

  const selectedItemFeature = selection?.kind === "work_item" ? featureOfWorkItem.get(selection.id) : undefined;
  useEffect(() => {
    if (selectedItemFeature) {
      setExpanded((current) => (current.has(selectedItemFeature) ? current : new Set([...current, selectedItemFeature])));
    }
  }, [selectedItemFeature, setExpanded]);

  const actions = useMemo<MapActions>(
    () => ({
      selectFeature,
      selectWorkItem,
      toggle: (featureId) =>
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(featureId)) {
            next.delete(featureId);
          } else {
            next.add(featureId);
          }
          return next;
        }),
    }),
    [selectFeature, selectWorkItem, setExpanded],
  );

  const moveFeature = useCallback(
    (featureId: string, drop: XY) => {
      const position = freeSpot(featureId, drop, saved ?? new Map());
      setSaved((current) => new Map([...(current ?? []), [featureId, position]]));
      void api.saveLayout(token, project.id, [{ nodeId: featureId, ...position }]).catch(() => toast("Could not save the new position.", "error"));
    },
    [saved, token, project.id, toast],
  );

  const tidy = useCallback(async () => {
    if (!graph) {
      return;
    }
    const placed = await tidyLayout(graph.features, graph.relationships);
    setSaved(placed);
    try {
      await api.saveLayout(
        token,
        project.id,
        [...placed].map(([nodeId, position]) => ({ nodeId, ...position })),
      );
      toast("Map rearranged for everyone");
    } catch (reason) {
      toast(errorMessage(reason, "Could not save the layout."), "error");
    }
  }, [graph, token, project.id, toast]);

  const closePanel = useCallback(() => setSelection(null), []);
  const panelGone = useCallback(() => {
    setSelection(null);
    toast("That item is no longer on the map.", "error");
  }, [toast]);

  const selectedFeatureId = selection?.kind === "feature" ? selection.id : selection ? (featureOfWorkItem.get(selection.id) ?? null) : null;
  const selectedFeatureTitle = graph?.features.find((feature) => feature.id === selectedFeatureId)?.title;
  const pendingAge = graph?.pendingSince ? now - Date.parse(graph.pendingSince) : 0;

  return (
    <div className="flex h-full flex-col">
      <header className="z-30 flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white/90 px-4 backdrop-blur">
        <LogoMark className="size-7" />
        <span className="hidden text-sm font-semibold text-zinc-900 sm:inline">Project Map</span>
        <span className="text-zinc-300">/</span>
        {projects.length > 1 ? (
          <Menu
            trigger={(toggle) => (
              <button type="button" onClick={toggle} className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-zinc-800 hover:bg-zinc-100">
                <GithubMark className="size-4 text-zinc-500" />
                {project.owner}/{project.name}
                <ChevronDown className="size-3.5 text-zinc-400" />
              </button>
            )}
            items={projects.map((entry) => ({
              label: `${entry.owner}/${entry.name}`,
              onSelect: () => onSwitchProject(entry.id),
              disabled: entry.id === project.id,
            }))}
          />
        ) : (
          <a
            href={`https://github.com/${project.owner}/${project.name}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-zinc-800 hover:bg-zinc-100"
          >
            <GithubMark className="size-4 text-zinc-500" />
            {project.owner}/{project.name}
          </a>
        )}

        <div className="ml-auto flex items-center gap-2">
          {offline ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 ring-1 ring-rose-200">
              <WifiOff className="size-3.5" />
              Can’t reach the server. Retrying…
            </span>
          ) : graph && graph.pendingAnalysis > 0 ? (
            <button
              type="button"
              onClick={() => setSettingsTab("health")}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1",
                pendingAge > delayedAfterMs ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-zinc-50 text-zinc-600 ring-zinc-200",
              )}
              title={graph.pendingSince ? `Waiting since ${timeAgo(graph.pendingSince, now)}` : undefined}
            >
              {pendingAge > delayedAfterMs ? <CircleAlert className="size-3.5" /> : <LoaderCircle className="size-3.5 animate-spin" />}
              {pendingAge > delayedAfterMs
                ? `Analysis delayed · ${graph.pendingAnalysis} update${graph.pendingAnalysis === 1 ? "" : "s"} waiting`
                : `Analyzing ${graph.pendingAnalysis} update${graph.pendingAnalysis === 1 ? "" : "s"}`}
            </button>
          ) : null}
          {invitations.length > 0 ? (
            <Menu
              trigger={(toggle) => (
                <button
                  type="button"
                  onClick={toggle}
                  className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-100"
                >
                  <Mail className="size-3.5" />
                  {invitations.length} invitation{invitations.length === 1 ? "" : "s"}
                </button>
              )}
              items={invitations.map((invitation) => ({
                label: `Join ${invitation.project.owner}/${invitation.project.name}`,
                onSelect: () =>
                  void api
                    .acceptInvitation(token, invitation.id)
                    .then((body) => onJoined(body.projectId))
                    .catch((reason: unknown) => toast(errorMessage(reason, "Could not join the project."), "error")),
              }))}
            />
          ) : null}
          <Button variant="ghost" size="sm" icon={<Settings className="size-4" />} onClick={() => setSettingsTab("general")}>
            <span className="hidden sm:inline">Settings</span>
          </Button>
          <Menu
            trigger={(toggle) => (
              <button type="button" onClick={toggle} className="rounded-full ring-offset-2 hover:ring-2 hover:ring-zinc-200" aria-label="Account">
                {me.githubLogin ? (
                  <Avatar login={me.githubLogin} src={me.avatarUrl} size={30} />
                ) : (
                  <span className="flex size-[30px] items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
                    {(me.name ?? "?").slice(0, 1)}
                  </span>
                )}
              </button>
            )}
            items={[{ label: `Sign out${me.githubLogin ? ` @${me.githubLogin}` : ""}`, icon: <LogOut className="size-4" />, onSelect: onSignOut }]}
          />
        </div>
      </header>

      <main className="relative min-h-0 flex-1">
        {graph && saved ? (
          <MapCanvas
            projectId={project.id}
            graph={graph}
            positions={saved}
            expanded={expanded}
            selectedFeatureId={selectedFeatureId}
            selectedWorkItemId={selection?.kind === "work_item" ? selection.id : null}
            panelOpen={selection !== null}
            actions={actions}
            onMoveFeature={moveFeature}
            onTidy={tidy}
            onBackgroundClick={closePanel}
            empty={
              <EmptyMap
                pendingAnalysis={graph.pendingAnalysis}
                onConnectHelper={() => setSettingsTab("helper")}
                onInvite={() => setSettingsTab("members")}
                canInvite={project.role === "owner"}
              />
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            {offline ? <p className="text-sm text-zinc-500">Can’t reach the server. Retrying…</p> : <Spinner className="size-6" />}
          </div>
        )}

        {graph && selection ? (
          <PanelShell
            onClose={closePanel}
            header={
              selection.kind === "work_item" && selectedFeatureTitle && selectedFeatureId ? (
                <button type="button" onClick={() => selectFeature(selectedFeatureId)} className="truncate hover:text-zinc-900">
                  ← {selectedFeatureTitle}
                </button>
              ) : selection.kind === "feature" ? (
                "Feature details"
              ) : (
                "Work item details"
              )
            }
          >
            {selection.kind === "feature" ? (
              <FeaturePanel
                key={selection.id}
                token={token}
                projectId={project.id}
                featureId={selection.id}
                graph={graph}
                onSelectWorkItem={selectWorkItem}
                onSelectFeature={selectFeature}
                onChanged={load}
                onGone={panelGone}
              />
            ) : (
              <WorkItemPanel
                key={selection.id}
                token={token}
                projectId={project.id}
                workItemId={selection.id}
                graph={graph}
                onSelectWorkItem={selectWorkItem}
                onSelectFeature={selectFeature}
                onChanged={load}
                onGone={panelGone}
              />
            )}
          </PanelShell>
        ) : null}
      </main>

      {settingsTab ? (
        <SettingsDialog
          token={token}
          projectId={project.id}
          tab={settingsTab}
          onTab={setSettingsTab}
          onClose={() => setSettingsTab(null)}
          onProjectDeleted={() => {
            setSettingsTab(null);
            toast("Project deleted");
            onProjectGone();
          }}
          onLeft={() => {
            setSettingsTab(null);
            toast("You left the project");
            onProjectGone();
          }}
        />
      ) : null}
    </div>
  );
}
