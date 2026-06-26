import { useMemo, useEffect, useRef } from "react";
import { useDocumentStore } from "@/stores/document-store";
import { useSpacesStore, type Space } from "@/stores/spaces-store";
import { deriveOwner } from "@/stores/variants-store";
import { recordPersonalizationEvent } from "@/lib/personalization";
import {
  inferSpaceKind,
  inferSpaceKindFromProjectPath,
  spaceFeatureConfig,
  type SpaceFeatureConfig,
  type SpaceKind,
} from "@/lib/space-features";

export interface ResolvedSpaceFeatures {
  /** Owning project root (master), not a variant path. */
  ownerRoot: string | null;
  /** Assigned space, if the project belongs to one. */
  space: Space | null;
  kind: SpaceKind;
  config: SpaceFeatureConfig;
}

/**
 * Resolve the active project's space kind and feature config. Uses the
 * assigned space when present; otherwise infers from the project folder name.
 */
export function useSpaceFeatures(): ResolvedSpaceFeatures {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const spaceForProject = useSpacesStore((s) => s.spaceForProject);

  const resolved = useMemo(() => {
    const ownerRoot = projectRoot ? deriveOwner(projectRoot).owner : null;
    const space = ownerRoot ? spaceForProject(ownerRoot) : null;

    const kind = space
      ? inferSpaceKind(space)
      : ownerRoot
        ? inferSpaceKindFromProjectPath(ownerRoot)
        : "general";

    const config = space
      ? spaceFeatureConfig(space)
      : ownerRoot
        ? spaceFeatureConfig({
            name: ownerRoot.split(/[\\/]/).pop() ?? ownerRoot,
            description: "",
            icon: null,
            kind,
          })
        : spaceFeatureConfig(null);

    return { ownerRoot, space, kind, config };
  }, [projectRoot, spaceForProject]);

  const lastKindRef = useRef<string | null>(null);

  useEffect(() => {
    if (!resolved.ownerRoot) return;
    if (lastKindRef.current === resolved.kind) return;
    lastKindRef.current = resolved.kind;
    recordPersonalizationEvent("space_active", { kind: resolved.kind });
  }, [resolved.ownerRoot, resolved.kind]);

  return resolved;
}
