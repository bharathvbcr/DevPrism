import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeftIcon,
  DatabaseIcon,
  SparklesIcon,
  BookOpenIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InlineBanner } from "@/components/ui/inline-banner";
import { Skeleton } from "@/components/ui/skeleton";
import { useCareerStore, type CareerTab } from "@/stores/career-store";
import { isTauri } from "@/lib/runtime/is-tauri";
import { CareerDatabaseTab } from "./career-database-tab";
import { CareerKnowledgeTab } from "./career-knowledge-tab";
import { CareerSynthesizeTab } from "./career-synthesize-tab";

export function CareerView() {
  const activeTab = useCareerStore((s) => s.activeTab);
  const setActiveTab = useCareerStore((s) => s.setActiveTab);
  const closeCareer = useCareerStore((s) => s.closeCareer);
  const loadAll = useCareerStore((s) => s.loadAll);
  const loading = useCareerStore((s) => s.loading);
  const blocks = useCareerStore((s) => s.blocks);
  const error = useCareerStore((s) => s.error);

  useEffect(() => {
    if (!isTauri()) return;
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (isTauri()) {
      void getCurrentWindow().setTitle("Career - DevPrism");
    } else {
      document.title = "Career - DevPrism";
    }
  }, []);

  if (!isTauri()) {
    return (
      <div className="flex h-full flex-col bg-background text-foreground">
        <CareerHeader onBack={closeCareer} />
        <div className="mx-auto max-w-lg p-8">
          <InlineBanner
            kind="info"
            title="Desktop required"
            message="The Career database uses local SQLite and is only available in the DevPrism desktop app."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <CareerHeader onBack={closeCareer} />
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-5">
        {error && (
          <InlineBanner
            className="mb-3"
            kind="error"
            title="Career database error"
            message={error}
          />
        )}
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as CareerTab)}
          className="flex min-h-0 flex-1 flex-col gap-3"
        >
          <TabsList className="w-fit shrink-0">
            <TabsTrigger value="database" className="gap-1.5">
              <DatabaseIcon className="size-3.5" />
              Database
            </TabsTrigger>
            <TabsTrigger value="knowledge" className="gap-1.5">
              <BookOpenIcon className="size-3.5" />
              Knowledge
            </TabsTrigger>
            <TabsTrigger value="synthesize" className="gap-1.5">
              <SparklesIcon className="size-3.5" />
              Synthesize
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="database"
            className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
          >
            {loading && blocks.length === 0 ? (
              <div className="space-y-3 p-2">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : (
              <CareerDatabaseTab />
            )}
          </TabsContent>
          <TabsContent
            value="knowledge"
            className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
          >
            <CareerKnowledgeTab />
          </TabsContent>
          <TabsContent
            value="synthesize"
            className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
          >
            <CareerSynthesizeTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function CareerHeader({ onBack }: { onBack: () => void }) {
  return (
    <header className="flex h-[calc(48px+var(--titlebar-height))] shrink-0 items-center gap-3 border-border/70 border-b px-5 pt-[var(--titlebar-height)]">
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-muted-foreground"
        onClick={onBack}
      >
        <ArrowLeftIcon className="size-3.5" />
        Projects
      </Button>
      <h1 className="font-semibold text-lg leading-none">Career</h1>
      <span className="text-muted-foreground text-xs">
        Master experience database
      </span>
    </header>
  );
}
