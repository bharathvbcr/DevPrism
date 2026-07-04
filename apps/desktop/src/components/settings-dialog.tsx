import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  SparklesIcon,
  CheckCircle2Icon,
  XCircleIcon,
  DownloadIcon,
  Loader2Icon,
  KeyRoundIcon,
  SearchIcon,
  SettingsIcon,
  ZapIcon,
  UserIcon,
  FileTextIcon,
  MonitorIcon,
  ChevronRightIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PersonalizationSettings } from "./personalization-settings";
import { SettingsAiFeatures } from "./settings-ai-features";
import { SettingsToggleRow } from "@/components/settings-toggle-row";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import {
  getOllamaBaseUrl,
  listOllamaModels,
  resolveOllamaCredential,
  type OllamaModelInfo,
} from "@/lib/ollama";
import { useOllamaStatus } from "@/hooks/use-ollama-status";
import { OllamaSetupHints } from "@/components/ollama-setup-hints";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useSpacesStore } from "@/stores/spaces-store";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ClaudeSetup } from "./claude-setup";
import { cn } from "@/lib/utils";

type SettingsDetailSection =
  | "provider"
  | "environment"
  | "editor"
  | "compilation"
  | "appearance"
  | "ai"
  | "personalization";

const SETTINGS_NAV: Array<{
  id: SettingsDetailSection;
  label: string;
  meta: string;
  keywords: string;
  icon: LucideIcon;
}> = [
  {
    id: "provider",
    label: "Provider",
    meta: "Ollama / Claude / API",
    keywords: "provider ollama claude api model native agent credentials",
    icon: KeyRoundIcon,
  },
  {
    id: "environment",
    label: "Environment",
    meta: "Python / Skills",
    keywords: "environment python uv skills dev engine setup",
    icon: CheckCircle2Icon,
  },
  {
    id: "ai",
    label: "AI Features",
    meta: "Predictive / Grammar",
    keywords:
      "ai assist grammar predictive summarize command palette vision caption writing enable master toggle",
    icon: SparklesIcon,
  },
  {
    id: "personalization",
    label: "Personalization",
    meta: "User Profile / Tone",
    keywords:
      "personalization profile name role affiliation research interests writing style",
    icon: UserIcon,
  },
  {
    id: "editor",
    label: "Editor",
    meta: "Vim / Spell check",
    keywords: "editor vim spell keybindings proofread modal",
    icon: FileTextIcon,
  },
  {
    id: "appearance",
    label: "Appearance",
    meta: "Preview / Home screen",
    keywords: "appearance theme dark pdf preview homepage project cards date",
    icon: MonitorIcon,
  },
  {
    id: "compilation",
    label: "Compilation",
    meta: "Engine / Auto-compile / Preview",
    keywords:
      "compilation compile tectonic texlive pdf preview auto-compile dark mode",
    icon: ZapIcon,
  },
];

interface SettingsDialogProps {
  open: boolean;
  appVersion: string;
}

/**
 * The Settings view previously inlined in ProjectPicker. It stays mounted even
 * while hidden (rendering null when `open` is false) so the selected section,
 * search query, and Ollama model/status polling behave exactly as they did
 * when this state lived in ProjectPicker itself.
 */
export function SettingsDialog({ open, appVersion }: SettingsDialogProps) {
  const [settingsDetailSection, setSettingsDetailSection] =
    useState<SettingsDetailSection>("provider");
  const [settingsSearchQuery, setSettingsSearchQuery] = useState("");
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  const setNativeAgentEnabled = useSettingsStore(
    (s) => s.setNativeAgentEnabled,
  );
  const aiAssistEnabled = useSettingsStore((s) => s.aiAssistEnabled);
  const nativeNumCtx = useSettingsStore((s) => s.nativeNumCtx);
  const setNativeNumCtx = useSettingsStore((s) => s.setNativeNumCtx);
  const nativeTemperature = useSettingsStore((s) => s.nativeTemperature);
  const setNativeTemperature = useSettingsStore((s) => s.setNativeTemperature);
  const nativeKeepAlive = useSettingsStore((s) => s.nativeKeepAlive);
  const setNativeKeepAlive = useSettingsStore((s) => s.setNativeKeepAlive);
  const [nativeKeepAliveError, setNativeKeepAliveError] = useState<
    string | null
  >(null);
  const nativeOllamaModel = useSettingsStore((s) => s.nativeOllamaModel);
  const setNativeOllamaModel = useSettingsStore((s) => s.setNativeOllamaModel);
  const openAiCredentials = useClaudeSetupStore((s) => s.openAiCredentials);
  const [settingsOllamaModels, setSettingsOllamaModels] = useState<
    OllamaModelInfo[]
  >([]);
  const [settingsOllamaModelsLoading, setSettingsOllamaModelsLoading] =
    useState(false);
  const [settingsOllamaModelsError, setSettingsOllamaModelsError] = useState<
    string | null
  >(null);
  const settingsOllamaBaseUrl = useMemo(
    () => getOllamaBaseUrl(resolveOllamaCredential(openAiCredentials, null)),
    [openAiCredentials],
  );
  const compilerBackend = useSettingsStore((s) => s.compilerBackend);
  const setCompilerBackend = useSettingsStore((s) => s.setCompilerBackend);
  const autoCompile = useSettingsStore((s) => s.autoCompile);
  const setAutoCompile = useSettingsStore((s) => s.setAutoCompile);
  const pdfDarkMode = useSettingsStore((s) => s.pdfDarkMode);
  const setPdfDarkMode = useSettingsStore((s) => s.setPdfDarkMode);
  const vimMode = useSettingsStore((s) => s.vimMode);
  const setVimMode = useSettingsStore((s) => s.setVimMode);
  const spellCheck = useSettingsStore((s) => s.spellCheck);
  const setSpellCheck = useSettingsStore((s) => s.setSpellCheck);
  const homepageDateField = useSettingsStore((s) => s.homepageDateField);
  const setHomepageDateField = useSettingsStore((s) => s.setHomepageDateField);

  const filteredSettingsNav = useMemo(() => {
    const q = settingsSearchQuery.trim().toLowerCase();
    if (!q) return SETTINGS_NAV;
    return SETTINGS_NAV.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.meta.toLowerCase().includes(q) ||
        item.keywords.includes(q),
    );
  }, [settingsSearchQuery]);

  useEffect(() => {
    if (filteredSettingsNav.length === 0) return;
    if (
      !filteredSettingsNav.some((item) => item.id === settingsDetailSection)
    ) {
      setSettingsDetailSection(filteredSettingsNav[0].id);
    }
  }, [filteredSettingsNav, settingsDetailSection]);

  useEffect(() => {
    if (!open) return;
    const pending = useSpacesStore.getState().pendingSettingsDetailSection;
    if (pending) {
      setSettingsDetailSection(pending);
      useSpacesStore.getState().setPendingSettingsDetailSection(null);
    }
  }, [open]);

  useEffect(() => {
    if (!nativeAgentEnabled || settingsDetailSection !== "provider") return;

    let cancelled = false;
    setSettingsOllamaModelsLoading(true);
    setSettingsOllamaModelsError(null);
    void listOllamaModels(settingsOllamaBaseUrl)
      .then((models) => {
        if (!cancelled) setSettingsOllamaModels(models);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSettingsOllamaModels([]);
          setSettingsOllamaModelsError(
            err instanceof Error ? err.message : String(err),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setSettingsOllamaModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nativeAgentEnabled, settingsDetailSection, settingsOllamaBaseUrl]);

  const chatOllamaModels = useMemo(
    () => settingsOllamaModels.filter((model) => model.chatCapable),
    [settingsOllamaModels],
  );
  const { status: settingsOllamaStatus, refresh: refreshSettingsOllamaStatus } =
    useOllamaStatus(
      settingsOllamaBaseUrl,
      nativeAgentEnabled && settingsDetailSection === "provider",
    );

  const reloadSettingsOllamaModels = useCallback(() => {
    setSettingsOllamaModelsLoading(true);
    setSettingsOllamaModelsError(null);
    void listOllamaModels(settingsOllamaBaseUrl)
      .then((models) => setSettingsOllamaModels(models))
      .catch((err: unknown) => {
        setSettingsOllamaModels([]);
        setSettingsOllamaModelsError(
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => setSettingsOllamaModelsLoading(false));
    void refreshSettingsOllamaStatus();
  }, [refreshSettingsOllamaStatus, settingsOllamaBaseUrl]);

  if (!open) return null;

  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 px-8 py-7 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="space-y-3 lg:border-border/60 lg:border-r lg:pr-4">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <input
            type="search"
            value={settingsSearchQuery}
            onChange={(e) => setSettingsSearchQuery(e.target.value)}
            placeholder="Search settings…"
            className="h-8 w-full rounded-md border border-input bg-background/50 py-1 pr-2 pl-8 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
        <div className="space-y-1">
          {filteredSettingsNav.map((item) => (
            <SettingsDetailButton
              key={item.id}
              active={settingsDetailSection === item.id}
              icon={item.icon}
              label={item.label}
              meta={item.meta}
              onClick={() => setSettingsDetailSection(item.id)}
            />
          ))}
          {filteredSettingsNav.length === 0 && (
            <p className="px-3 py-2 text-muted-foreground text-xs">
              No settings match your search.
            </p>
          )}
        </div>
      </aside>

      <div className="min-w-0">
        {settingsDetailSection === "provider" ? (
          <SettingsPanel
            title="Provider"
            icon={KeyRoundIcon}
            contentClassName="p-0"
          >
            <div className="flex items-start gap-3 border-border/60 border-b p-4">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="native-agent-toggle"
                  className="cursor-pointer font-medium text-sm"
                >
                  Native local agent (no Claude CLI)
                </label>
                <p className="mt-0.5 text-muted-foreground text-xs">
                  Run the agent fully offline, talking directly to your local
                  Ollama model — no Claude Code CLI or proxy required. Make sure
                  Ollama is running with a model installed (
                  <code className="rounded bg-muted px-1">
                    ollama pull llama3
                  </code>
                  ). Cloud providers below are used only when this is off.{" "}
                  <a
                    href="https://github.com/bharathvbcr/DevPrism/blob/main/docs/NATIVE_AGENT.md"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground underline underline-offset-2 hover:text-primary"
                  >
                    Learn more
                  </a>
                </p>
              </div>
              <Switch
                id="native-agent-toggle"
                checked={nativeAgentEnabled}
                onCheckedChange={setNativeAgentEnabled}
                aria-label="Native local agent"
                className="mt-0.5"
              />
            </div>
            {nativeAgentEnabled && (
              <div className="flex flex-wrap items-end gap-4 border-border/60 border-b px-4 py-3">
                <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
                  <span className="text-muted-foreground text-xs">
                    Chat model
                  </span>
                  <select
                    value={nativeOllamaModel ?? ""}
                    disabled={settingsOllamaModelsLoading}
                    onChange={(e) =>
                      setNativeOllamaModel(e.target.value || null)
                    }
                    className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {settingsOllamaModelsLoading ? (
                      <option disabled>Loading models…</option>
                    ) : (
                      <>
                        <option value="">Auto (first chat model)</option>
                        {chatOllamaModels.map((model) => (
                          <option key={model.name} value={model.name}>
                            {model.name}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                  <span className="min-h-[0.875rem] text-[10px] leading-[0.875rem]">
                    {settingsOllamaModelsLoading ? (
                      <span className="text-muted-foreground">
                        Loading models from {settingsOllamaBaseUrl}…
                      </span>
                    ) : settingsOllamaModelsError ? (
                      <span className="text-destructive">
                        {settingsOllamaModelsError}
                      </span>
                    ) : null}
                  </span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs">
                    Context window (num_ctx)
                  </span>
                  <input
                    type="number"
                    min={512}
                    step={512}
                    value={nativeNumCtx}
                    onChange={(e) => setNativeNumCtx(Number(e.target.value))}
                    className="h-8 w-28 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs">
                    Temperature
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={nativeTemperature}
                    onChange={(e) =>
                      setNativeTemperature(Number(e.target.value))
                    }
                    className="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs">
                    Keep model loaded (keep_alive)
                  </span>
                  <input
                    // Remount when the sanitized value changes so a
                    // rejected entry visibly snaps back to the default.
                    key={nativeKeepAlive}
                    type="text"
                    defaultValue={nativeKeepAlive}
                    placeholder="10m"
                    onFocus={() => setNativeKeepAliveError(null)}
                    onBlur={(e) => {
                      const entered = e.target.value;
                      setNativeKeepAlive(entered);
                      // If the store sanitized the entry to something
                      // different, surface why the field snapped back.
                      const sanitized =
                        useSettingsStore.getState().nativeKeepAlive;
                      setNativeKeepAliveError(
                        entered.trim() !== sanitized
                          ? `Reverted to ${sanitized} — use 10m, 0, or -1`
                          : null,
                      );
                    }}
                    className="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                  <span className="text-[10px] text-muted-foreground/70">
                    e.g. 10m, 0 to unload, -1 to keep loaded
                  </span>
                  {nativeKeepAliveError && (
                    <span className="text-[10px] text-destructive">
                      {nativeKeepAliveError}
                    </span>
                  )}
                </label>
                <p className="text-muted-foreground/70 text-xs">
                  Larger context = more memory/VRAM. Lower temperature = more
                  deterministic edits. keep_alive sets how long the model stays
                  in memory between turns.
                </p>
              </div>
            )}
            {nativeAgentEnabled &&
              settingsDetailSection === "provider" &&
              (settingsOllamaModelsError ||
                !settingsOllamaStatus?.connected ||
                chatOllamaModels.length === 0) && (
                <div className="border-border/60 border-b px-4 py-3">
                  <OllamaSetupHints
                    baseUrl={settingsOllamaBaseUrl}
                    onModelsChanged={reloadSettingsOllamaModels}
                    connected={Boolean(settingsOllamaStatus?.connected)}
                    chatModels={
                      settingsOllamaStatus?.chatModels ??
                      chatOllamaModels.length
                    }
                  />
                </div>
              )}
            <div className="flex items-center gap-3 border-border/60 border-b p-4">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm">AI writing assist</div>
                <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                  Grammar hints, predictive text, summaries, compile assist, and
                  chat features — powered by Ollama or your configured provider.{" "}
                  {aiAssistEnabled ? (
                    <span className="text-foreground">Currently enabled.</span>
                  ) : (
                    <span>Currently off.</span>
                  )}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1 px-2.5 text-xs"
                onClick={() => setSettingsDetailSection("ai")}
              >
                AI Features
                <ChevronRightIcon className="size-3.5" />
              </Button>
            </div>
            <ClaudeSetup variant="embedded" />
          </SettingsPanel>
        ) : settingsDetailSection === "environment" ? (
          <SettingsPanel
            title="Environment"
            icon={CheckCircle2Icon}
            contentClassName="p-0"
          >
            <EnvironmentStatus appVersion={appVersion} />
          </SettingsPanel>
        ) : settingsDetailSection === "ai" ? (
          <SettingsPanel
            title="AI Features"
            icon={SparklesIcon}
            contentClassName="p-0"
          >
            <SettingsAiFeatures searchQuery={settingsSearchQuery} />
          </SettingsPanel>
        ) : settingsDetailSection === "personalization" ? (
          <SettingsPanel
            title="Personalization"
            icon={UserIcon}
            contentClassName="p-0"
          >
            <PersonalizationSettings searchQuery={settingsSearchQuery} />
          </SettingsPanel>
        ) : settingsDetailSection === "editor" ? (
          <SettingsPanel
            title="Editor"
            icon={FileTextIcon}
            contentClassName="p-0"
          >
            <SettingsToggleRow
              checked={vimMode}
              onChange={setVimMode}
              title="Vim mode"
              description="Modal editing in the LaTeX source view (hjkl navigation, normal / insert modes). Also toggled from the editor toolbar."
              className="border-border/60 border-b"
            />
            <SettingsToggleRow
              checked={spellCheck}
              onChange={setSpellCheck}
              title="Spell check"
              description="Underline misspelled words in the source editor. Also toggled from the editor toolbar."
            />
          </SettingsPanel>
        ) : settingsDetailSection === "appearance" ? (
          <SettingsPanel
            title="Appearance"
            icon={MonitorIcon}
            contentClassName="p-0"
          >
            <div className="border-border/60 border-b px-4 py-4">
              <p className="font-medium text-sm">Interface theme</p>
              <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                DevPrism currently uses a dark interface optimized for long
                writing sessions. Light theme support is planned.
              </p>
            </div>
            <SettingsToggleRow
              checked={pdfDarkMode}
              onChange={setPdfDarkMode}
              title="Dark PDF preview"
              description="Invert the rendered PDF for a dark-friendly page (dark background, light ink). Affects the on-screen preview only — the exported PDF is unchanged."
              className="border-border/60 border-b"
            />
            <div className="p-4">
              <p className="font-medium text-sm">Home screen project cards</p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                Choose which date appears on each project card.
              </p>
              <div
                className="mt-3 inline-flex rounded-lg border border-input p-0.5"
                role="group"
                aria-label="Date shown on project cards"
              >
                {(
                  [
                    { value: "modified", label: "Last edited" },
                    { value: "created", label: "Created" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setHomepageDateField(option.value)}
                    aria-pressed={homepageDateField === option.value}
                    className={cn(
                      "h-8 rounded-md px-3 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      homepageDateField === option.value
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </SettingsPanel>
        ) : settingsDetailSection === "compilation" ? (
          <SettingsPanel
            title="Compilation"
            icon={ZapIcon}
            contentClassName="p-0"
          >
            <div className="flex flex-wrap items-end gap-4 border-border/60 border-b px-4 py-4">
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">Engine</span>
                <select
                  value={compilerBackend}
                  onChange={(e) =>
                    setCompilerBackend(e.target.value as "tectonic" | "texlive")
                  }
                  className="h-8 w-40 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <option value="tectonic">Tectonic</option>
                  <option value="texlive">TeXLive</option>
                </select>
              </label>
              <p className="max-w-xs text-muted-foreground/70 text-xs">
                Tectonic is bundled and works offline. TeXLive uses your local
                installation (pdflatex / xelatex / lualatex).
              </p>
            </div>
            <SettingsToggleRow
              checked={autoCompile}
              onChange={setAutoCompile}
              title="Auto-compile on edit"
              description={
                <>
                  Automatically recompile the document a short moment after you
                  stop typing. When off, compile manually with the toolbar
                  button or{" "}
                  <kbd className="rounded bg-muted px-1">Cmd/Ctrl+Enter</kbd>.
                </>
              }
              className="border-border/60 border-b"
            />
          </SettingsPanel>
        ) : null}
      </div>
    </div>
  );
}

// ─── Environment Status (shown when Claude is ready) ───

interface SkillsStatus {
  installed: boolean;
  skill_count: number;
  location: string;
}

function SettingsDetailButton({
  active,
  icon: Icon,
  label,
  meta,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border",
          active
            ? "border-border/70 bg-background/70"
            : "border-border/60 bg-muted/20",
        )}
      >
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm">{label}</div>
        <div className="truncate text-muted-foreground text-xs">{meta}</div>
      </div>
    </button>
  );
}

function SettingsPanel({
  title,
  icon: Icon,
  contentClassName,
  children,
}: {
  title: string;
  icon: LucideIcon;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-muted/10">
      <div className="flex items-center gap-3 border-border/60 border-b px-5 py-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-sm">{title}</h2>
        </div>
      </div>
      <div className={cn("p-4", contentClassName)}>{children}</div>
    </section>
  );
}

function EnvironmentStatus({ appVersion }: { appVersion: string }) {
  const uvStatus = useUvSetupStore((s) => s.status);
  const uvVersion = useUvSetupStore((s) => s.version);
  const uvInstalling = useUvSetupStore((s) => s.isInstalling);
  const checkUv = useUvSetupStore((s) => s.checkStatus);
  const installUv = useUvSetupStore((s) => s.install);
  const _finishUvInstall = useUvSetupStore((s) => s._finishInstall);

  const [skillsStatus, setSkillsStatus] = useState<SkillsStatus | null>(null);
  const [skillsInstalling, _setSkillsInstalling] = useState(false);
  const [showSkillsOnboarding, setShowSkillsOnboarding] = useState(false);

  const checkSkills = useCallback(async () => {
    try {
      const gs = await invoke<SkillsStatus>("check_skills_installed", {
        projectPath: null,
      });
      setSkillsStatus(gs);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    checkUv();
    checkSkills();
  }, [checkUv, checkSkills]);

  // Listen for uv install completion
  useEffect(() => {
    const unlisten = listen<boolean>("uv-install-complete", (event) => {
      _finishUvInstall(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [_finishUvInstall]);

  // Lazy load skills onboarding
  const [OnboardingComponent, setOnboardingComponent] = useState<ComponentType<{
    onClose: () => void;
  }> | null>(null);

  useEffect(() => {
    if (showSkillsOnboarding && !OnboardingComponent) {
      import(
        "@/components/scientific-skills/scientific-skills-onboarding"
      ).then((mod) =>
        setOnboardingComponent(() => mod.ScientificSkillsOnboarding),
      );
    }
  }, [showSkillsOnboarding, OnboardingComponent]);

  return (
    <>
      <div className="divide-y divide-border/60">
        {/* Python (uv) */}
        <StatusRow
          ok={uvStatus === "ready"}
          label="Python (uv)"
          detail={
            uvInstalling
              ? "Installing..."
              : uvStatus === "ready"
                ? (uvVersion ?? "Installed")
                : uvStatus === "checking"
                  ? "Checking..."
                  : "Not installed"
          }
          action={
            uvStatus === "not-installed" && !uvInstalling
              ? { label: "Install", onClick: installUv }
              : uvInstalling
                ? { label: "Installing...", loading: true }
                : undefined
          }
        />

        {/* Scientific Skills */}
        <StatusRow
          ok={!!skillsStatus?.installed}
          label="Scientific Skills"
          detail={
            skillsInstalling
              ? "Installing..."
              : skillsStatus?.installed
                ? `${skillsStatus.skill_count} skills`
                : "Not installed"
          }
          action={
            skillsInstalling
              ? { label: "Installing...", loading: true }
              : {
                  label: skillsStatus?.installed ? "Manage" : "Install",
                  onClick: () => setShowSkillsOnboarding(true),
                  icon: skillsStatus?.installed ? "settings" : "download",
                }
          }
        />

        <StatusRow
          ok={true}
          label="DevPrism"
          detail={appVersion ? `v${appVersion}` : "Checking..."}
        />
      </div>

      {showSkillsOnboarding && OnboardingComponent && (
        <OnboardingComponent
          onClose={() => {
            setShowSkillsOnboarding(false);
            checkSkills();
          }}
        />
      )}
    </>
  );
}

function StatusRow({
  ok,
  label,
  detail,
  action,
}: {
  ok: boolean;
  label: string;
  detail: string;
  action?: {
    label: string;
    onClick?: () => void;
    loading?: boolean;
    icon?: "download" | "key" | "settings";
  };
}) {
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-3 px-4 py-3">
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border",
          ok
            ? "border-success/20 bg-success/10 text-success"
            : "border-border/70 bg-muted/30 text-muted-foreground",
        )}
      >
        {ok ? (
          <CheckCircle2Icon className="size-3.5" />
        ) : (
          <XCircleIcon className="size-3.5" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <span
          className={cn(
            "w-32 shrink-0 truncate font-medium text-sm",
            ok ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {detail}
        </span>
      </div>
      {action && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 rounded-md px-2.5 text-xs"
          onClick={action.onClick}
          disabled={action.loading}
        >
          {action.loading ? (
            <Loader2Icon className="mr-1 size-3 animate-spin" />
          ) : action.icon === "key" ? (
            <KeyRoundIcon className="mr-1 size-3" />
          ) : action.icon === "settings" ? (
            <SettingsIcon className="mr-1 size-3" />
          ) : (
            <DownloadIcon className="mr-1 size-3" />
          )}
          {action.label}
        </Button>
      )}
    </div>
  );
}
