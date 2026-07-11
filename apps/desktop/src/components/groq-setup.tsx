import { useEffect, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  DownloadIcon,
  KeyRoundIcon,
  LoaderIcon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  GROQ_DEFAULT_MODEL,
  useGroqSetupStore,
  type StepInfo,
} from "@/stores/groq-setup-store";
import { cn } from "@/lib/utils";

function StepRow({ step }: { step: StepInfo }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      {step.status === "complete" && (
        <CheckIcon className="size-3.5 text-green-600 dark:text-green-400" />
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
          step.status === "complete" && "text-green-600 dark:text-green-400",
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
  const logs = useGroqSetupStore((s) => s.installLogs);
  const visible = useGroqSetupStore((s) => s.installLogsVisible);
  const toggle = useGroqSetupStore((s) => s.toggleInstallLogs);

  return (
    <div className="mt-1">
      <button
        type="button"
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
        <div className="mt-2 max-h-36 overflow-y-auto rounded-md border border-border bg-foreground/3 p-3 font-mono text-[11px] text-muted-foreground leading-relaxed">
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

interface GroqSetupProps {
  variant?: "default" | "embedded";
}

export function GroqSetup({ variant = "default" }: GroqSetupProps = {}) {
  const [apiKey, setApiKey] = useState("");
  const hasCheckedRef = useRef(false);
  const status = useGroqSetupStore((s) => s.status);
  const isInstalling = useGroqSetupStore((s) => s.isInstalling);
  const isVerifyingKey = useGroqSetupStore((s) => s.isVerifyingKey);
  const error = useGroqSetupStore((s) => s.error);
  const version = useGroqSetupStore((s) => s.version);
  const apiKeyConfigured = useGroqSetupStore((s) => s.apiKeyConfigured);
  const installSteps = useGroqSetupStore((s) => s.installSteps);
  const checkStatus = useGroqSetupStore((s) => s.checkStatus);
  const install = useGroqSetupStore((s) => s.install);
  const verifyApiKey = useGroqSetupStore((s) => s.verifyApiKey);

  const isEmbedded = variant === "embedded";
  const setupSurfaceClass = (tone: "default" | "error" = "default") =>
    cn(
      "flex w-full flex-col gap-3",
      isEmbedded
        ? "px-4 py-3"
        : tone === "error"
          ? "rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-4"
          : "rounded-xl border border-border bg-muted/30 px-5 py-4",
    );

  useEffect(() => {
    if (!hasCheckedRef.current) {
      hasCheckedRef.current = true;
      void checkStatus();
    }
  }, [checkStatus]);

  const handleVerifyApiKey = async (event: React.FormEvent) => {
    event.preventDefault();
    const success = await verifyApiKey(apiKey);
    if (success) setApiKey("");
  };

  if (status === "checking") {
    return (
      <div
        className={cn(
          "flex w-full items-center justify-center gap-2",
          isEmbedded
            ? "px-4 py-3"
            : "rounded-xl border border-border bg-muted/30 px-5 py-4",
        )}
      >
        <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground text-sm">Checking Groq...</span>
      </div>
    );
  }

  if (isInstalling) {
    return (
      <div className={setupSurfaceClass()}>
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-5 shrink-0 text-muted-foreground" />
          <p className="font-medium text-sm">Installing groq-code-cli</p>
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

  if (status === "ready") {
    return (
      <div
        className={cn(
          "w-full",
          isEmbedded ? "" : "rounded-xl border border-border bg-muted/30",
        )}
      >
        <div className="flex min-w-0 items-center gap-3 px-4 py-3.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400">
            <CheckCircle2Icon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="font-semibold text-sm">Groq</span>
            <p className="mt-0.5 truncate text-muted-foreground text-xs">
              API key configured
              {version ? ` · groq-code-cli ${version}` : ""}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className={setupSurfaceClass("error")}>
        <div className="flex items-center gap-2">
          <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
          <p className="font-medium text-sm">Groq setup error</p>
        </div>
        {error && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            {error}
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => void checkStatus()}
        >
          <RefreshCwIcon className="size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (status === "not-installed") {
    return (
      <div className={setupSurfaceClass()}>
        <div className="flex items-center gap-2">
          <KeyRoundIcon className="size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">Connect Groq</p>
            <p className="text-muted-foreground text-xs">
              Add your Groq API key for the native Groq agent. Optionally
              install groq-code-cli for terminal use.
            </p>
          </div>
        </div>
        <form className="space-y-2" onSubmit={handleVerifyApiKey}>
          <div className="space-y-1.5">
            <Label htmlFor="groq-api-key" className="text-xs">
              Groq API key
            </Label>
            <Input
              id="groq-api-key"
              type="password"
              placeholder="gsk_..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={isVerifyingKey}
              autoComplete="off"
            />
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
          <Button
            type="submit"
            size="sm"
            className="w-full gap-2"
            disabled={!apiKey.trim() || isVerifyingKey}
          >
            {isVerifyingKey ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <KeyRoundIcon className="size-3.5" />
            )}
            {isVerifyingKey ? "Verifying..." : "Verify API key"}
          </Button>
        </form>
        <div className="flex items-center gap-2">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[11px] text-muted-foreground">optional</span>
          <div className="h-px flex-1 bg-border" />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-full gap-2"
          onClick={() => void install()}
        >
          <DownloadIcon className="size-3.5" />
          Install groq-code-cli
        </Button>
        <p className="text-center text-[11px] text-muted-foreground">
          Default model: {GROQ_DEFAULT_MODEL}
        </p>
      </div>
    );
  }

  // not-authenticated — CLI may be installed but API key missing
  return (
    <div className={setupSurfaceClass()}>
      <div className="flex items-center gap-2">
        <KeyRoundIcon className="size-5 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium text-sm">Groq API key required</p>
          <p className="text-muted-foreground text-xs">
            {version
              ? `groq-code-cli ${version} installed — add your API key to chat.`
              : "Add your Groq API key to use the native Groq agent."}
          </p>
        </div>
      </div>
      <form className="space-y-2" onSubmit={handleVerifyApiKey}>
        <div className="space-y-1.5">
          <Label htmlFor="groq-api-key-auth" className="text-xs">
            Groq API key
          </Label>
          <Input
            id="groq-api-key-auth"
            type="password"
            placeholder="gsk_..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={isVerifyingKey}
            autoComplete="off"
          />
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <Button
          type="submit"
          size="sm"
          className="w-full gap-2"
          disabled={!apiKey.trim() || isVerifyingKey}
        >
          {isVerifyingKey ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <KeyRoundIcon className="size-3.5" />
          )}
          {isVerifyingKey ? "Verifying..." : "Verify API key"}
        </Button>
      </form>
      {!apiKeyConfigured && (
        <Button
          size="sm"
          variant="ghost"
          className="w-full gap-2 text-muted-foreground"
          onClick={() => void checkStatus()}
        >
          <RefreshCwIcon className="size-3.5" />
          Recheck status
        </Button>
      )}
    </div>
  );
}
