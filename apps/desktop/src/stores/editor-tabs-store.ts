import { create } from "zustand";
import { useDocumentStore } from "./document-store";

export interface EditorTab {
  id: string;
  path: string;
  title: string;
  isDirty: boolean;
  isPinned?: boolean;
  isAgentOpened?: boolean;
}

export interface EditorTabsState {
  tabs: EditorTab[];
  openTabIds: string[];
  activeTabId: string | null;
  pinnedTabIds: string[];
  dirtyTabIds: string[];
  agentTabIds: string[];
  tabHistory: string[];

  openTab: (
    file: { id?: string; path: string; title?: string },
    options?: { activate?: boolean; pinned?: boolean; agentOpened?: boolean },
  ) => void;
  closeTab: (tabId: string, force?: boolean) => "closed" | "prompt";
  closeOtherTabs: (tabId: string) => void;
  closeTabsToRight: (tabId: string) => void;
  closeAgentTabs: () => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  pinTab: (tabId: string) => void;
  unpinTab: (tabId: string) => void;
  togglePin: (tabId: string) => void;
  setDirty: (tabId: string, isDirty: boolean) => void;
  setActiveTab: (tabId: string) => void;
  renameTab: (oldId: string, newId: string, newName?: string) => void;
  removeTabOnDelete: (tabId: string) => void;
  resetTabs: () => void;
}

function deriveTitle(path: string, title?: string): string {
  if (title) return title;
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

let _isSyncingDocument = false;

function syncActiveFileWithDocStore(targetId: string, targetPath?: string) {
  if (_isSyncingDocument) return;
  const docStore = useDocumentStore.getState();
  const docFile = docStore.files.find(
    (f) =>
      f.id === targetId ||
      (targetPath && f.relativePath === targetPath) ||
      f.relativePath === targetId,
  );
  if (docFile && docStore.activeFileId !== docFile.id) {
    _isSyncingDocument = true;
    try {
      docStore.setActiveFile(docFile.id);
    } finally {
      _isSyncingDocument = false;
    }
  }
}

export const useEditorTabsStore = create<EditorTabsState>((set, get) => ({
  tabs: [],
  openTabIds: [],
  activeTabId: null,
  pinnedTabIds: [],
  dirtyTabIds: [],
  agentTabIds: [],
  tabHistory: [],

  openTab: (file, options) => {
    const state = get();
    const existing = state.tabs.find(
      (t) => t.id === file.id || t.path === file.path,
    );

    if (existing) {
      if (options?.activate !== false) {
        set({
          activeTabId: existing.id,
          tabHistory: [
            existing.id,
            ...state.tabHistory.filter((id) => id !== existing.id),
          ],
        });
        syncActiveFileWithDocStore(existing.id, existing.path);
      }
      return;
    }

    const tabId = file.id || file.path;
    const title = deriveTitle(file.path, file.title);
    const isPinned = options?.pinned ?? false;
    const isAgentOpened = options?.agentOpened ?? false;

    const newTab: EditorTab = {
      id: tabId,
      path: file.path,
      title,
      isDirty: false,
      isPinned,
      isAgentOpened,
    };

    let nextTabs: EditorTab[];
    if (isPinned) {
      const firstUnpinnedIndex = state.tabs.findIndex((t) => !t.isPinned);
      if (firstUnpinnedIndex === -1) {
        nextTabs = [...state.tabs, newTab];
      } else {
        nextTabs = [
          ...state.tabs.slice(0, firstUnpinnedIndex),
          newTab,
          ...state.tabs.slice(firstUnpinnedIndex),
        ];
      }
    } else {
      nextTabs = [...state.tabs, newTab];
    }

    const nextOpenIds = nextTabs.map((t) => t.id);
    const nextPinnedIds = isPinned
      ? [...state.pinnedTabIds, tabId]
      : state.pinnedTabIds;
    const nextAgentIds = isAgentOpened
      ? [...state.agentTabIds, tabId]
      : state.agentTabIds;

    const shouldActivate = options?.activate !== false;
    const nextActiveId = shouldActivate ? tabId : state.activeTabId;
    const nextHistory = shouldActivate
      ? [tabId, ...state.tabHistory.filter((id) => id !== tabId)]
      : state.tabHistory;

    set({
      tabs: nextTabs,
      openTabIds: nextOpenIds,
      pinnedTabIds: nextPinnedIds,
      agentTabIds: nextAgentIds,
      activeTabId: nextActiveId,
      tabHistory: nextHistory,
    });

    if (shouldActivate) {
      syncActiveFileWithDocStore(tabId, file.path);
    }
  },

  closeTab: (tabId, force = false) => {
    const state = get();
    const index = state.tabs.findIndex(
      (t) => t.id === tabId || t.path === tabId,
    );
    if (index === -1) return "closed";

    const tab = state.tabs[index];
    if (!force && tab.isDirty) {
      return "prompt";
    }

    const nextTabs = state.tabs.filter(
      (t) => t.id !== tab.id && t.path !== tab.path,
    );
    const nextOpenIds = nextTabs.map((t) => t.id);
    const nextPinnedIds = state.pinnedTabIds.filter((id) => id !== tab.id);
    const nextDirtyIds = state.dirtyTabIds.filter((id) => id !== tab.id);
    const nextAgentIds = state.agentTabIds.filter((id) => id !== tab.id);
    let nextHistory = state.tabHistory.filter((id) => id !== tab.id);

    let nextActiveId = state.activeTabId;
    if (state.activeTabId === tab.id || state.activeTabId === tab.path) {
      if (nextTabs.length === 0) {
        nextActiveId = null;
        nextHistory = [];
      } else {
        const nextIndex = Math.min(index, nextTabs.length - 1);
        nextActiveId = nextTabs[nextIndex].id;
        nextHistory = [
          nextActiveId,
          ...state.tabHistory.filter(
            (id) => id !== tab.id && id !== nextActiveId,
          ),
        ];
      }
    }

    set({
      tabs: nextTabs,
      openTabIds: nextOpenIds,
      pinnedTabIds: nextPinnedIds,
      dirtyTabIds: nextDirtyIds,
      agentTabIds: nextAgentIds,
      activeTabId: nextActiveId,
      tabHistory: nextHistory,
    });

    if (nextActiveId) {
      syncActiveFileWithDocStore(nextActiveId);
    }

    return "closed";
  },

  closeOtherTabs: (tabId) => {
    const state = get();
    const target = state.tabs.find((t) => t.id === tabId || t.path === tabId);
    if (!target) return;

    const nextTabs = state.tabs.filter((t) => t.id === target.id || t.isPinned);

    set({
      tabs: nextTabs,
      openTabIds: nextTabs.map((t) => t.id),
      pinnedTabIds: nextTabs.filter((t) => t.isPinned).map((t) => t.id),
      dirtyTabIds: state.dirtyTabIds.filter((id) =>
        nextTabs.some((t) => t.id === id),
      ),
      agentTabIds: state.agentTabIds.filter((id) =>
        nextTabs.some((t) => t.id === id),
      ),
      activeTabId: target.id,
      tabHistory: [
        target.id,
        ...state.tabHistory.filter(
          (id) => id !== target.id && nextTabs.some((t) => t.id === id),
        ),
      ],
    });

    syncActiveFileWithDocStore(target.id, target.path);
  },

  closeTabsToRight: (tabId) => {
    const state = get();
    const targetIndex = state.tabs.findIndex(
      (t) => t.id === tabId || t.path === tabId,
    );
    if (targetIndex === -1) return;

    const nextTabs = state.tabs.filter(
      (t, idx) => idx <= targetIndex || t.isPinned,
    );

    const activeClosed = !nextTabs.some((t) => t.id === state.activeTabId);
    const nextActiveId = activeClosed
      ? state.tabs[targetIndex].id
      : state.activeTabId;

    set({
      tabs: nextTabs,
      openTabIds: nextTabs.map((t) => t.id),
      pinnedTabIds: nextTabs.filter((t) => t.isPinned).map((t) => t.id),
      dirtyTabIds: state.dirtyTabIds.filter((id) =>
        nextTabs.some((t) => t.id === id),
      ),
      agentTabIds: state.agentTabIds.filter((id) =>
        nextTabs.some((t) => t.id === id),
      ),
      activeTabId: nextActiveId,
      tabHistory: state.tabHistory.filter((id) =>
        nextTabs.some((t) => t.id === id),
      ),
    });

    if (activeClosed && nextActiveId) {
      syncActiveFileWithDocStore(nextActiveId);
    }
  },

  closeAgentTabs: () => {
    const state = get();
    const nextTabs = state.tabs.filter((t) => !t.isAgentOpened || t.isPinned);
    if (nextTabs.length === state.tabs.length) return;

    let nextActiveId = state.activeTabId;
    if (!nextTabs.some((t) => t.id === state.activeTabId)) {
      nextActiveId =
        nextTabs.length > 0 ? nextTabs[nextTabs.length - 1].id : null;
    }

    set({
      tabs: nextTabs,
      openTabIds: nextTabs.map((t) => t.id),
      pinnedTabIds: nextTabs.filter((t) => t.isPinned).map((t) => t.id),
      dirtyTabIds: state.dirtyTabIds.filter((id) =>
        nextTabs.some((t) => t.id === id),
      ),
      agentTabIds: [],
      activeTabId: nextActiveId,
      tabHistory: state.tabHistory.filter((id) =>
        nextTabs.some((t) => t.id === id),
      ),
    });

    if (nextActiveId) {
      syncActiveFileWithDocStore(nextActiveId);
    }
  },

  reorderTabs: (fromIndex, toIndex) => {
    const state = get();
    if (
      fromIndex < 0 ||
      fromIndex >= state.tabs.length ||
      toIndex < 0 ||
      toIndex >= state.tabs.length ||
      fromIndex === toIndex
    ) {
      return;
    }

    const pinnedCount = state.tabs.filter((t) => t.isPinned).length;
    const isFromPinned = Boolean(state.tabs[fromIndex]?.isPinned);

    if (isFromPinned) {
      if (toIndex < 0 || toIndex >= pinnedCount) {
        return;
      }
    } else {
      if (toIndex < pinnedCount || toIndex >= state.tabs.length) {
        return;
      }
    }

    const nextTabs = [...state.tabs];
    const [moved] = nextTabs.splice(fromIndex, 1);
    nextTabs.splice(toIndex, 0, moved);

    set({
      tabs: nextTabs,
      openTabIds: nextTabs.map((t) => t.id),
    });
  },

  pinTab: (tabId) => {
    const state = get();
    const index = state.tabs.findIndex(
      (t) => t.id === tabId || t.path === tabId,
    );
    if (index === -1) return;

    const tab = state.tabs[index];
    if (tab.isPinned) return;

    const updatedTab = { ...tab, isPinned: true };
    const remaining = state.tabs.filter((t) => t.id !== tab.id);
    const firstUnpinnedIndex = remaining.findIndex((t) => !t.isPinned);
    const nextTabs =
      firstUnpinnedIndex === -1
        ? [...remaining, updatedTab]
        : [
            ...remaining.slice(0, firstUnpinnedIndex),
            updatedTab,
            ...remaining.slice(firstUnpinnedIndex),
          ];

    set({
      tabs: nextTabs,
      openTabIds: nextTabs.map((t) => t.id),
      pinnedTabIds: [...state.pinnedTabIds, tab.id],
    });
  },

  unpinTab: (tabId) => {
    const state = get();
    const index = state.tabs.findIndex(
      (t) => t.id === tabId || t.path === tabId,
    );
    if (index === -1) return;

    const tab = state.tabs[index];
    if (!tab.isPinned) return;

    const updatedTab = { ...tab, isPinned: false };
    const nextTabs = state.tabs.map((t) => (t.id === tab.id ? updatedTab : t));

    set({
      tabs: nextTabs,
      openTabIds: nextTabs.map((t) => t.id),
      pinnedTabIds: state.pinnedTabIds.filter((id) => id !== tab.id),
    });
  },

  togglePin: (tabId) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId || t.path === tabId);
    if (!tab) return;
    if (tab.isPinned) {
      state.unpinTab(tabId);
    } else {
      state.pinTab(tabId);
    }
  },

  setDirty: (tabId, isDirty) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId || t.path === tabId);
    if (!tab) return;

    const nextTabs = state.tabs.map((t) =>
      t.id === tab.id ? { ...t, isDirty } : t,
    );

    const nextDirtyIds = isDirty
      ? Array.from(new Set([...state.dirtyTabIds, tab.id]))
      : state.dirtyTabIds.filter((id) => id !== tab.id);

    set({
      tabs: nextTabs,
      dirtyTabIds: nextDirtyIds,
    });
  },

  setActiveTab: (tabId) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId || t.path === tabId);
    if (!tab) return;

    set({
      activeTabId: tab.id,
      tabHistory: [tab.id, ...state.tabHistory.filter((id) => id !== tab.id)],
    });

    syncActiveFileWithDocStore(tab.id, tab.path);
  },

  renameTab: (oldId, newId, newName) => {
    const state = get();
    const nextTabs = state.tabs.map((t) => {
      if (t.id === oldId || t.path === oldId) {
        const title = newName ?? deriveTitle(newId);
        return { ...t, id: newId, path: newId, title };
      }
      return t;
    });

    const remap = (id: string) => (id === oldId ? newId : id);

    set({
      tabs: nextTabs,
      openTabIds: nextTabs.map((t) => t.id),
      pinnedTabIds: state.pinnedTabIds.map(remap),
      dirtyTabIds: state.dirtyTabIds.map(remap),
      agentTabIds: state.agentTabIds.map(remap),
      activeTabId: state.activeTabId === oldId ? newId : state.activeTabId,
      tabHistory: state.tabHistory.map(remap),
    });
  },

  removeTabOnDelete: (tabId) => {
    get().closeTab(tabId, true);
  },

  resetTabs: () => {
    set({
      tabs: [],
      openTabIds: [],
      activeTabId: null,
      pinnedTabIds: [],
      dirtyTabIds: [],
      agentTabIds: [],
      tabHistory: [],
    });
  },
}));

/**
 * Class representation of EditorTabsStore mirroring Zustand API
 * for standalone usage or testing environments.
 */
export class EditorTabsStore {
  public tabs: EditorTab[] = [];
  public activeTabId: string | null = null;
  public pinnedTabIds: string[] = [];
  public dirtyTabIds: string[] = [];

  public openTab(
    file: { path: string; title?: string },
    options?: { activate?: boolean; pinned?: boolean },
  ): void {
    const existing = this.tabs.find((t) => t.path === file.path);
    if (existing) {
      if (options?.activate !== false) {
        this.activeTabId = existing.id;
      }
      return;
    }
    const newTab: EditorTab = {
      id: `tab_${Math.random().toString(36).slice(2, 8)}`,
      path: file.path,
      title: file.title || deriveTitle(file.path),
      isDirty: false,
      isPinned: options?.pinned ?? false,
    };
    if (newTab.isPinned) {
      const idx = this.tabs.findIndex((t) => !t.isPinned);
      if (idx === -1) this.tabs.push(newTab);
      else this.tabs.splice(idx, 0, newTab);
    } else {
      this.tabs.push(newTab);
    }
    if (options?.activate !== false) {
      this.activeTabId = newTab.id;
    }
  }

  public closeTab(id: string, force = false): "closed" | "prompt" {
    const index = this.tabs.findIndex((t) => t.id === id || t.path === id);
    if (index === -1) return "closed";
    if (!force && this.tabs[index].isDirty) {
      return "prompt";
    }
    const [closed] = this.tabs.splice(index, 1);
    if (this.activeTabId === closed.id) {
      if (this.tabs.length === 0) {
        this.activeTabId = null;
      } else {
        const nextIndex = Math.min(index, this.tabs.length - 1);
        this.activeTabId = this.tabs[nextIndex].id;
      }
    }
    return "closed";
  }

  public setDirty(id: string, isDirty: boolean): void {
    const tab = this.tabs.find((t) => t.id === id || t.path === id);
    if (tab) tab.isDirty = isDirty;
  }

  public reorderTabs(fromIndex: number, toIndex: number): void {
    if (
      fromIndex < 0 ||
      fromIndex >= this.tabs.length ||
      toIndex < 0 ||
      toIndex >= this.tabs.length ||
      fromIndex === toIndex
    ) {
      return;
    }

    const pinnedCount = this.tabs.filter((t) => t.isPinned).length;
    const isFromPinned = Boolean(this.tabs[fromIndex]?.isPinned);

    if (isFromPinned) {
      if (toIndex < 0 || toIndex >= pinnedCount) {
        return;
      }
    } else {
      if (toIndex < pinnedCount || toIndex >= this.tabs.length) {
        return;
      }
    }

    const [moved] = this.tabs.splice(fromIndex, 1);
    this.tabs.splice(toIndex, 0, moved);
  }
}

/**
 * Builds an overlay mapping from all dirty or active editor buffers
 * to satisfy multi-tab compilation without disk saves.
 */
export function buildMultiTabCompileOverlay(): Record<string, string> {
  const docFiles = useDocumentStore.getState().files;
  const dirtyTabIds = new Set(useEditorTabsStore.getState().dirtyTabIds);
  const overlay: Record<string, string> = {};

  for (const file of docFiles) {
    if (
      (file.isDirty ||
        dirtyTabIds.has(file.id) ||
        dirtyTabIds.has(file.relativePath)) &&
      typeof file.content === "string"
    ) {
      overlay[file.relativePath] = file.content;
    }
  }
  return overlay;
}
