import { useEffect, useRef, useState } from "react";
import {
  SettingsIcon,
  DownloadIcon,
  LoaderIcon,
  Loader2Icon,
  LogOutIcon,
  RefreshCwIcon,
  ExternalLinkIcon,
  LinkIcon,
  SparklesIcon,
  UserIcon,
  FolderIcon,
  LibraryIcon,
  CheckIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useZoteroStore, type CollectionSyncInfo } from "@/stores/zotero-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { canUseAiAssist, aiComplete } from "@/lib/ai-assist";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const MYLIB_KEY = "__my_library__";

export function ZoteroPanel() {
  const isAuthenticated = useZoteroStore((s) => s.isAuthenticated);
  const _username = useZoteroStore((s) => s.username);
  const isValidating = useZoteroStore((s) => s.isValidating);
  const isSyncing = useZoteroStore((s) => s.isSyncing);
  const syncProgress = useZoteroStore((s) => s.syncProgress);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const allSyncedCollections = useZoteroStore((s) => s.syncedCollections);
  const syncedCollections = projectRoot
    ? (allSyncedCollections[projectRoot] ?? {})
    : {};
  const error = useZoteroStore((s) => s.error);
  const collections = useZoteroStore((s) => s.collections);
  const isLoadingCollections = useZoteroStore((s) => s.isLoadingCollections);
  const connectWithOAuth = useZoteroStore((s) => s.connectWithOAuth);
  const cancelConnect = useZoteroStore((s) => s.cancelConnect);
  const _disconnect = useZoteroStore((s) => s.disconnect);
  const revalidate = useZoteroStore((s) => s.revalidate);
  const _loadCollections = useZoteroStore((s) => s.loadCollections);
  const importCollectionToBib = useZoteroStore((s) => s.importCollectionToBib);
  const syncCollectionBib = useZoteroStore((s) => s.syncCollectionBib);
  const removeCollection = useZoteroStore((s) => s.removeCollection);

  const [connectDialogOpen, setConnectDialogOpen] = useState(false);

  useEffect(() => {
    const { apiKey } = useZoteroStore.getState();
    if (apiKey) revalidate();
  }, [revalidate]);

  const topCollections = collections.filter((c) => c.parentKey === false);

  return (
    <div className="flex h-full flex-col">
      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!isAuthenticated ? (
          <NotConnectedView
            isValidating={isValidating}
            error={error}
            onConnect={connectWithOAuth}
            onCancel={cancelConnect}
            onApiKey={() => setConnectDialogOpen(true)}
          />
        ) : (
          <div className="py-0.5">
            {/* Error */}
            {error && (
              <div className="mx-2 mb-1 rounded bg-destructive/10 px-2 py-1 text-destructive text-xs">
                {error}
              </div>
            )}

            {/* Syncing progress */}
            {isSyncing && (
              <div className="mx-2 mb-0.5 flex items-center gap-1 text-muted-foreground text-xs">
                <LoaderIcon className="size-3 animate-spin" />
                {syncProgress
                  ? `${syncProgress.loaded}/${syncProgress.total}`
                  : "Syncing..."}
              </div>
            )}

            {/* My Library */}
            <CollectionRow
              collectionKey={null}
              name="My Library"
              icon={<LibraryIcon className="size-3.5" />}
              syncInfo={syncedCollections[MYLIB_KEY]}
              isSyncing={isSyncing === MYLIB_KEY}
              onImport={() => importCollectionToBib(null, "My Library")}
              onSync={() => syncCollectionBib(null)}
              onRemove={() => removeCollection(null)}
              disabled={!!isSyncing}
            />

            {topCollections.length > 0 && (
              <div className="mx-2 my-0.5 border-sidebar-border border-t" />
            )}

            {isLoadingCollections ? (
              <div className="space-y-1 px-2 py-0.5">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-3.5 w-full rounded-sm" />
                ))}
              </div>
            ) : (
              <>
                {topCollections.length === 0 && (
                  <p className="px-2 py-1 text-muted-foreground text-xs">
                    No collections in your Zotero account. Create one at
                    zotero.org.
                  </p>
                )}
                {topCollections.map((col) => (
                  <CollectionRow
                    key={col.key}
                    collectionKey={col.key}
                    name={col.name}
                    icon={<FolderIcon className="size-3.5" />}
                    itemCount={col.itemCount}
                    syncInfo={syncedCollections[col.key]}
                    isSyncing={isSyncing === col.key}
                    onImport={() => importCollectionToBib(col.key, col.name)}
                    onSync={() => syncCollectionBib(col.key)}
                    onRemove={() => removeCollection(col.key)}
                    disabled={!!isSyncing}
                  />
                ))}
              </>
            )}

            <SuggestCollection
              collectionNames={topCollections.map((c) => c.name)}
            />
          </div>
        )}
      </div>

      <ZoteroApiKeyDialog
        open={connectDialogOpen}
        onOpenChange={setConnectDialogOpen}
      />
    </div>
  );
}

/** Header rendered separately by Sidebar so it sits outside the resizable panel content */
export function ZoteroHeader() {
  const isAuthenticated = useZoteroStore((s) => s.isAuthenticated);
  const username = useZoteroStore((s) => s.username);
  const isLoadingCollections = useZoteroStore((s) => s.isLoadingCollections);
  const disconnect = useZoteroStore((s) => s.disconnect);
  const loadCollections = useZoteroStore((s) => s.loadCollections);

  return (
    <div className="relative flex w-full items-center gap-1.5 px-3 text-muted-foreground text-xs uppercase tracking-wider">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isAuthenticated ? "bg-foreground" : "bg-muted-foreground/30",
        )}
      />
      <span className="font-medium">Zotero</span>
      {isAuthenticated && (
        <div className="absolute right-3 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={loadCollections}
            disabled={isLoadingCollections}
            aria-label="Refresh collections"
            title="Refresh"
          >
            <RefreshCwIcon
              className={cn("size-3.5", isLoadingCollections && "animate-spin")}
            />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Zotero settings"
              >
                <SettingsIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <div className="flex items-center gap-2 px-2 py-1">
                <UserIcon className="size-3.5 text-muted-foreground" />
                <span className="truncate text-muted-foreground text-xs">
                  {username}
                </span>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={disconnect}>
                <LogOutIcon className="mr-2 size-3.5" />
                Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

// ─── Not Connected View ───

function NotConnectedView({
  isValidating,
  error,
  onConnect,
  onCancel,
  onApiKey,
}: {
  isValidating: boolean;
  error: string | null;
  onConnect: () => void;
  onCancel: () => void;
  onApiKey: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
      <div className="flex size-8 items-center justify-center rounded-full bg-muted">
        <LinkIcon className="size-4 text-muted-foreground" />
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Connect Zotero to import references.
      </p>
      {isValidating ? (
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <LoaderIcon className="size-3 animate-spin" />
            Authorizing...
          </div>
          <button
            className="text-[10px] text-muted-foreground underline"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1">
          <Button
            size="sm"
            className="h-6 gap-1 text-[11px]"
            onClick={onConnect}
          >
            <ExternalLinkIcon className="size-3" />
            Connect
          </Button>
          <button
            className="text-[10px] text-muted-foreground underline"
            onClick={onApiKey}
          >
            API key
          </button>
        </div>
      )}
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}

// ─── Collection Row ───

function CollectionRow({
  collectionKey: _collectionKey,
  name,
  icon,
  itemCount,
  syncInfo,
  isSyncing,
  onImport,
  onSync,
  onRemove,
  disabled,
}: {
  collectionKey: string | null;
  name: string;
  icon: React.ReactNode;
  itemCount?: number;
  syncInfo?: CollectionSyncInfo;
  isSyncing: boolean;
  onImport: () => void;
  onSync: () => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const isSynced = !!syncInfo;
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <div className="group flex items-center gap-1.5 px-2 py-0.5">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-foreground text-sm">{name}</span>
          {isSynced && (
            <CheckIcon className="size-2.5 shrink-0 text-muted-foreground" />
          )}
        </div>
        {isSynced && (
          <p className="truncate text-muted-foreground text-xs leading-none">
            {syncInfo.bibFileName}
          </p>
        )}
        {!isSynced && itemCount !== undefined && (
          <p className="text-muted-foreground text-xs leading-none">
            {itemCount} items
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        {isSynced ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onSync}
              disabled={disabled}
              aria-label="Sync collection"
              title="Sync"
            >
              {isSyncing ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
            </Button>
            {confirmRemove ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  setConfirmRemove(false);
                  onRemove();
                }}
                disabled={disabled}
                aria-label="Confirm remove collection"
                title="Click again to confirm removal"
                className="text-destructive hover:text-destructive"
              >
                <CheckIcon className="size-3" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setConfirmRemove(true)}
                disabled={disabled}
                aria-label="Remove collection"
                title="Remove"
              >
                <XIcon className="size-3" />
              </Button>
            )}
          </>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onImport}
            disabled={disabled}
            aria-label="Import collection"
            title="Import"
          >
            <DownloadIcon className="size-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Suggest Collection (AI) ───

/**
 * Minimal, gated AI affordance: given a short topic the user types, ask the
 * local model which of the existing Zotero collections (by name) best fits.
 * Uses only on-screen metadata (collection names). Renders nothing when AI
 * assist is unavailable or there are no collections to choose from.
 */
function SuggestCollection({ collectionNames }: { collectionNames: string[] }) {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestion, setSuggestion] = useState<{
    collection: string;
    reason: string;
  } | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const aiBibAssist = useSettingsStore((s) => s.aiBibAssist);

  // Silent if there's no usable metadata or AI assist is off.
  if (collectionNames.length === 0 || !aiBibAssist || !canUseAiAssist())
    return null;

  const run = async () => {
    const text = topic.trim();
    if (!text) return;
    const id = ++requestIdRef.current;
    setLoading(true);
    setSuggestion(null);
    setSuggestError(null);
    try {
      const raw = await aiComplete({
        system:
          "You pick the single best-matching reference collection for a topic. " +
          "Given the topic and a JSON list of collection names, return JSON: " +
          '{"collection": string, "reason": string}. "collection" MUST be one of the ' +
          "provided names exactly. Keep the reason to one short sentence. JSON only — no markdown fences.",
        prompt: `Topic: ${text}\n\nCollections:\n${JSON.stringify(collectionNames)}`,
        temperature: 0.2,
        format: "json",
      });
      if (id !== requestIdRef.current) return;
      let parsed: { collection?: string; reason?: string } = {};
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            parsed = JSON.parse(m[0]);
          } catch {
            parsed = {};
          }
        }
      }
      const collection = collectionNames.find((n) => n === parsed.collection);
      if (!collection) {
        setSuggestError("No matching collection was suggested.");
        return;
      }
      setSuggestion({ collection, reason: parsed.reason?.trim() ?? "" });
    } catch (err) {
      if (id !== requestIdRef.current) return;
      setSuggestError(String(err));
    } finally {
      if (id === requestIdRef.current) setLoading(false);
    }
  };

  return (
    <div className="mx-2 mt-1 border-sidebar-border border-t pt-1">
      {!open ? (
        <button
          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-muted-foreground text-xs transition-colors hover:bg-sidebar-accent hover:text-foreground"
          onClick={() => setOpen(true)}
        >
          <SparklesIcon className="size-3" />
          Suggest collection
        </button>
      ) : (
        <div className="flex flex-col gap-1 py-0.5">
          <div className="flex items-center gap-1">
            <Input
              className="h-6 text-xs"
              placeholder="Topic or paper title…"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run();
              }}
              autoFocus
            />
            <Button
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => void run()}
              disabled={!topic.trim() || loading}
            >
              {loading ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <SparklesIcon className="size-3" />
              )}
              Suggest
            </Button>
          </div>
          {suggestError && (
            <p className="rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {suggestError}
            </p>
          )}
          {suggestion && (
            <div className="rounded bg-sidebar-accent/60 px-2 py-1 text-xs">
              <span className="font-medium text-foreground">
                {suggestion.collection}
              </span>
              {suggestion.reason && (
                <p className="text-muted-foreground leading-snug">
                  {suggestion.reason}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── API Key Dialog ───

function ZoteroApiKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const connect = useZoteroStore((s) => s.connectWithApiKey);
  const isValidating = useZoteroStore((s) => s.isValidating);
  const error = useZoteroStore((s) => s.error);

  const handleConnect = async () => {
    const key = apiKey.trim();
    if (!key) return;
    const success = await connect(key);
    if (success) {
      onOpenChange(false);
      setApiKey("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect to Zotero</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-4">
          <p className="text-muted-foreground text-sm">
            Enter your Zotero API key.
          </p>
          <Input
            type="password"
            placeholder="Zotero API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConnect();
            }}
            autoFocus
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
          <p className="text-muted-foreground text-xs">
            Create a key at{" "}
            <a
              href="https://www.zotero.org/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline"
            >
              zotero.org/settings/keys
            </a>
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleConnect}
            disabled={!apiKey.trim() || isValidating}
          >
            {isValidating ? "Validating..." : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
