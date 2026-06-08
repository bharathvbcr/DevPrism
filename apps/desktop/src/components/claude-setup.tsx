import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  DownloadIcon,
  LogInIcon,
  LoaderIcon,
  CheckCircle2Icon,
  CheckIcon,
  AlertCircleIcon,
  RefreshCwIcon,
  TerminalIcon,
  CircleIcon,
  ChevronRightIcon,
  GitBranchIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Trash2Icon,
} from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useClaudeSetupStore,
  type StepInfo,
} from "@/stores/claude-setup-store";
import { getProviderIconSrc } from "@/lib/provider-icons";
import { cn } from "@/lib/utils";

type OpenAICompatiblePreset = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  note: string;
};

type ClaudeCompatiblePreset = {
  id: string;
  label: string;
  baseUrl: string;
  note: string;
};

type ModelProviderCard = {
  id: string;
  label: string;
  provider: "claude-code" | "openai-compatible";
  baseUrl: string;
  model: string;
  badge: string;
  note: string;
};

const CLAUDE_COMPATIBLE_PRESETS: ClaudeCompatiblePreset[] = [
  {
    id: "modelgate-web",
    label: "ModelGate Claude (Web)",
    baseUrl: "https://mg.aid.pub/claude-proxy",
    note: "Use a ModelGate web API key with the Claude proxy endpoint.",
  },
  {
    id: "modelgate-local",
    label: "ModelGate Claude (Client)",
    baseUrl: "http://localhost:13148/claude-proxy",
    note: "Use a ModelGate client key while the local ModelGate client is running.",
  },
];

const OPENAI_COMPATIBLE_PRESETS: OpenAICompatiblePreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    model: "",
    note: "OpenAI chat completions endpoint.",
  },
  {
    id: "qwen",
    label: "Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "",
    note: "Alibaba Cloud Model Studio endpoint.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "",
    note: "DeepSeek OpenAI-compatible endpoint.",
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "",
    note: "Moonshot AI OpenAI-compatible endpoint.",
  },
  {
    id: "glm",
    label: "GLM (BigModel)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "",
    note: "Zhipu BigModel chat completions endpoint.",
  },
  {
    id: "gemini",
    label: "Gemini OpenAI",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "",
    note: "Google Gemini OpenAI-compatible endpoint.",
  },
];

const OPENAI_PROVIDER_CARDS: ModelProviderCard[] = [
  ...OPENAI_COMPATIBLE_PRESETS.map((preset) => ({
    ...preset,
    provider: "openai-compatible" as const,
    badge: preset.label
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase(),
  })),
];

const CLAUDE_PROVIDER_CARDS: ModelProviderCard[] = [
  {
    id: "anthropic-direct",
    label: "Anthropic",
    provider: "claude-code",
    baseUrl: "",
    model: "",
    badge: "A",
    note: "Use a direct Anthropic API key.",
  },
  ...CLAUDE_COMPATIBLE_PRESETS.map((preset) => ({
    ...preset,
    provider: "claude-code" as const,
    model: "",
    badge: "MG",
  })),
  {
    id: "custom-claude-proxy",
    label: "Custom Claude Proxy",
    provider: "claude-code",
    baseUrl: "",
    model: "",
    badge: "CP",
    note: "Use a Claude-compatible proxy endpoint.",
  },
];

const OPENAI_DEFAULT_PRESET_ID = OPENAI_PROVIDER_CARDS[0]?.id ?? "openai";

function normalizePresetBaseUrl(url: string) {
  return url
    .trim()
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function findOpenAiPresetIdForBaseUrl(baseUrl?: string | null) {
  const normalized = normalizePresetBaseUrl(baseUrl ?? "");
  if (!normalized) return null;

  return (
    OPENAI_COMPATIBLE_PRESETS.find(
      (preset) => normalizePresetBaseUrl(preset.baseUrl) === normalized,
    )?.id ?? null
  );
}

function openAiPresetIdForBaseUrl(baseUrl?: string | null) {
  return findOpenAiPresetIdForBaseUrl(baseUrl) ?? OPENAI_DEFAULT_PRESET_ID;
}

// ─── Event Hooks ───

function useInstallEvents() {
  const isInstalling = useClaudeSetupStore((s) => s.isInstalling);

  useEffect(() => {
    if (!isInstalling) return;

    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    // Synthetic timer: advance to "installing" after 3s if still on downloading
    const timer = setTimeout(() => {
      if (cancelled) return;
      const store = useClaudeSetupStore.getState();
      const downloadStep = store.installSteps.find(
        (s) => s.id === "downloading",
      );
      if (downloadStep?.status === "active") {
        store._advanceInstallStep("installing");
      }
    }, 3000);

    (async () => {
      const unlistenOutput = await listen<string>("install-output", (event) => {
        if (cancelled) return;
        const store = useClaudeSetupStore.getState();
        const line = event.payload;
        store._appendInstallLog(line);

        // Parse output for step advancement
        const lower = line.toLowerCase();
        if (lower.includes("setting up") || lower.includes("installing")) {
          store._advanceInstallStep("installing");
        }
        if (
          lower.includes("complete") ||
          lower.includes("successfully") ||
          line.includes("✅")
        ) {
          store._advanceInstallStep("verifying");
        }
      });

      const unlistenError = await listen<string>("install-error", (event) => {
        if (cancelled) return;
        useClaudeSetupStore.getState()._appendInstallLog(event.payload);
      });

      const unlistenComplete = await listen<boolean>(
        "install-complete",
        (event) => {
          if (cancelled) return;
          clearTimeout(timer);
          useClaudeSetupStore.getState()._finishInstall(event.payload);
        },
      );

      if (cancelled) {
        unlistenOutput();
        unlistenError();
        unlistenComplete();
        return;
      }

      unlisteners.push(unlistenOutput, unlistenError, unlistenComplete);
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      for (const u of unlisteners) u();
    };
  }, [isInstalling]);
}

function useLoginEvents() {
  const isLoggingIn = useClaudeSetupStore((s) => s.isLoggingIn);

  useEffect(() => {
    if (!isLoggingIn) return;

    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    // Advance to "waiting-auth" after 1.5s
    const timer = setTimeout(() => {
      if (cancelled) return;
      useClaudeSetupStore.getState()._advanceLoginStep("waiting-auth");
    }, 1500);

    (async () => {
      const unlistenOutput = await listen<string>("login-output", (_event) => {
        if (cancelled) return;
        // Any output means browser is open, advance to waiting
        useClaudeSetupStore.getState()._advanceLoginStep("waiting-auth");
      });

      const unlistenError = await listen<string>("login-error", () => {
        // ignore stderr for login
      });

      const unlistenComplete = await listen<boolean>(
        "login-complete",
        (event) => {
          if (cancelled) return;
          clearTimeout(timer);
          useClaudeSetupStore.getState()._finishLogin(event.payload);
        },
      );

      if (cancelled) {
        unlistenOutput();
        unlistenError();
        unlistenComplete();
        return;
      }

      unlisteners.push(unlistenOutput, unlistenError, unlistenComplete);
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      for (const u of unlisteners) u();
    };
  }, [isLoggingIn]);
}

// ─── Sub-components ───

function StepRow({ step }: { step: StepInfo }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      {step.status === "complete" && (
        <CheckIcon className="size-3.5 text-green-600" />
      )}
      {step.status === "active" && (
        <LoaderIcon className="size-3.5 animate-spin text-foreground" />
      )}
      {step.status === "pending" && (
        <CircleIcon className="size-3.5 text-muted-foreground/30" />
      )}
      {step.status === "error" && (
        <AlertCircleIcon className="size-3.5 text-destructive" />
      )}
      <span
        className={cn(
          "text-sm",
          step.status === "complete" && "text-green-600",
          step.status === "active" && "font-medium text-foreground",
          step.status === "pending" && "text-muted-foreground/60",
          step.status === "error" && "text-destructive",
        )}
      >
        {step.label}
      </span>
    </div>
  );
}

function InstallLogOutput() {
  const logs = useClaudeSetupStore((s) => s.installLogs);
  const visible = useClaudeSetupStore((s) => s.installLogsVisible);
  const toggle = useClaudeSetupStore((s) => s.toggleInstallLogs);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current && visible) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, visible]);

  return (
    <div className="mt-1">
      <button
        onClick={toggle}
        className="flex items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 transition-transform duration-200",
            visible && "rotate-90",
          )}
        />
        {visible ? "Hide logs" : "Show logs"}
        {logs.length > 0 && (
          <span className="text-muted-foreground/50">({logs.length})</span>
        )}
      </button>
      <div
        className={cn(
          "overflow-hidden transition-[max-height] duration-300 ease-in-out",
          visible ? "max-h-40" : "max-h-0",
        )}
      >
        <div
          ref={scrollRef}
          className="mt-2 max-h-36 overflow-y-auto rounded-md border border-border bg-foreground/3 p-3 font-mono text-[11px] text-muted-foreground leading-relaxed"
        >
          {logs.length === 0 ? (
            <span className="italic">Waiting for output...</span>
          ) : (
            logs.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───

export function ClaudeSetup() {
  const [provider, setProvider] = useState<"claude-code" | "openai-compatible">(
    "claude-code",
  );
  const [providerPreset, setProviderPreset] = useState("anthropic-direct");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);
  const [isEditingProvider, setIsEditingProvider] = useState(false);
  const status = useClaudeSetupStore((s) => s.status);
  const isInstalling = useClaudeSetupStore((s) => s.isInstalling);
  const isLoggingIn = useClaudeSetupStore((s) => s.isLoggingIn);
  const isSavingApiKey = useClaudeSetupStore((s) => s.isSavingApiKey);
  const isClearingApiKey = useClaudeSetupStore((s) => s.isClearingApiKey);
  const error = useClaudeSetupStore((s) => s.error);
  const version = useClaudeSetupStore((s) => s.version);
  const accountEmail = useClaudeSetupStore((s) => s.accountEmail);
  const providerModel = useClaudeSetupStore((s) => s.providerModel);
  const providerBaseUrl = useClaudeSetupStore((s) => s.providerBaseUrl);
  const openAiCredentials = useClaudeSetupStore((s) => s.openAiCredentials);
  const install = useClaudeSetupStore((s) => s.install);
  const login = useClaudeSetupStore((s) => s.login);
  const saveApiKey = useClaudeSetupStore((s) => s.saveApiKey);
  const clearApiKey = useClaudeSetupStore((s) => s.clearApiKey);
  const fetchProviderModels = useClaudeSetupStore((s) => s.fetchProviderModels);
  const checkStatus = useClaudeSetupStore((s) => s.checkStatus);
  const installSteps = useClaudeSetupStore((s) => s.installSteps);
  const loginSteps = useClaudeSetupStore((s) => s.loginSteps);

  useInstallEvents();
  useLoginEvents();

  const handleSaveApiKey = async (
    selectedProvider: "claude-code" | "openai-compatible" = provider,
    credentialLabel?: string,
  ) => {
    const savedPreset =
      selectedProvider === "openai-compatible"
        ? openAiPresetIdForBaseUrl(baseUrl)
        : "anthropic-direct";
    const success = await saveApiKey(
      apiKey,
      baseUrl,
      selectedProvider,
      model,
      credentialLabel,
    );
    if (success) {
      setApiKey("");
      setBaseUrl("");
      setModel("");
      setModelOptions([]);
      setModelFetchError(null);
      setProviderPreset(savedPreset);
      setIsEditingProvider(false);
    }
  };

  const beginProviderEdit = (isDirectProvider: boolean) => {
    setProvider(isDirectProvider ? "openai-compatible" : "claude-code");
    setProviderPreset(
      isDirectProvider
        ? openAiPresetIdForBaseUrl(providerBaseUrl)
        : "anthropic-direct",
    );
    setApiKey("");
    setBaseUrl(isDirectProvider ? providerBaseUrl || "" : "");
    setModel(isDirectProvider ? providerModel || "" : "");
    setModelOptions([]);
    setModelFetchError(null);
    setIsEditingProvider(true);
  };

  const handleClearApiKey = async () => {
    const success = await clearApiKey();
    if (success) {
      setApiKey("");
      setBaseUrl("");
      setModel("");
      setModelOptions([]);
      setModelFetchError(null);
      setProviderPreset("anthropic-direct");
      setIsEditingProvider(false);
    }
  };

  const selectProviderCard = (card: ModelProviderCard) => {
    setProvider(card.provider);
    setProviderPreset(card.id);
    setBaseUrl(card.baseUrl);
    setModel(card.model);
    setModelOptions(card.model ? [card.model] : []);
    setModelFetchError(null);
  };

  const handleFetchModels = async () => {
    setIsFetchingModels(true);
    setModelFetchError(null);
    try {
      const models = await fetchProviderModels(apiKey, baseUrl);
      setModelOptions(models);
      if (!models.includes(model)) {
        setModel(models[0] ?? "");
      }
    } catch (err: any) {
      setModelOptions([]);
      setModelFetchError(err?.message || String(err));
    } finally {
      setIsFetchingModels(false);
    }
  };

  const renderApiKeyForm = ({
    forceOpenAiCompatible = false,
    allowBrowserSignIn = false,
  }: {
    forceOpenAiCompatible?: boolean;
    allowBrowserSignIn?: boolean;
  } = {}) => {
    const selectedProvider = forceOpenAiCompatible
      ? "openai-compatible"
      : provider;
    const providerCards = forceOpenAiCompatible
      ? OPENAI_PROVIDER_CARDS
      : [...OPENAI_PROVIDER_CARDS, ...CLAUDE_PROVIDER_CARDS];
    const providerCardIds = new Set(providerCards.map((card) => card.id));
    const fallbackCardId =
      selectedProvider === "openai-compatible"
        ? OPENAI_DEFAULT_PRESET_ID
        : "anthropic-direct";
    const activeCardId = providerCardIds.has(providerPreset)
      ? providerPreset
      : fallbackCardId;
    const activeCard = providerCards.find((card) => card.id === activeCardId);

    return (
      <>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            handleSaveApiKey(selectedProvider, activeCard?.label);
          }}
        >
          <div className="space-y-2">
            <Label className="text-xs">
              {selectedProvider === "openai-compatible"
                ? "Model Provider"
                : "Provider"}
            </Label>
            <div className="grid grid-cols-2 gap-2">
              {providerCards.map((card) => {
                const iconSrc = getProviderIconSrc(card);
                const active = activeCardId === card.id;

                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => selectProviderCard(card)}
                    disabled={isSavingApiKey}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-md border font-semibold text-[10px]",
                        active
                          ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-border bg-muted text-muted-foreground",
                      )}
                    >
                      {iconSrc ? (
                        <img
                          src={iconSrc}
                          alt=""
                          className="size-4 object-contain"
                        />
                      ) : (
                        card.badge
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-xs">
                        {card.label}
                      </span>
                      <span className="block truncate text-muted-foreground text-xs">
                        {card.note}
                      </span>
                    </span>
                    {active && <CheckIcon className="size-3 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="anthropic-api-key" className="text-xs">
              {selectedProvider === "openai-compatible"
                ? "Provider API Key"
                : "Anthropic / Proxy Key"}
            </Label>
            <Input
              id="anthropic-api-key"
              type="password"
              placeholder={
                selectedProvider === "openai-compatible"
                  ? "sk-..."
                  : "sk-ant-... or provider key"
              }
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setModelOptions([]);
                setModelFetchError(null);
              }}
              disabled={isSavingApiKey}
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">
              {selectedProvider === "openai-compatible"
                ? "Use the API key from your model provider."
                : "Anthropic keys start with sk-ant-. Claude-compatible proxies can use their own key format."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="anthropic-base-url" className="text-xs">
              Base URL
            </Label>
            <Input
              id="anthropic-base-url"
              type="url"
              placeholder={
                selectedProvider === "openai-compatible"
                  ? "https://api.deepseek.com or https://dashscope.aliyuncs.com/compatible-mode/v1"
                  : "https://mg.aid.pub/claude-proxy"
              }
              value={baseUrl}
              onChange={(event) => {
                const nextUrl = event.target.value;
                const matchingPreset = findOpenAiPresetIdForBaseUrl(nextUrl);
                setBaseUrl(nextUrl);
                setModelOptions([]);
                setModelFetchError(null);
                if (selectedProvider === "openai-compatible") {
                  if (matchingPreset) {
                    setProviderPreset(matchingPreset);
                  }
                } else {
                  setProviderPreset(
                    nextUrl.trim()
                      ? "custom-claude-proxy"
                      : "anthropic-direct",
                  );
                }
              }}
              disabled={isSavingApiKey}
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">
              {selectedProvider === "openai-compatible"
                ? "Use either the API root or a full /chat/completions URL."
                : "Leave blank for Anthropic direct API."}
            </p>
          </div>

          {selectedProvider === "openai-compatible" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="provider-model" className="text-xs">
                  Model
                </Label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={handleFetchModels}
                  disabled={
                    isSavingApiKey ||
                    isFetchingModels ||
                    !apiKey.trim() ||
                    !baseUrl.trim()
                  }
                >
                  {isFetchingModels ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3" />
                  )}
                  Fetch Models
                </Button>
              </div>
              {modelOptions.length > 0 ? (
                <Select
                  value={model}
                  onValueChange={(value) => {
                    setModel(value);
                  }}
                  disabled={isSavingApiKey}
                >
                  <SelectTrigger id="provider-model" className="h-9 w-full">
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="provider-model"
                  type="text"
                  placeholder="Fetch models, or enter qwen3-coder-plus, deepseek-v4-pro, glm-5.1, ..."
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                  }}
                  disabled={isSavingApiKey}
                  autoComplete="off"
                />
              )}
              {modelFetchError && (
                <p className="break-words text-[11px] text-amber-600">
                  {modelFetchError}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                Fetches the provider's real /models list when available.
              </p>
            </div>
          )}

          {error && (
            <p className="break-words text-destructive text-xs">{error}</p>
          )}
          <Button
            type="submit"
            size="sm"
            className="w-full gap-2"
            disabled={
              !apiKey.trim() ||
              isSavingApiKey ||
              (selectedProvider === "openai-compatible" &&
                (!baseUrl.trim() || !model.trim()))
            }
          >
            {isSavingApiKey ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <KeyRoundIcon className="size-3.5" />
            )}
            {isSavingApiKey
              ? selectedProvider === "openai-compatible"
                ? "Verifying..."
                : "Saving..."
              : selectedProvider === "openai-compatible"
                ? "Verify & Use API Key"
                : "Use API Key"}
          </Button>
        </form>

        {allowBrowserSignIn && (
          <>
            <div className="flex items-center gap-2">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[11px] text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <Button
              size="sm"
              variant="outline"
              className="w-full gap-2"
              onClick={login}
              disabled={isSavingApiKey}
            >
              <LogInIcon className="size-3.5" />
              Sign in with Browser
            </Button>
          </>
        )}
      </>
    );
  };

  if (status === "checking") {
    return (
      <div className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-muted/30 px-5 py-4">
        <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground text-sm">
          Checking Claude Code...
        </span>
      </div>
    );
  }

  if (status === "ready") {
    const isDirectProvider = version === "OpenAI-compatible provider";
    const readyDetail = isDirectProvider
      ? [version, providerModel, providerBaseUrl].filter(Boolean).join(" / ")
      : [version, accountEmail].filter(Boolean).join(" / ");

    if (isEditingProvider) {
      return (
        <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-muted/30 px-5 py-4">
          <div className="flex items-center gap-3">
            <CheckCircle2Icon className="size-5 shrink-0 text-green-600" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm">
                {isDirectProvider ? "Update AI Provider" : "Update Claude Code"}
              </p>
              <p className="truncate text-muted-foreground text-xs">
                {readyDetail}
              </p>
            </div>
          </div>

          {renderApiKeyForm({ allowBrowserSignIn: !isDirectProvider })}

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setIsEditingProvider(false);
                setApiKey("");
                setBaseUrl("");
                setModel("");
                setModelOptions([]);
                setModelFetchError(null);
                setProviderPreset("anthropic-direct");
              }}
              disabled={isSavingApiKey || isClearingApiKey}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-2 text-destructive hover:text-destructive"
              onClick={handleClearApiKey}
              disabled={isSavingApiKey || isClearingApiKey}
            >
              {isClearingApiKey ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              Forget Provider
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex w-full flex-col gap-2 rounded-xl border border-border bg-muted/30 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <CheckCircle2Icon className="size-3.5 shrink-0 text-foreground" />
          <span className="shrink-0 text-sm">
            {isDirectProvider ? "AI Providers" : "Claude Code"}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {readyDetail}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 gap-1 px-2 text-xs"
            onClick={() => beginProviderEdit(isDirectProvider)}
          >
            <RefreshCwIcon className="size-3" />
            Add
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 gap-1 px-2 text-destructive text-xs hover:text-destructive"
            onClick={handleClearApiKey}
            disabled={isClearingApiKey}
          >
            {isClearingApiKey ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <Trash2Icon className="size-3" />
            )}
            Clear
          </Button>
        </div>

        {isDirectProvider && openAiCredentials.length > 0 && (
          <div className="space-y-1 border-border border-t pt-2">
            {openAiCredentials.map((credential) => {
              const iconSrc = getProviderIconSrc({
                label: credential.label,
                baseUrl: credential.base_url,
                model: credential.model,
              });

              return (
                <div
                  key={credential.id}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs"
                >
                  {iconSrc ? (
                    <img
                      src={iconSrc}
                      alt=""
                      className="size-3.5 shrink-0 object-contain"
                    />
                  ) : (
                    <CircleIcon className="size-2.5 shrink-0 text-muted-foreground/50" />
                  )}
                  <span className="shrink-0 font-medium">
                    {credential.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {credential.model}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Installation in progress
  if (isInstalling) {
    return (
      <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-muted/30 px-5 py-4">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-5 shrink-0 text-muted-foreground" />
          <p className="font-medium text-sm">Installing Claude Code</p>
        </div>

        <div className="space-y-0 pl-1">
          {installSteps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </div>

        <InstallLogOutput />
      </div>
    );
  }

  // Login in progress
  if (isLoggingIn) {
    return (
      <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-muted/30 px-5 py-4">
        <div className="flex items-center gap-2">
          <LogInIcon className="size-5 shrink-0 text-muted-foreground" />
          <p className="font-medium text-sm">Signing in to Claude</p>
        </div>

        <div className="space-y-0 pl-1">
          {loginSteps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </div>

        <p className="text-center text-[11px] text-muted-foreground">
          Complete the sign-in in your browser to continue.
        </p>
      </div>
    );
  }

  if (status === "error") {
    const hasInstallSteps = installSteps.length > 0;

    return (
      <div className="flex w-full flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-4">
        <div className="flex items-center gap-2">
          <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
          <p className="font-medium text-sm">
            {hasInstallSteps ? "Installation Failed" : "Setup Error"}
          </p>
        </div>

        {hasInstallSteps && (
          <div className="space-y-0 pl-1">
            {installSteps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </div>
        )}

        {error && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            {error}
          </p>
        )}

        {hasInstallSteps && <InstallLogOutput />}

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={hasInstallSteps ? install : checkStatus}
          >
            <RefreshCwIcon className="size-3.5" />
            {hasInstallSteps ? "Retry Installation" : "Retry"}
          </Button>
          {!hasInstallSteps && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground"
              onClick={() => {
                shellOpen("https://code.claude.com/docs/en/quickstart");
              }}
            >
              <ExternalLinkIcon className="size-3.5" />
              Setup Guide
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (status === "missing-git") {
    return (
      <div className="flex w-full flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-5 py-4">
        <div className="flex items-center gap-2">
          <GitBranchIcon className="size-5 shrink-0 text-amber-600" />
          <div>
            <p className="font-medium text-sm">Connect AI Provider</p>
            <p className="text-muted-foreground text-xs">
              OpenAI-compatible providers work without Git. Git for Windows is
              only needed if you want Claude Code/browser sign-in.
            </p>
          </div>
        </div>
        {renderApiKeyForm({ forceOpenAiCompatible: true })}
        <div className="flex items-center gap-2">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[11px] text-muted-foreground">Claude Code</span>
          <div className="h-px flex-1 bg-border" />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-full gap-2"
          onClick={() => {
            shellOpen("https://git-scm.com/downloads/win");
          }}
        >
          <ExternalLinkIcon className="size-3.5" />
          Download Git for Windows
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="w-full gap-2 text-muted-foreground"
          onClick={checkStatus}
        >
          <RefreshCwIcon className="size-3.5" />
          I've installed Git
        </Button>
      </div>
    );
  }

  if (status === "not-installed") {
    return (
      <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-muted/30 px-5 py-4">
        <div className="flex items-center gap-2">
          <KeyRoundIcon className="size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">Connect AI Provider</p>
            <p className="text-muted-foreground text-xs">
              Use Qwen, DeepSeek, GLM, Gemini, or another OpenAI-compatible
              endpoint without installing Claude Code.
            </p>
          </div>
        </div>
        {renderApiKeyForm({ forceOpenAiCompatible: true })}
        <div className="flex items-center gap-2">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[11px] text-muted-foreground">Claude Code</span>
          <div className="h-px flex-1 bg-border" />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-full gap-2"
          onClick={install}
        >
          <DownloadIcon className="size-3.5" />
          Install Claude Code
        </Button>
        <p className="text-center text-[11px] text-muted-foreground">
          Installs to ~/.local/bin/claude
        </p>
      </div>
    );
  }

  if (status === "not-authenticated") {
    return (
      <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-muted/30 px-5 py-4">
        <div className="flex items-center gap-2">
          <KeyRoundIcon className="size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">Connect Claude</p>
            <p className="text-muted-foreground text-xs">
              Use an Anthropic key, an external API proxy, or browser sign-in.
            </p>
          </div>
        </div>
        {version && (
          <p className="text-muted-foreground text-xs">
            Claude Code {version} installed
          </p>
        )}

        {renderApiKeyForm({ allowBrowserSignIn: true })}
      </div>
    );
  }

  return null;
}
