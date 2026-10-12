import { useCallback, useMemo, useRef, useState } from "react";
import type { AgentFileState, FileUpdate, SessionInfo, Tab, WorkspaceIdentity } from "@shared/types";
import { EditorPersistence, type FileUpdateOrigin, type SaveSnapshot } from "./editor-persistence";

interface EditorHost {
  sessionRef: Readonly<{ current: SessionInfo | null }>;
  panelsRef: Readonly<{ current: readonly SessionInfo[] }>;
  panelFor: (workspace: WorkspaceIdentity) => SessionInfo | null;
  focusSession: (sessionID: string) => void;
  agentFilesRef: Readonly<{ current: Readonly<Record<string, ReadonlyMap<string, AgentFileState>>> }>;
  notify: (text: string, tone?: "info" | "error") => void;
}

export interface EditorPathMove { path: string; newPath: string; name: string }

const EMPTY_TABS: Tab[] = [];
const MAX_EDITABLE_BYTES = 4 * 1024 * 1024;

function dropKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function useWorkspaceEditor(host: EditorHost) {
  const { sessionRef, panelsRef, panelFor, focusSession, agentFilesRef: agentFilesByWorkspaceRef, notify: toast } = host;
  const session = sessionRef.current;
  const panels = panelsRef.current;
  const [tabsByWorkspace, setTabsByWorkspace] = useState<Record<string, Tab[]>>({});
  const [activePathByWorkspace, setActivePathByWorkspace] = useState<Record<string, string | null>>({});
  const [singleFileByWorkspace, setSingleFileByWorkspace] = useState<Record<string, string>>({});
  const tabsByWorkspaceRef = useRef(tabsByWorkspace);
  tabsByWorkspaceRef.current = tabsByWorkspace;
  const activePathByWorkspaceRef = useRef(activePathByWorkspace);
  activePathByWorkspaceRef.current = activePathByWorkspace;
  const persistenceRef = useRef<EditorPersistence | null>(null);
  if (!persistenceRef.current) {
    persistenceRef.current = new EditorPersistence((snapshot, write) => {
      if (snapshot.standalone) {
        return window.openshell.writeStandalone(snapshot.path, snapshot.content, write.expectedContent, write.overwrite ?? false);
      }
      return window.openshell.writeFile(snapshot.workspace, snapshot.path, snapshot.content, write);
    });
  }
  const persistence = persistenceRef.current;
  const doSaveRef = useRef<(snapshot: SaveSnapshot, allowConflict?: boolean) => Promise<boolean>>(async () => false);
  const setTabsFor = useCallback((workspaceID: string, update: (prev: Tab[]) => Tab[]) => {
    setTabsByWorkspace((current) => {
      const next = update(current[workspaceID] ?? []);
      return next === (current[workspaceID] ?? []) ? current : { ...current, [workspaceID]: next };
    });
  }, []);

  const setActivePathFor = useCallback((workspaceID: string, path: string | null) => {
    const current = activePathByWorkspaceRef.current;
    if (current[workspaceID] === path) return;
    const next = { ...current, [workspaceID]: path };
    activePathByWorkspaceRef.current = next;
    setActivePathByWorkspace(next);
  }, []);

  const setSingleFileFor = useCallback((workspaceID: string, path: string | null) => {
    setSingleFileByWorkspace((current) =>
      current[workspaceID] === path ? current
        : path === null
          ? dropKey(current, workspaceID)
          : { ...current, [workspaceID]: path });
  }, []);

  const tabs = session ? tabsByWorkspace[session.workspace.id] ?? EMPTY_TABS : EMPTY_TABS;
  const unsavedEditorFiles = useMemo(() => Object.entries(tabsByWorkspace).flatMap(([workspaceID, workspaceTabs]) => {
    const owner = panels.find((panel) => panel.workspace.id === workspaceID);
    return workspaceTabs.filter((tab) => tab.dirty).map((tab) => ({
      workspaceID,
      sessionID: owner?.id ?? null,
      workspace: owner?.workspace ?? null,
      path: tab.path,
      standalone: tab.standalone === true,
      displayPath: tab.standalone || !owner
        ? tab.path
        : `${owner.directory.replace(/[\\/]+$/, "")}/${tab.path.replace(/^[\\/]+/, "")}`
    }));
  }), [tabsByWorkspace, panels]);
  const unsavedEditorFileCount = unsavedEditorFiles.length;
  const activePath = session ? activePathByWorkspace[session.workspace.id] ?? null : null;
  const singleFile = session ? singleFileByWorkspace[session.workspace.id] ?? null : null;
  const openFile = useCallback(
    async (path: string, opts?: { mode?: "edit" | "diff" }, workspace?: WorkspaceIdentity) => {
      const target = workspace ?? sessionRef.current?.workspace;
      if (!target) return;
      const currentTabs = target ? (tabsByWorkspaceRef.current[target.id] ?? []) : [];
      const existing = currentTabs.find((t) => t.path === path);
      if (existing) {
        if (!target) return;
        setActivePathFor(target.id, path);
        if (opts?.mode && existing.mode !== opts.mode) {
          setTabsFor(target.id, (prev) => prev.map((t) => (t.path === path ? { ...t, mode: opts.mode! } : t)));
        }
        return;
      }
      try {
        const agentFile = target ? (agentFilesByWorkspaceRef.current[target.id] ?? new Map()).get(path) : undefined;
        let content = await window.openshell.readFile(target, path);
        if (!panelFor(target)) return;
        if (content === null && agentFile?.deleted) content = "";
        if (content === null) {
          toast(`Could not read ${path}`, "error");
          return;
        }
        if (content.length > MAX_EDITABLE_BYTES) {
          toast(`${path} is too large to open in the editor`, "error");
          return;
        }
        if (content.includes("\u0000")) {
          toast(`${path} is a binary file`, "error");
          return;
        }
        const name = path.split("/").pop() ?? path;
        const tab: Tab = {
          path,
          name,
          content,
          saved: content,
          baseline: agentFile?.baseline ?? null,
          deleted: agentFile?.deleted ?? false,
          dirty: false,
          stale: false,
          revision: 0,
          conflict: null,
          mode: opts?.mode ?? "edit",
          binary: false
        };
        setTabsFor(target.id, (prev) => [...prev, tab]);
        setActivePathFor(target.id, path);
      } catch (err) {
        if (target && panelFor(target)) toast(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [toast, panelFor, setTabsFor, setActivePathFor]
  );
  const openExternalPath = useCallback(
    async (absolutePath: string, workspace?: WorkspaceIdentity): Promise<string | null> => {
      const target = workspace ?? sessionRef.current?.workspace ?? panelsRef.current[panelsRef.current.length - 1]?.workspace;
      if (!target) return null;
      const panel = panelFor(target);
      if (!panel) return null;
      if (!sessionRef.current || sessionRef.current.id !== panel.id) focusSession(panel.id);
      try {
        const result = await window.openshell.openExternal(target, absolutePath);
        if (result.kind === "relative") {
          await openFile(result.rel, {}, target);
          return result.rel;
        }
        const path = result.path;
        if ((tabsByWorkspaceRef.current[target.id] ?? []).some((t) => t.path === path)) {
          setActivePathFor(target.id, path);
          return path;
        }
        if (result.content === null) {
          toast(`Could not read ${path}`, "error");
          return null;
        }
        if (result.content.length > MAX_EDITABLE_BYTES) {
          toast(`${path} is too large to open in the editor`, "error");
          return null;
        }
        if (result.content.includes("\u0000")) {
          toast(`${path} is a binary file`, "error");
          return null;
        }
        const name = path.split(/[\\/]/).pop() ?? path;
        const tab: Tab = {
          path,
          name,
          content: result.content,
          saved: result.content,
          baseline: null,
          deleted: false,
          dirty: false,
          stale: false,
          revision: 0,
          conflict: null,
          mode: "edit",
          binary: false,
          standalone: true
        };
        setTabsFor(target.id, (prev) => [...prev, tab]);
        setActivePathFor(target.id, path);
        return path;
      } catch (err) {
        if (panelFor(target)) toast(err instanceof Error ? err.message : String(err), "error");
        return null;
      }
    },
    [openFile, toast, panelFor, focusSession, setTabsFor, setActivePathFor]
  );
  const setActive = useCallback((path: string) => {
    const target = sessionRef.current?.workspace;
    if (target) setActivePathFor(target.id, path);
  }, [setActivePathFor]);

  const setTabMode = useCallback((path: string, mode: "edit" | "diff") => {
    const target = sessionRef.current?.workspace;
    if (!target) return;
    setTabsFor(target.id, (prev) => prev.map((t) => (t.path === path ? { ...t, mode } : t)));
  }, [setTabsFor]);

  const doSave = useCallback(
    async (snapshot: SaveSnapshot, allowConflict = false) => {
      const workspaceID = snapshot.workspace.id;
      const current = (tabsByWorkspaceRef.current[workspaceID] ?? []).find((tab) => tab.path === snapshot.path);
      if (!current || (!allowConflict && current.conflict)) return false;
      try {
        const result = await persistence.save(snapshot);
        if (result !== "saved") return false;
        const latest = (tabsByWorkspaceRef.current[workspaceID] ?? []).find((tab) => tab.path === snapshot.path);
        if (!latest || latest.revision !== snapshot.revision) return false;
        setTabsFor(workspaceID, (prev) =>
          prev.map((t) =>
            t.path === snapshot.path && t.revision === snapshot.revision
              ? {
                  ...t,
                  saved: snapshot.content,
                  dirty: false,
                  stale: false,
                  conflict: null,
                  baseline: t.standalone ? t.baseline : (t.baseline ?? { kind: "known", content: snapshot.expectedContent }),
                  deleted: false
                }
              : t
          )
        );
        return true;
      } catch (err) {
        toast(`Failed to save ${snapshot.path}: ${err instanceof Error ? err.message : String(err)}`, "error");
        return false;
      }
    },
    [persistence, toast, setTabsFor]
  );
  doSaveRef.current = doSave;

  const saveAllEditorFiles = useCallback(async (): Promise<boolean> => {
    const snapshots: SaveSnapshot[] = [];
    for (const [workspaceID, workspaceTabs] of Object.entries(tabsByWorkspaceRef.current)) {
      const workspace = panelsRef.current.find((panel) => panel.workspace.id === workspaceID)?.workspace;
      for (const tab of workspaceTabs) {
        if (!tab.dirty) continue;
        if (!workspace || tab.conflict) {
          toast(`Cannot save ${tab.path}: ${tab.conflict ? "resolve its external file conflict first" : "its workspace is closed"}.`, "error");
          return false;
        }
        snapshots.push({ workspace, path: tab.path, content: tab.content, expectedContent: tab.saved, revision: tab.revision, standalone: tab.standalone });
      }
    }
    const results = await Promise.all(snapshots.map((snapshot) => doSave(snapshot)));
    if (!results.every(Boolean)) return false;
    // Save completions can precede React's commit; approve only the revisions this batch saved.
    return Object.entries(tabsByWorkspaceRef.current).every(([workspaceID, tabs]) => tabs.every((tab) =>
      !tab.dirty || (!tab.conflict && snapshots.some((snapshot) =>
        snapshot.workspace.id === workspaceID && snapshot.path === tab.path && snapshot.revision === tab.revision && snapshot.content === tab.content
      ))
    ));
  }, [doSave, toast]);

  const closeTab = useCallback((path: string) => {
    const target = sessionRef.current?.workspace;
    if (!target) return;
    const tab = (tabsByWorkspaceRef.current[target.id] ?? []).find((candidate) => candidate.path === path);
    if (!tab) return;
    const removeIfClean = (): void => {
      setTabsFor(target.id, (prev) => {
        const current = prev.find((candidate) => candidate.path === path);
        if (!current || current.dirty || current.conflict) return prev;
        const next = prev.filter((candidate) => candidate.path !== path);
        const active = activePathByWorkspaceRef.current[target.id] ?? null;
        if (active === path) {
          const index = prev.findIndex((candidate) => candidate.path === path);
          const neighbor = next[index] ?? next[next.length - 1];
          setActivePathFor(target.id, neighbor?.path ?? null);
        }
        return next;
      });
    };
    if (tab.dirty) {
      if (tab.conflict) return;
      void doSave({
        workspace: target,
        path,
        content: tab.content,
        expectedContent: tab.saved,
        revision: tab.revision,
        standalone: tab.standalone
      }).then((saved) => {
        if (saved) removeIfClean();
      });
      return;
    }
    persistence.cancelPath(target, path);
    removeIfClean();
  }, [doSave, persistence, setTabsFor, setActivePathFor]);

  const saveTab = useCallback(
    async (path: string) => {
      const target = sessionRef.current?.workspace;
      const tab = target
        ? (tabsByWorkspaceRef.current[target.id] ?? []).find((candidate) => candidate.path === path)
        : undefined;
      if (!target || !tab || tab.conflict) return;
      await doSave({
        workspace: target,
        path,
        content: tab.content,
        expectedContent: tab.saved,
        revision: tab.revision,
        standalone: tab.standalone
      });
    },
    [doSave]
  );

  const editContent = useCallback(
    (path: string, content: string) => {
      const target = sessionRef.current?.workspace;
      const tab = target
        ? (tabsByWorkspaceRef.current[target.id] ?? []).find((candidate) => candidate.path === path)
        : undefined;
      if (!target || !tab || tab.content === content) return;
      setTabsFor(target.id, (prev) => prev.map((candidate) => candidate.path === path
        ? { ...candidate, content, revision: candidate.revision + 1, dirty: content !== candidate.saved }
        : candidate));
    },
    [setTabsFor]
  );

  const reloadTab = useCallback((path: string) => {
    const target = sessionRef.current?.workspace;
    if (!target) return;
    persistence.cancelPath(target, path);
    setTabsFor(target.id, (prev) => prev.map((tab) => {
      if (tab.path !== path || !tab.conflict) return tab;
      const content = tab.conflict.content ?? "";
      return {
        ...tab,
        content,
        saved: content,
        dirty: false,
        stale: false,
        deleted: tab.conflict.deleted,
        revision: tab.revision + 1,
        conflict: null
      };
    }));
  }, [persistence, setTabsFor]);

  const overwriteTab = useCallback(async (path: string) => {
    const target = sessionRef.current?.workspace;
    const tab = target
      ? (tabsByWorkspaceRef.current[target.id] ?? []).find((candidate) => candidate.path === path)
      : undefined;
    if (!target || !tab?.conflict) return;
    await doSave({
      workspace: target,
      path,
      content: tab.content,
      expectedContent: tab.saved,
      revision: tab.revision,
      overwrite: true,
      standalone: tab.standalone
    }, true);
  }, [doSave]);

  const mergeTab = useCallback((path: string) => {
    const target = sessionRef.current?.workspace;
    if (!target) return;
    setTabsFor(target.id, (prev) => prev.map((tab) => tab.path === path && tab.conflict
      ? { ...tab, conflict: { ...tab.conflict, resolution: "merge" } }
      : tab));
  }, [setTabsFor]);

  const getTabs = useCallback((workspaceID: string): Tab[] => tabsByWorkspaceRef.current[workspaceID] ?? [], []);
  const dirtyTabsFor = useCallback((workspaceID: string): Tab[] => getTabs(workspaceID).filter((tab) => tab.dirty || tab.conflict), [getTabs]);
  const cancelPrefix = useCallback((workspace: WorkspaceIdentity, path: string): void => persistence.cancelPrefix(workspace, path), [persistence]);
  const cancelAll = useCallback((): void => persistence.cancelAll(), [persistence]);
  const addCreatedFile = useCallback((target: WorkspaceIdentity, targetPath: string): void => {
    if (!(tabsByWorkspaceRef.current[target.id] ?? []).some((t) => t.path === targetPath)) {
      const name = targetPath.split("/").pop() ?? targetPath;
      const tab: Tab = {
        path: targetPath,
        name,
        content: "",
        saved: "",
        baseline: null,
        deleted: false,
        dirty: false,
        stale: false,
        revision: 0,
        conflict: null,
        mode: "edit",
        binary: false
      };
      setTabsFor(target.id, (prev) => [...prev, tab]);
      setActivePathFor(target.id, targetPath);
    }
  }, [setTabsFor, setActivePathFor]);
  const removePathTabs = useCallback((target: WorkspaceIdentity, path: string): void => {
    const prefix = `${path}/`;
    setTabsFor(target.id, (prev) => {
      const next = prev.filter((t) => t.path !== path && !t.path.startsWith(prefix));
      if (next.length !== prev.length) {
        setActivePathFor(target.id, (() => {
          const active = activePathByWorkspaceRef.current[target.id] ?? null;
          if (!active || (active !== path && !active.startsWith(prefix))) return active;
          const idx = prev.findIndex((t) => t.path === active);
          const neighbor = next[idx] ?? next[next.length - 1];
          return neighbor ? neighbor.path : null;
        })());
      }
      return next;
    });
  }, [setTabsFor, setActivePathFor]);
  const removePathsTabs = useCallback((workspace: WorkspaceIdentity, deleted: string[]): void => {
    const wasDeleted = (path: string): boolean => deleted.some((item) => path === item || path.startsWith(`${item}/`));
    const currentTabs = tabsByWorkspaceRef.current[workspace.id] ?? [];
    const nextTabs = currentTabs.filter((tab) => !wasDeleted(tab.path));
    const active = activePathByWorkspaceRef.current[workspace.id] ?? null;
    if (active && wasDeleted(active)) {
      const index = currentTabs.findIndex((tab) => tab.path === active);
      setActivePathFor(workspace.id, nextTabs[index]?.path ?? nextTabs[nextTabs.length - 1]?.path ?? null);
    }
    setTabsFor(workspace.id, (prev) => prev.filter((tab) => !wasDeleted(tab.path)));
  }, [setTabsFor, setActivePathFor]);
  const renameTabs = useCallback((target: WorkspaceIdentity, previousPath: string, newPath: string, name: string, capturedActive: string | null): void => {
    setTabsFor(target.id, (prev) =>
      prev.map((t) =>
        t.path === previousPath || t.path.startsWith(`${previousPath}/`)
          ? {
              ...t,
              path: t.path.replace(previousPath, newPath),
              name: t.path === previousPath ? name : t.name
            }
          : t
      )
    );
    setActivePathFor(target.id, (() => {
      const active = capturedActive;
      return active && (active === previousPath || active.startsWith(`${previousPath}/`))
        ? active.replace(previousPath, newPath)
        : active;
    })());
  }, [setTabsFor, setActivePathFor]);
  const movePathTabs = useCallback((target: WorkspaceIdentity, path: string, newPath: string, name: string): void => {
    setTabsFor(target.id, (prev) =>
      prev.map((t) =>
        t.path === path || t.path.startsWith(`${path}/`)
          ? { ...t, path: `${newPath}${t.path.slice(path.length)}`, name: t.path === path ? name : t.name }
          : t
      )
    );
    setActivePathFor(target.id, (() => {
      const active = activePathByWorkspaceRef.current[target.id] ?? null;
      return active && (active === path || active.startsWith(`${path}/`))
        ? `${newPath}${active.slice(path.length)}`
        : active;
    })());
  }, [setTabsFor, setActivePathFor]);
  const movePathsTabs = useCallback((workspace: WorkspaceIdentity, moved: EditorPathMove[]): ((path: string) => string) => {
    const remap = (path: string): string => {
      const parent = moved.find((item) => path === item.path || path.startsWith(`${item.path}/`));
      return parent ? `${parent.newPath}${path.slice(parent.path.length)}` : path;
    };
    setTabsFor(workspace.id, (prev) => prev.map((tab) => {
      const path = remap(tab.path);
      return path === tab.path ? tab : {
        ...tab,
        path,
        name: moved.find((item) => item.path === tab.path)?.name ?? tab.name
      };
    }));
    const active = activePathByWorkspaceRef.current[workspace.id] ?? null;
    if (active) {
      const next = remap(active);
      if (next !== active) setActivePathFor(workspace.id, next);
    }
    return remap;
  }, [setTabsFor, setActivePathFor]);
  const prepareFileUpdate = useCallback((f: FileUpdate): FileUpdateOrigin => {
    if (f.movedFrom && f.movedFrom !== f.path) {
      persistence.cancelPath(f.workspace, f.movedFrom);
      const targetAlreadyOpen = (tabsByWorkspaceRef.current[f.workspace.id] ?? [])
        .some((tab) => tab.path === f.path);
      if (!targetAlreadyOpen) {
        setTabsFor(f.workspace.id, (prev) => prev.map((tab) => tab.path === f.movedFrom
          ? { ...tab, path: f.path, name: f.path.split("/").pop() ?? f.path }
          : tab));
        if (activePathByWorkspaceRef.current[f.workspace.id] === f.movedFrom) {
          setActivePathFor(f.workspace.id, f.path);
        }
      }
    }
    return persistence.classify(f.workspace, f);
  }, [persistence, setTabsFor, setActivePathFor]);
  const applyFileUpdate = useCallback((f: FileUpdate, origin: FileUpdateOrigin): void => {
    setTabsFor(f.workspace.id, (prev) =>
      prev.map((tab) => {
        if (tab.path !== f.path) return tab;
        if (origin === "echo") return tab;
        if (tab.dirty) {
          return {
            ...tab,
            baseline: f.baseline,
            stale: true,
            deleted: f.deleted,
            conflict: { content: f.content, deleted: f.deleted, resolution: "pending" }
          };
        }
        const content = f.content ?? tab.content;
        return {
          ...tab,
          content,
          saved: content,
          baseline: f.baseline,
          deleted: f.deleted,
          stale: false,
          conflict: null
        };
      })
    );
  }, [setTabsFor]);
  return {
    tabs, activePath, singleFile, unsavedEditorFiles, unsavedEditorFileCount,
    activePathByWorkspace: activePathByWorkspace as Readonly<Record<string, string | null>>,
    dirtyTabsFor, doSaveRef,
    openFile, openExternalPath, setActive, setTabMode, saveAllEditorFiles,
    closeTab, saveTab, editContent, reloadTab, overwriteTab, mergeTab,
    setSingleFileFor, addCreatedFile, removePathTabs, removePathsTabs,
    renameTabs, movePathTabs, movePathsTabs, prepareFileUpdate, applyFileUpdate,
    cancelPrefix, cancelAll
  };
}
