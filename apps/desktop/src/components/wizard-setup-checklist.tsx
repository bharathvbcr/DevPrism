import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleIcon,
  Loader2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";

interface SkillsStatus {
  installed: boolean;
  skill_count: number;
}

type ItemState = "ready" | "loading" | "blocked" | "error";

function SetupChip({
  state,
  label,
  detail,
  action,
}: {
  state: ItemState;
  label: string;
  detail: string;
  action?: { label: string; onClick: () => void; loading?: boolean };
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-2",
        state === "ready"
          ? "border-green-500/25 bg-green-500/5"
          : state === "error"
            ? "border-destructive/30 bg-destructive/5"
            : "border-border/60 bg-muted/20",
      )}
    >
      <div
        className={cn(
          "shrink-0",
          state === "ready" && "text-green-600 dark:text-green-400",
          state === "loading" && "text-muted-foreground",
          state === "error" && "text-destructive",
          state === "blocked" && "text-muted-foreground/70",
        )}
      >
        {state === "ready" ? (
          <CheckCircle2Icon className="size-4" />
        ) : state === "loading" ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : state === "error" ? (
          <AlertCircleIcon className="size-4" />
        ) : (
          <CircleIcon className="size-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-xs">{label}</div>
        <div
          className={cn(
            "truncate text-[10px]",
            state === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          title={detail}
        >
          {detail}
        </div>
      </div>
      {action && state !== "ready" && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-[10px]"
          disabled={action.loading}
          onClick={action.onClick}
        >
          {action.loading ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            action.label
          )}
        </Button>
      )}
    </div>
  );
}

/** Compact setup checklist inside the new-project wizard. */
export function WizardSetupChecklist({
  className,
  onOpenSettings,
}: {
  className?: string;
  onOpenSettings?: () => void;
}) {
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  const claudeStatus = useClaudeSetupStore((s) => s.status);
  const claudeError = useClaudeSetupStore((s) => s.error);
  const isClaudeInstalling = useClaudeSetupStore((s) => s.isInstalling);
  const checkClaude = useClaudeSetupStore((s) => s.checkStatus);
  const installClaude = useClaudeSetupStore((s) => s.install);

  const uvStatus = useUvSetupStore((s) => s.status);
  const uvError = useUvSetupStore((s) => s.error);
  const isUvInstalling = useUvSetupStore((s) => s.isInstalling);
  const checkUv = useUvSetupStore((s) => s.checkStatus);
  const installUv = useUvSetupStore((s) => s.install);

  const [skillsStatus, setSkillsStatus] = useState<SkillsStatus | null>(null);
  const [skillsChecking, setSkillsChecking] = useState(true);

  const checkSkills = useCallback(async () => {
    setSkillsChecking(true);
    try {
      const status = await invoke<SkillsStatus>("check_skills_installed", {
        projectPath: null,
      });
      setSkillsStatus(status);
    } catch {
      setSkillsStatus(null);
    } finally {
      setSkillsChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkClaude();
    void checkUv();
    void checkSkills();
  }, [checkClaude, checkUv, checkSkills]);

  const isClaudeReady = claudeStatus === "ready";
  const isUvReady = uvStatus === "ready";
  const isSkillsReady = Boolean(skillsStatus?.installed);

  const needsAiSetup = !nativeAgentEnabled && !isClaudeReady;
  const needsUvSetup = !isUvReady;
  const allReady = (nativeAgentEnabled || isClaudeReady) && isUvReady;

  const items = useMemo(() => {
    const list: Array<{
      key: string;
      state: ItemState;
      label: string;
      detail: string;
      action?: { label: string; onClick: () => void; loading?: boolean };
    }> = [];

    if (!nativeAgentEnabled) {
      list.push({
        key: "claude",
        state:
          isClaudeInstalling || claudeStatus === "checking"
            ? "loading"
            : claudeStatus === "error"
              ? "error"
              : isClaudeReady
                ? "ready"
                : "blocked",
        label: "AI provider",
        detail: isClaudeReady
          ? "Ready"
          : claudeStatus === "not-installed"
            ? "Required for AI-generated content"
            : (claudeError ?? "Configure in Settings"),
        action:
          claudeStatus === "not-installed" || claudeStatus === "error"
            ? {
                label: isClaudeInstalling ? "…" : "Install",
                loading: isClaudeInstalling,
                onClick: installClaude,
              }
            : !isClaudeReady
              ? { label: "Check", onClick: checkClaude }
              : undefined,
      });
    }

    list.push({
      key: "uv",
      state:
        isUvInstalling || uvStatus === "checking"
          ? "loading"
          : uvStatus === "error"
            ? "error"
            : isUvReady
              ? "ready"
              : "blocked",
      label: "Python (uv)",
      detail: isUvReady
        ? "Ready"
        : uvStatus === "not-installed"
          ? "Optional for scientific workflows"
          : (uvError ?? "Not installed"),
      action:
        uvStatus === "not-installed" || uvStatus === "error"
          ? {
              label: isUvInstalling ? "…" : "Install",
              loading: isUvInstalling,
              onClick: installUv,
            }
          : !isUvReady
            ? { label: "Check", onClick: checkUv }
            : undefined,
    });

    if (!skillsChecking && !isSkillsReady) {
      list.push({
        key: "skills",
        state: "blocked",
        label: "Scientific skills",
        detail: "Optional — install later from Settings",
      });
    }

    return list;
  }, [
    checkClaude,
    claudeError,
    claudeStatus,
    installClaude,
    installUv,
    isClaudeInstalling,
    isClaudeReady,
    isSkillsReady,
    isUvInstalling,
    isUvReady,
    nativeAgentEnabled,
    skillsChecking,
    uvError,
    uvStatus,
    checkUv,
  ]);

  if (!needsAiSetup && !needsUvSetup) return null;
  if (allReady) return null;

  return (
    <div
      className={cn(
        "rounded-xl border border-amber-500/30 bg-amber-500/5 p-3",
        className,
      )}
      role="region"
      aria-label="Environment setup checklist"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-sm">
            Finish setup for the best experience
          </p>
          <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
            {needsAiSetup
              ? "AI-generated project content needs a configured provider."
              : "Install Python tooling to unlock scientific skills in new projects."}
          </p>
        </div>
        {onOpenSettings && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={onOpenSettings}
          >
            Settings
          </Button>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <SetupChip
            key={item.key}
            state={item.state}
            label={item.label}
            detail={item.detail}
            action={item.action}
          />
        ))}
      </div>
    </div>
  );
}
