import { InlineBanner } from "@/components/ui/inline-banner";
import { useWorkspaceBannerStore } from "@/stores/workspace-banner-store";

export function WorkspaceBannerBar() {
  const banners = useWorkspaceBannerStore((s) => s.banners);
  const dismiss = useWorkspaceBannerStore((s) => s.dismiss);

  if (banners.length === 0) return null;

  return (
    <div className="shrink-0 border-border/60 border-b bg-background">
      {banners.map((banner) => (
        <InlineBanner
          key={banner.id}
          kind={banner.kind}
          title={banner.title}
          message={banner.message}
          actionLabel={banner.actionLabel}
          onAction={banner.onAction}
          secondaryActionLabel={banner.secondaryActionLabel}
          onSecondaryAction={banner.onSecondaryAction}
          onDismiss={() => dismiss(banner.id)}
        />
      ))}
    </div>
  );
}
