import React, { useState, useRef, useCallback } from "react";
import {
  XIcon,
  PinIcon,
  FileTextIcon,
  FileCodeIcon,
  BotIcon,
  ChevronDownIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorTabsStore, type EditorTab } from "@/stores/editor-tabs-store";
import { useDocumentStore } from "@/stores/document-store";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

function getFileIcon(path: string) {
  if (path.endsWith(".typ")) {
    return <FileCodeIcon className="size-3.5 shrink-0 text-blue-500" />;
  }
  if (path.endsWith(".tex")) {
    return <FileCodeIcon className="size-3.5 shrink-0 text-emerald-500" />;
  }
  if (path.endsWith(".bib")) {
    return <FileTextIcon className="size-3.5 shrink-0 text-amber-500" />;
  }
  return <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

interface EditorTabItemProps {
  tab: EditorTab;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onTogglePin: () => void;
  onCloseOthers: () => void;
  onCloseToRight: () => void;
  onDragStart?: (e: React.DragEvent, index: number) => void;
  onDragOver?: (e: React.DragEvent, index: number) => void;
  onDrop?: (e: React.DragEvent, index: number) => void;
  index: number;
}

const EditorTabItem: React.FC<EditorTabItemProps> = ({
  tab,
  isActive,
  onSelect,
  onClose,
  onTogglePin,
  onCloseOthers,
  onCloseToRight,
  onDragStart,
  onDragOver,
  onDrop,
  index,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          aria-selected={isActive}
          data-tab-id={tab.id}
          data-active={isActive}
          data-dirty={tab.isDirty}
          data-pinned={tab.isPinned}
          draggable={!tab.isPinned}
          onDragStart={(e) => onDragStart?.(e, index)}
          onDragOver={(e) => {
            e.preventDefault();
            onDragOver?.(e, index);
          }}
          onDrop={(e) => {
            e.preventDefault();
            onDrop?.(e, index);
          }}
          onMouseDown={handleMouseDown}
          onClick={(e) => {
            if (e.button === 0) onSelect();
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          className={cn(
            "group relative flex h-full shrink-0 cursor-pointer select-none items-center gap-2 border-border/50 border-r px-3 text-xs transition-colors",
            tab.isPinned
              ? "min-w-[36px] max-w-[120px] bg-muted/20"
              : "min-w-[100px] max-w-[200px]",
            isActive
              ? "border-t-2 border-t-primary bg-background font-medium text-foreground shadow-xs"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          {getFileIcon(tab.path)}

          <span className="flex-1 truncate" title={tab.path}>
            {tab.title}
          </span>

          {tab.isPinned && (
            <PinIcon className="size-3 shrink-0 text-muted-foreground/70" />
          )}

          {/* Dirty indicator / Close button */}
          <div className="flex size-4 shrink-0 items-center justify-center">
            {tab.isDirty && !isHovered ? (
              <span
                className="size-2 rounded-full bg-primary/80 transition-all"
                title="Unsaved changes"
              />
            ) : (
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
                className={cn(
                  "flex size-4 items-center justify-center rounded-sm transition-opacity hover:bg-muted hover:text-foreground",
                  isHovered || isActive
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100",
                )}
              >
                <XIcon className="size-3" />
              </button>
            )}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItem onClick={onClose}>Close</ContextMenuItem>
        <ContextMenuItem onClick={onCloseOthers}>Close Others</ContextMenuItem>
        <ContextMenuItem onClick={onCloseToRight}>
          Close to the Right
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onTogglePin}>
          {tab.isPinned ? "Unpin Tab" : "Pin Tab"}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            void navigator.clipboard.writeText(tab.path);
          }}
        >
          Copy Relative Path
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            useDocumentStore.getState().requestRevealInTree(tab.path, "file");
          }}
        >
          Reveal in File Tree
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

export const EditorTabStrip: React.FC = () => {
  const tabs = useEditorTabsStore((s) => s.tabs);
  const activeTabId = useEditorTabsStore((s) => s.activeTabId);
  const agentTabIds = useEditorTabsStore((s) => s.agentTabIds);
  const _openTab = useEditorTabsStore((s) => s.openTab);
  const closeTab = useEditorTabsStore((s) => s.closeTab);
  const closeOtherTabs = useEditorTabsStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useEditorTabsStore((s) => s.closeTabsToRight);
  const closeAgentTabs = useEditorTabsStore((s) => s.closeAgentTabs);
  const reorderTabs = useEditorTabsStore((s) => s.reorderTabs);
  const togglePin = useEditorTabsStore((s) => s.togglePin);
  const setActiveTab = useEditorTabsStore((s) => s.setActiveTab);

  const [confirmCloseTab, setConfirmCloseTab] = useState<EditorTab | null>(
    null,
  );
  const dragSourceIndexRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const handleClose = useCallback(
    (tab: EditorTab) => {
      const res = closeTab(tab.id);
      if (res === "prompt") {
        setConfirmCloseTab(tab);
      }
    },
    [closeTab],
  );

  const handleWheel = (e: React.WheelEvent) => {
    if (scrollRef.current) {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        scrollRef.current.scrollLeft += e.deltaY;
      }
    }
  };

  const handleDragStart = (_e: React.DragEvent, index: number) => {
    dragSourceIndexRef.current = index;
  };

  const handleDrop = (_e: React.DragEvent, toIndex: number) => {
    const fromIndex = dragSourceIndexRef.current;
    if (fromIndex !== null && fromIndex !== toIndex) {
      reorderTabs(fromIndex, toIndex);
    }
    dragSourceIndexRef.current = null;
  };

  if (tabs.length === 0) {
    return null;
  }

  return (
    <>
      <div
        role="tablist"
        aria-label="Editor tabs"
        className="relative flex h-9 w-full shrink-0 select-none items-center justify-between overflow-hidden border-border border-b bg-muted/40"
      >
        {/* Scrollable Tabs */}
        <div
          ref={scrollRef}
          onWheel={handleWheel}
          className="no-scrollbar flex h-full min-w-0 flex-1 items-center overflow-x-auto scroll-smooth"
        >
          {tabs.map((tab, idx) => (
            <EditorTabItem
              key={tab.id}
              tab={tab}
              index={idx}
              isActive={tab.id === activeTabId}
              onSelect={() => setActiveTab(tab.id)}
              onClose={() => handleClose(tab)}
              onTogglePin={() => togglePin(tab.id)}
              onCloseOthers={() => closeOtherTabs(tab.id)}
              onCloseToRight={() => closeTabsToRight(tab.id)}
              onDragStart={handleDragStart}
              onDrop={handleDrop}
            />
          ))}
        </div>

        {/* Right Action Controls */}
        <div className="flex h-full items-center gap-1 border-border/50 border-l bg-muted/40 px-2">
          {agentTabIds.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={closeAgentTabs}
              className="h-6 gap-1 px-2 text-[10px] text-muted-foreground hover:text-foreground"
              title="Close tabs opened by AI assistant"
            >
              <BotIcon className="size-3" />
              Close Agent Tabs
            </Button>
          )}

          {/* Quick tab switcher dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Open Editors"
              >
                <ChevronDownIcon className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {tabs.map((tab) => (
                <DropdownMenuItem
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="flex items-center gap-2 text-xs"
                >
                  {getFileIcon(tab.path)}
                  <span className="flex-1 truncate">{tab.title}</span>
                  {tab.isDirty && (
                    <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Unsaved changes confirmation dialog */}
      <Dialog
        open={!!confirmCloseTab}
        onOpenChange={(open) => !open && setConfirmCloseTab(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              {confirmCloseTab?.title} has unsaved changes. Do you want to close
              it without saving?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmCloseTab(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirmCloseTab) {
                  closeTab(confirmCloseTab.id, true);
                  setConfirmCloseTab(null);
                }
              }}
            >
              Close Without Saving
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
