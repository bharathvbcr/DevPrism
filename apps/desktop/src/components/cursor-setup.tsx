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
  LogInIcon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useCursorSetupStore,
  type StepInfo,
} from "@/stores/cursor-setup-store";
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
  const logs = useCursorSetupStore((s) => s.installLogs);
  const visible = useCursorSetupStore((s) => s.installLogsVisible);
  const toggle = useCursorSetupStore((s) => s.toggleInstallLogs);

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

interface CursorSetupProps {
  variant?: "default" | "embedded";
}

export function CursorSetup({ variant = "default" }: CursorSetupProps = {}) {
  const [apiKey, setApiKey] = useState("");
  const hasCheckedRef = useRef(false);
  const status = useCursorSetupStore((s) => s.status);
  const isInstalling = useCursorSetupStore((s) => s.isInstalling);
  const isLoggingIn = useCursorSetupStore((s) => s.isLoggingIn);
  const isSavingApiKey = useCursorSetupStore((s) => s.isSavingApiKey);
  const error = useCursorSetupStore((s) => s.error);
  const version = useCursorSetupStore((s) => s.version);
  const installSteps = useCursorSetupStore((s) => s.installSteps);
  const checkStatus = useCursorSetupStore((s) => s.checkStatus);
  const install = useCursorSetupStore((s) => s.install);
  const login = useCursorSetupStore((s) => s.login);
  const saveApiKey = useCursorSetupStore((s) => s.saveApiKey);

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

  const handleSaveApiKey = async (event: React.FormEvent) => {
    event.preventDefault();
    const success = await saveApiKey(apiKey);
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
        <span className="text-muted-foreground text-sm">
          Checking Cursor CLI...
        </span>
      </div>
    );
  }

  if (isInstalling) {
    return (
      <div className={setupSurfaceClass()}>
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-5 shrink-0 text-muted-foreground" />
          <p className="font-medium text-sm">Installing Cursor CLI</p>
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

  if (isLoggingIn) {
    return (
      <div className={setupSurfaceClass()}>
        <div className="flex items-center gap-2">
          <LogInIcon className="size-5 shrink-0 text-muted-foreground" />
          <p className="font-medium text-sm">Signing in to Cursor</p>
        </div>
        <p className="text-center text-[11px] text-muted-foreground">
          Complete the sign-in in your browser to continue.
        </p>
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
            <span className="font-semibold text-sm">Cursor CLI</span>
            <p className="mt-0.5 truncate text-muted-foreground text-xs">
              Authenticated{version ? ` · ${version}` : ""}
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
          <p className="font-medium text-sm">Cursor setup error</p>
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
          <DownloadIcon className="size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">Install Cursor CLI</p>
            <p className="text-muted-foreground text-xs">
              Required for the Cursor agent backend.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          className="w-full gap-2"
          onClick={() => void install()}
        >
          <DownloadIcon className="size-3.5" />
          Install Cursor CLI
        </Button>
        <p className="text-center text-[11px] text-muted-foreground">
          Installs via curl https://cursor.com/install
        </p>
      </div>
    );
  }

  // not-authenticated
  return (
    <div className={setupSurfaceClass()}>
      <div className="flex items-center gap-2">
        <KeyRoundIcon className="size-5 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium text-sm">Connect Cursor</p>
          <p className="text-muted-foreground text-xs">
            Sign in with your browser or paste a Cursor API key.
          </p>
        </div>
      </div>
      {version && (
        <p className="text-muted-foreground text-xs">Cursor CLI {version}</p>
      )}
      <form className="space-y-2" onSubmit={handleSaveApiKey}>
        <div className="space-y-1.5">
          <Label htmlFor="cursor-api-key" className="text-xs">
            Cursor API key
          </Label>
          <Input
            id="cursor-api-key"
            type="password"
            placeholder="key_..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={isSavingApiKey || isLoggingIn}
            autoComplete="off"
          />
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <Button
          type="submit"
          size="sm"
          className="w-full gap-2"
          disabled={!apiKey.trim() || isSavingApiKey || isLoggingIn}
        >
          {isSavingApiKey ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <KeyRoundIcon className="size-3.5" />
          )}
          {isSavingApiKey ? "Saving..." : "Save API key"}
        </Button>
      </form>
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-border" />
        <span className="text-[11px] text-muted-foreground">or</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <Button
        size="sm"
        variant="outline"
        className="w-full gap-2"
        onClick={() => void login()}
        disabled={isLoggingIn || isSavingApiKey}
      >
        <LogInIcon className="size-3.5" />
        Sign in with Browser
      </Button>
    </div>
  );
}
