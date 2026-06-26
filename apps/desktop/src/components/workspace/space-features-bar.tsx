import { useMemo } from "react";
import { useVariantsStore } from "@/stores/variants-store";
import { useSpaceFeatures } from "@/hooks/use-space-features";
import { VersionSwitcher } from "@/components/workspace/version-switcher";
import { SpaceQuickActions } from "@/components/workspace/space-quick-actions";

/**
 * Workspace feature rail that adapts to the current project's space kind —
 * resume spaces get JD tailoring, manuscript spaces get submission versions,
 * statement spaces get prompt tailoring, report spaces get audience versions,
 * and general spaces stay minimal. Projects without a space still infer kind
 * from the folder name.
 */
export function SpaceFeaturesBar() {
  const { ownerRoot, config } = useSpaceFeatures();
  const variants = useVariantsStore((s) => s.variants);

  if (!ownerRoot) return null;

  const showVariants = config.variants || variants.length > 0;
  const showQuickActions = config.quickActions.length > 0;

  if (!showVariants && !showQuickActions) return null;

  const quickActions = showQuickActions ? (
    <SpaceQuickActions actions={config.quickActions} />
  ) : null;

  // The version switcher hosts the quick-actions menu inline so the space
  // header stays a single compact row instead of two stacked bars.
  if (showVariants) {
    return <VersionSwitcher config={config} trailing={quickActions} />;
  }

  // Spaces without versioning still surface their quick actions on their own row.
  return (
    <div className="flex h-8 shrink-0 items-center justify-end border-sidebar-border border-b px-3">
      {quickActions}
    </div>
  );
}
