import { type FC, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { CommandIcon, FolderOpenIcon, GlobeIcon, TerminalIcon, FileCodeIcon, ZapIcon, XIcon, SearchIcon, UserIcon, Building2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SlashCommand {
  id: string;
  name: string;
  full_command: string;
  scope: string;
  namespace: string | null;
  file_path: string;
  content: string;
  description: string | null;
  allowed_tools: string[];
  has_bash_commands: boolean;
  has_file_references: boolean;
  accepts_arguments: boolean;
}

interface SlashCommandPickerProps {
  projectPath: string | null;
  query: string;
  anchorRef: RefObject<HTMLDivElement | null>;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

function getCommandIcon(command: SlashCommand) {
  if (command.has_bash_commands) return <TerminalIcon className="size-4 shrink-0 text-muted-foreground" />;
  if (command.has_file_references) return <FileCodeIcon className="size-4 shrink-0 text-muted-foreground" />;
  if (command.accepts_arguments) return <ZapIcon className="size-4 shrink-0 text-muted-foreground" />;
  if (command.scope === "project") return <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />;
  if (command.scope === "user") return <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />;
  return <CommandIcon className="size-4 shrink-0 text-muted-foreground" />;
}

export const SlashCommandPicker: FC<SlashCommandPickerProps> = ({
  projectPath,
  query,
  anchorRef,
  onSelect,
  onClose,
}) => {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<"default" | "custom">("default");
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; right: number; bottom: number }>({ left: 0, right: 0, bottom: 0 });

  // Compute fixed position from anchor element
  useLayoutEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({
      left: rect.left,
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.top + 4,
    });
  }, [anchorRef]);

  // Load commands on mount
  useEffect(() => {
    setIsLoading(true);
    invoke<SlashCommand[]>("slash_commands_list", {
      projectPath: projectPath ?? undefined,
    })
      .then((cmds) => {
        setCommands(cmds);
        setIsLoading(false);
      })
      .catch(() => {
        setCommands([]);
        setIsLoading(false);
      });
  }, [projectPath]);

  // Filter by tab and query
  const filtered = useMemo(() => {
    let byTab: SlashCommand[];
    if (activeTab === "default") {
      byTab = commands.filter((cmd) => cmd.scope === "default");
    } else {
      byTab = commands.filter((cmd) => cmd.scope !== "default");
    }

    const q = query.toLowerCase();
    if (!q) return byTab;

    const matched = byTab.filter((cmd) => {
      if (cmd.name.toLowerCase().includes(q)) return true;
      if (cmd.full_command.toLowerCase().includes(q)) return true;
      if (cmd.namespace && cmd.namespace.toLowerCase().includes(q)) return true;
      if (cmd.description && cmd.description.toLowerCase().includes(q)) return true;
      return false;
    });

    matched.sort((a, b) => {
      const aExact = a.name.toLowerCase() === q;
      const bExact = b.name.toLowerCase() === q;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      const aStarts = a.name.toLowerCase().startsWith(q);
      const bStarts = b.name.toLowerCase().startsWith(q);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.name.localeCompare(b.name);
    });

    return matched;
  }, [query, commands, activeTab]);

  // Group commands by scope/namespace for the custom tab
  const groupedCommands = useMemo(() => {
    return filtered.reduce((acc, cmd) => {
      let key: string;
      if (cmd.scope === "user") {
        key = cmd.namespace ? `User Commands: ${cmd.namespace}` : "User Commands";
      } else if (cmd.scope === "project") {
        key = cmd.namespace ? `Project Commands: ${cmd.namespace}` : "Project Commands";
      } else {
        key = cmd.namespace || "Commands";
      }
      if (!acc[key]) acc[key] = [];
      acc[key].push(cmd);
      return acc;
    }, {} as Record<string, SlashCommand[]>);
  }, [filtered]);

  // Reset selected index when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, activeTab]);

  // Keyboard navigation via window listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "Enter":
          e.preventDefault();
          if (filtered.length > 0 && selectedIndex < filtered.length) {
            onSelect(filtered[selectedIndex]);
          }
          break;
        case "Tab":
          e.preventDefault();
          if (filtered.length > 0 && selectedIndex < filtered.length) {
            onSelect(filtered[selectedIndex]);
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(filtered.length - 1, prev + 1));
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filtered, selectedIndex, onSelect, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      selected?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedIndex]);

  const renderCommandItem = (cmd: SlashCommand, index: number) => {
    const isSelected = index === selectedIndex;
    return (
      <button
        key={cmd.id}
        data-index={index}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-2 rounded-md text-left transition-colors",
          isSelected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
        )}
        onMouseDown={(e) => {
          e.preventDefault();
          onSelect(cmd);
        }}
        onMouseEnter={() => setSelectedIndex(index)}
      >
        {getCommandIcon(cmd)}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-sm">{cmd.full_command}</span>
            {cmd.accepts_arguments && (
              <span className="text-xs text-muted-foreground">[args]</span>
            )}
            <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {cmd.scope}
            </span>
          </div>
          {cmd.description && (
            <p className="truncate text-xs text-muted-foreground mt-0.5">
              {cmd.description}
            </p>
          )}
          <div className="flex items-center gap-3 mt-1">
            {cmd.allowed_tools.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {cmd.allowed_tools.length} tool{cmd.allowed_tools.length === 1 ? "" : "s"}
              </span>
            )}
            {cmd.has_bash_commands && (
              <span className="text-xs text-blue-600 dark:text-blue-400">Bash</span>
            )}
            {cmd.has_file_references && (
              <span className="text-xs text-green-600 dark:text-green-400">Files</span>
            )}
          </div>
        </div>
      </button>
    );
  };

  return createPortal(
    <div
      className="fixed flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
      style={{ left: pos.left, right: pos.right, bottom: pos.bottom, maxHeight: "400px", zIndex: 9999 }}
    >
      {/* Header */}
      <div className="border-b border-border p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CommandIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Slash Commands</span>
            {query && (
              <span className="text-xs text-muted-foreground">
                Searching: "{query}"
              </span>
            )}
          </div>
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              onClose();
            }}
            className="rounded-md p-1 transition-colors hover:bg-muted"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="mt-2 flex gap-1">
          <button
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-center text-xs font-medium transition-colors",
              activeTab === "default"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              setActiveTab("default");
            }}
          >
            Default
          </button>
          <button
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-center text-xs font-medium transition-colors",
              activeTab === "custom"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              setActiveTab("custom");
            }}
          >
            Custom
          </button>
        </div>
      </div>

      {/* Command List */}
      <div className="flex-1 overflow-y-auto" ref={listRef}>
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <span className="text-sm text-muted-foreground">Loading commands...</span>
          </div>
        )}

        {!isLoading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8">
            <SearchIcon className="size-8 text-muted-foreground mb-2" />
            <span className="text-sm text-muted-foreground">
              {query ? "No commands found" : "No commands available"}
            </span>
            {!query && activeTab === "custom" && (
              <p className="text-xs text-muted-foreground mt-2 text-center px-4">
                Create commands in <code className="px-1">.claude/commands/</code> or <code className="px-1">~/.claude/commands/</code>
              </p>
            )}
          </div>
        )}

        {!isLoading && filtered.length > 0 && (
          <div className="p-2">
            {activeTab === "default" || Object.keys(groupedCommands).length <= 1 ? (
              <div className="space-y-0.5">
                {filtered.map((cmd, i) => renderCommandItem(cmd, i))}
              </div>
            ) : (
              <div className="space-y-4">
                {Object.entries(groupedCommands).map(([groupKey, groupCmds]) => (
                  <div key={groupKey}>
                    <h3 className="flex items-center gap-2 px-3 mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {groupKey.startsWith("User Commands") && <UserIcon className="size-3" />}
                      {groupKey.startsWith("Project Commands") && <Building2Icon className="size-3" />}
                      {groupKey}
                    </h3>
                    <div className="space-y-0.5">
                      {groupCmds.map((cmd) => {
                        const globalIndex = filtered.indexOf(cmd);
                        return renderCommandItem(cmd, globalIndex);
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          ↑↓ Navigate &middot; Enter Select &middot; Esc Close
        </span>
      </div>
    </div>,
    document.body,
  );
};
