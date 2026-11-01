import React, { useState, useMemo } from "react";
import {
  ChevronRightIcon,
  ChevronDownIcon,
  SearchIcon,
  XIcon,
  ChevronsUpDownIcon,
  ListTreeIcon,
  HashIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useDocumentStore } from "@/stores/document-store";
import {
  parseDocumentOutline,
  buildOutlineTree,
  type OutlineItem,
  type OutlineNode,
  type DocumentLanguage,
} from "@/lib/outline-parser";

interface OutlineNodeItemProps {
  node: OutlineNode;
  activeId: string | null;
  collapsedIds: Set<string>;
  onToggleCollapse: (id: string) => void;
  onSelect: (node: OutlineNode) => void;
  depth: number;
}

const OutlineNodeItem: React.FC<OutlineNodeItemProps> = ({
  node,
  activeId,
  collapsedIds,
  onToggleCollapse,
  onSelect,
  depth,
}) => {
  const hasChildren = node.children && node.children.length > 0;
  const isCollapsed = collapsedIds.has(node.id);
  const isActive = activeId === node.id;

  return (
    <div className="flex flex-col">
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(node)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(node);
          }
        }}
        style={{ paddingLeft: `${Math.max(8, depth * 14)}px` }}
        className={cn(
          "group flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-sm pr-2 text-xs transition-colors",
          isActive
            ? "bg-accent font-medium text-accent-foreground"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(node.id);
            }}
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {isCollapsed ? (
              <ChevronRightIcon className="size-3" />
            ) : (
              <ChevronDownIcon className="size-3" />
            )}
          </button>
        ) : (
          <span className="flex size-4 shrink-0 items-center justify-center">
            <HashIcon className="size-2.5 opacity-40" />
          </span>
        )}

        <span className="flex-1 truncate" title={node.title}>
          {node.title}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">
          L{node.line}
        </span>
      </div>

      {hasChildren && !isCollapsed && (
        <div className="flex flex-col">
          {node.children.map((child) => (
            <OutlineNodeItem
              key={child.id}
              node={child}
              activeId={activeId}
              collapsedIds={collapsedIds}
              onToggleCollapse={onToggleCollapse}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const OutlinePanel: React.FC<{ className?: string }> = ({
  className,
}) => {
  const [search, setSearch] = useState("");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const files = useDocumentStore((s) => s.files);
  const cursorPosition = useDocumentStore((s) => s.cursorPosition);

  const activeFile = useMemo(
    () => files.find((f) => f.id === activeFileId),
    [files, activeFileId],
  );

  const documentLanguage = useMemo<DocumentLanguage>(() => {
    if (!activeFile) return "latex";
    if (activeFile.type === "typst" || activeFile.name.endsWith(".typ")) {
      return "typst";
    }
    if (activeFile.name.endsWith(".md")) {
      return "markdown";
    }
    return "latex";
  }, [activeFile]);

  const outlineItems = useMemo<OutlineItem[]>(() => {
    if (!activeFile?.content) return [];
    return parseDocumentOutline(activeFile.content, documentLanguage);
  }, [activeFile?.content, documentLanguage]);

  // Find active heading based on cursorPosition (scroll-spy)
  const activeItemId = useMemo<string | null>(() => {
    if (outlineItems.length === 0) return null;
    let active = outlineItems[0];
    for (const item of outlineItems) {
      if (item.pos <= cursorPosition) {
        active = item;
      } else {
        break;
      }
    }
    return active ? active.id : null;
  }, [outlineItems, cursorPosition]);

  // Filter items if search is active
  const filteredTree = useMemo<OutlineNode[]>(() => {
    if (!search.trim()) {
      return buildOutlineTree(outlineItems);
    }
    const q = search.toLowerCase();
    const matching = outlineItems.filter((item) =>
      item.title.toLowerCase().includes(q),
    );
    return buildOutlineTree(matching);
  }, [outlineItems, search]);

  const toggleCollapse = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleExpandAll = () => {
    setCollapsedIds(new Set());
  };

  const handleCollapseAll = () => {
    const allIdsWithChildren = new Set<string>();
    const collect = (nodes: OutlineNode[]) => {
      for (const n of nodes) {
        if (n.children.length > 0) {
          allIdsWithChildren.add(n.id);
          collect(n.children);
        }
      }
    };
    collect(buildOutlineTree(outlineItems));
    setCollapsedIds(allIdsWithChildren);
  };

  const handleSelectNode = (node: OutlineNode) => {
    useDocumentStore.getState().requestJumpToPosition(node.pos);
  };

  const renderEmptyState = () => {
    switch (documentLanguage) {
      case "typst":
        return "No sections found. Add = Heading or == Subheading to outline your document.";
      case "markdown":
        return "No sections found. Add # Heading or ## Subheading to outline your document.";
      default:
        return "No sections found. Add \\section{…} headings to outline your document.";
    }
  };

  return (
    <div
      role="region"
      aria-label="Document Outline"
      className={cn(
        "flex h-full w-full select-none flex-col overflow-hidden",
        className,
      )}
    >
      {/* Header with Search and Collapse Toggle */}
      <div className="flex flex-col gap-2 border-border border-b p-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-medium text-foreground text-xs">
            <ListTreeIcon className="size-3.5 text-muted-foreground" />
            <span>Document Outline</span>
            <span className="rounded-full bg-muted px-1.5 py-0.2 text-[10px] text-muted-foreground">
              {outlineItems.length}
            </span>
          </div>

          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={
                collapsedIds.size === 0 ? handleCollapseAll : handleExpandAll
              }
              className="size-6 p-0 text-muted-foreground hover:text-foreground"
              title={collapsedIds.size === 0 ? "Collapse All" : "Expand All"}
            >
              <ChevronsUpDownIcon className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* Search input */}
        <div className="relative flex items-center">
          <SearchIcon className="pointer-events-none absolute left-2 size-3 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter headings..."
            className="h-6 w-full bg-muted/30 pl-6 text-xs"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-1 text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* Tree Content */}
      <div className="flex-1 overflow-y-auto p-1 font-sans">
        {filteredTree.length === 0 ? (
          <div className="flex h-full min-h-[120px] items-center justify-center p-4 text-center text-muted-foreground text-xs">
            {renderEmptyState()}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filteredTree.map((node) => (
              <OutlineNodeItem
                key={node.id}
                node={node}
                activeId={activeItemId}
                collapsedIds={collapsedIds}
                onToggleCollapse={toggleCollapse}
                onSelect={handleSelectNode}
                depth={0}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
