import React, { useEffect, useMemo, useState } from "react";
import { usePersonalizationStore } from "@/stores/personalization-store";
import {
  getBehavioralProfile,
  describeLearnedStyle,
  type BehavioralProfile,
} from "@/lib/personalization";
import {
  UserIcon,
  GraduationCapIcon,
  Building2Icon,
  PenToolIcon,
  PlusIcon,
  XIcon,
  RefreshCwIcon,
  ActivityIcon,
  SparklesIcon,
} from "lucide-react";
import { SettingsCollapsibleSection } from "@/components/settings-collapsible-section";
import { SettingsToggleRow } from "@/components/settings-toggle-row";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function PersonalizationSettings({
  searchQuery = "",
}: {
  searchQuery?: string;
}) {
  const {
    personalizationEnabled,
    autoExtractEnabled,
    profile,
    favoriteDocumentClasses,
    setPersonalizationEnabled,
    setAutoExtractEnabled,
    updateProfile,
    addResearchInterest,
    removeResearchInterest,
    resetProfile,
  } = usePersonalizationStore();

  const [newInterest, setNewInterest] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [behavioral, setBehavioral] = useState<BehavioralProfile | null>(null);
  const [openSections, setOpenSections] = useState({
    general: true,
    identity: true,
    interests: false,
    insights: false,
    data: false,
  });

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  useEffect(() => {
    if (!personalizationEnabled) {
      setBehavioral(null);
      return;
    }
    void getBehavioralProfile()
      .then(setBehavioral)
      .catch(() => setBehavioral(null));
  }, [
    personalizationEnabled,
    profile.name,
    profile.role,
    favoriteDocumentClasses,
  ]);

  const learnedStyle = behavioral ? describeLearnedStyle(behavioral) : [];
  const behavioralDocClasses = behavioral
    ? Object.entries(behavioral.favoriteDocumentClasses)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
    : [];
  const topSpaceKinds = behavioral
    ? Object.entries(behavioral.spaceKinds)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
    : [];
  const recentTopics = behavioral?.recentTopics.slice(-6).reverse() ?? [];

  const handleAddInterest = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newInterest.trim();
    if (trimmed) {
      addResearchInterest(trimmed);
      setNewInterest("");
    }
  };

  const hasFavoriteClasses = Object.keys(favoriteDocumentClasses).length > 0;

  const q = searchQuery.trim().toLowerCase();
  const sectionMatches = (keywords: string) =>
    !q || keywords.toLowerCase().includes(q);

  const showToggles = sectionMatches(
    "enable personalization automatic profiling on-device",
  );
  const showIdentity = sectionMatches(
    "identity name role affiliation writing style custom instructions profile background",
  );
  const showInterests = sectionMatches(
    "research interests fields topics graduation",
  );
  const showLearned = sectionMatches(
    "learned adaptation behavioral interaction style topics",
  );
  const showDocClasses = sectionMatches(
    "document classes latex compile habits",
  );
  const showActions = sectionMatches("clear profile reset on-device data");

  const visibleSectionCount = [
    showToggles,
    showIdentity,
    showInterests,
    showLearned,
    showDocClasses,
    showActions,
  ].filter(Boolean).length;

  const enabledToggleCount =
    (personalizationEnabled ? 1 : 0) + (autoExtractEnabled ? 1 : 0);

  const expandedSections = useMemo(() => {
    if (!q) return openSections;
    return {
      general: showToggles,
      identity: showIdentity,
      interests: showInterests,
      insights: showLearned || showDocClasses,
      data: showActions,
    };
  }, [
    q,
    openSections,
    showToggles,
    showIdentity,
    showInterests,
    showLearned,
    showDocClasses,
    showActions,
  ]);

  return (
    <div className="flex flex-col">
      {visibleSectionCount === 0 && (
        <p className="p-4 text-muted-foreground text-sm">
          No personalization settings match your search.
        </p>
      )}
      {/* Toggles section */}
      {showToggles && (
        <SettingsCollapsibleSection
          id="personalization-general"
          icon={SparklesIcon}
          title="General"
          description="Enable on-device personalization and automatic profiling"
          badge={`${enabledToggleCount}/2`}
          open={expandedSections.general}
          onToggle={() => toggleSection("general")}
          panelContentClassName="divide-y divide-border/40"
        >
          <SettingsToggleRow
            checked={personalizationEnabled}
            onChange={setPersonalizationEnabled}
            title="Enable On-Device Personalization"
            description="Injects your profile and preferences automatically into system instructions for both local Ollama models and Claude Code, adapting answers to your role, affiliation, and style."
          />
          <SettingsToggleRow
            checked={autoExtractEnabled}
            disabled={!personalizationEnabled}
            onChange={setAutoExtractEnabled}
            title="Automatic Profiling"
            description="Automatically extracts and refines your profile (such as name, affiliation, and research interests) in the background by analyzing your LaTeX files and chat interactions."
          />
        </SettingsCollapsibleSection>
      )}

      {/* Profile Form */}
      {showIdentity && (
        <SettingsCollapsibleSection
          id="personalization-identity"
          icon={UserIcon}
          title="Identity & background"
          description="Name, role, affiliation, and writing style"
          open={expandedSections.identity}
          onToggle={() => toggleSection("identity")}
          disabled={!personalizationEnabled}
        >
          <div
            className={`space-y-4 px-4 py-3 transition-opacity duration-200 ${
              !personalizationEnabled ? "pointer-events-none opacity-40" : ""
            }`}
          >
            <h3 className="sr-only">Identity & Background</h3>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="user-name-input"
                  className="flex items-center gap-1 font-medium text-muted-foreground text-xs"
                >
                  Name
                </label>
                <div className="relative">
                  <Input
                    id="user-name-input"
                    type="text"
                    className="bg-background/50"
                    placeholder="e.g. John Doe (Auto-detected if in \author{})"
                    value={profile.name}
                    onChange={(e) => updateProfile({ name: e.target.value })}
                    disabled={!personalizationEnabled}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="user-role-input"
                  className="flex items-center gap-1 font-medium text-muted-foreground text-xs"
                >
                  Role
                </label>
                <Input
                  id="user-role-input"
                  type="text"
                  className="bg-background/50"
                  placeholder="e.g. PhD Candidate, Researcher"
                  value={profile.role}
                  onChange={(e) => updateProfile({ role: e.target.value })}
                  disabled={!personalizationEnabled}
                />
              </div>

              <div className="space-y-1 md:col-span-2">
                <label
                  htmlFor="user-affiliation-input"
                  className="flex items-center gap-1 font-medium text-muted-foreground text-xs"
                >
                  Affiliation
                </label>
                <div className="relative">
                  <Building2Icon className="absolute top-2.5 left-3 z-10 size-4 text-muted-foreground/60" />
                  <Input
                    id="user-affiliation-input"
                    type="text"
                    className="bg-background/50 pl-9"
                    placeholder="e.g. Stanford University (Auto-detected if in \institute{})"
                    value={profile.affiliation}
                    onChange={(e) =>
                      updateProfile({ affiliation: e.target.value })
                    }
                    disabled={!personalizationEnabled}
                  />
                </div>
              </div>
            </div>

            <div className="mt-2 space-y-1">
              <label
                htmlFor="user-style-input"
                className="flex items-center gap-1 font-medium text-muted-foreground text-xs"
              >
                Writing Style Preference
              </label>
              <div className="relative">
                <PenToolIcon className="absolute top-2.5 left-3 z-10 size-4 text-muted-foreground/60" />
                <Input
                  id="user-style-input"
                  type="text"
                  className="bg-background/50 pl-9"
                  placeholder="e.g. Formal academic, active voice, concise"
                  value={profile.writingStyle}
                  onChange={(e) =>
                    updateProfile({ writingStyle: e.target.value })
                  }
                  disabled={!personalizationEnabled}
                />
              </div>
              <p className="mt-0.5 pl-1 text-[10px] text-muted-foreground/80">
                The assistant will prioritize this tone/style when writing or
                editing.
              </p>
            </div>

            <div className="mt-2 space-y-1">
              <label
                htmlFor="user-instructions-input"
                className="flex items-center gap-1 font-medium text-muted-foreground text-xs"
              >
                Custom Prompts & Instructions
              </label>
              <Textarea
                id="user-instructions-input"
                className="resize-none bg-background/50"
                placeholder="e.g. Always write in American English. Use passive voice in methods but active voice in introductions."
                value={profile.customInstructions}
                onChange={(e) =>
                  updateProfile({ customInstructions: e.target.value })
                }
                disabled={!personalizationEnabled}
              />
            </div>
          </div>
        </SettingsCollapsibleSection>
      )}

      {/* Research Interests (Tags) */}
      {showInterests && (
        <SettingsCollapsibleSection
          id="personalization-interests"
          icon={GraduationCapIcon}
          title="Research interests"
          description="Topics and fields that shape AI suggestions"
          badge={String(profile.researchInterests.length)}
          open={expandedSections.interests}
          onToggle={() => toggleSection("interests")}
          disabled={!personalizationEnabled}
        >
          <div
            className={`space-y-3 px-4 py-3 transition-opacity duration-200 ${
              !personalizationEnabled ? "pointer-events-none opacity-40" : ""
            }`}
          >
            <div className="flex min-h-[2rem] flex-wrap gap-1.5 rounded-md border border-border/40 bg-secondary/30 p-2">
              {profile.researchInterests.length === 0 ? (
                <span className="p-1 text-muted-foreground/60 text-xs italic">
                  No interests added yet. (Discovered automatically as you write
                  papers).
                </span>
              ) : (
                profile.researchInterests.map((interest) => (
                  <span
                    key={interest}
                    className="group inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 font-medium text-primary text-xs transition-colors hover:bg-primary/15"
                  >
                    {interest}
                    <button
                      type="button"
                      onClick={() => removeResearchInterest(interest)}
                      className="ml-0.5 cursor-pointer rounded-full p-0.5 text-primary/60 transition-all hover:bg-primary/20 hover:text-primary"
                      title={`Remove ${interest}`}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </span>
                ))
              )}
            </div>

            <div className="flex gap-2">
              <Input
                type="text"
                className="h-8 flex-1 bg-background/50 text-xs"
                placeholder="Add new research interest..."
                value={newInterest}
                onChange={(e) => setNewInterest(e.target.value)}
                disabled={!personalizationEnabled}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddInterest(e);
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                disabled={!personalizationEnabled || !newInterest.trim()}
                onClick={handleAddInterest}
              >
                <PlusIcon className="size-3.5" /> Add
              </Button>
            </div>
          </div>
        </SettingsCollapsibleSection>
      )}

      {(showLearned || showDocClasses) && (
        <SettingsCollapsibleSection
          id="personalization-insights"
          icon={ActivityIcon}
          title="Learned habits"
          description="Adaptation from your writing and compile patterns"
          open={expandedSections.insights}
          onToggle={() => toggleSection("insights")}
          disabled={!personalizationEnabled}
        >
          <div
            className={`space-y-4 px-4 py-3 transition-opacity duration-200 ${
              !personalizationEnabled ? "pointer-events-none opacity-40" : ""
            }`}
          >
            {showLearned && (
              <div className="space-y-3">
                {behavioral && behavioral.interactionCount >= 3 ? (
                  <div className="space-y-3">
                    {learnedStyle.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {learnedStyle.map((bit) => (
                          <span
                            key={bit}
                            className="rounded-full border border-border/50 bg-secondary/40 px-2.5 py-0.5 text-[11px] text-foreground"
                          >
                            {bit}
                          </span>
                        ))}
                      </div>
                    )}

                    {topSpaceKinds.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-muted-foreground text-xs">
                          Common project types:
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {topSpaceKinds.map(([kind, count]) => (
                            <span
                              key={kind}
                              className="rounded bg-muted/60 px-2 py-0.5 font-mono text-[11px]"
                            >
                              {kind} ({count})
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {recentTopics.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-muted-foreground text-xs">
                          Recent interests:
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {recentTopics.map((topic) => (
                            <span
                              key={topic}
                              className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-[11px] text-primary"
                            >
                              {topic}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <p className="text-[10px] text-muted-foreground/70">
                      Based on {behavioral.interactionCount} on-device
                      interactions. This shapes AI tone, depth, and suggestions
                      automatically.
                    </p>
                  </div>
                ) : (
                  <p className="text-muted-foreground/60 text-xs italic">
                    Keep using chat, suggestions, and compilations — DevPrism
                    will learn your preferences after a few interactions.
                  </p>
                )}
              </div>
            )}

            {showDocClasses && (
              <div className="space-y-3 border-border/40 border-t pt-4">
                <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
                  Document classes
                </h4>

                {hasFavoriteClasses || behavioralDocClasses.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-muted-foreground text-xs">
                      Most compiled LaTeX document classes:
                    </p>
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                      {(behavioralDocClasses.length > 0
                        ? behavioralDocClasses
                        : Object.entries(favoriteDocumentClasses)
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 6)
                      ).map(([cls, count]) => (
                        <div
                          key={cls}
                          className="flex items-center justify-between rounded border border-border/30 bg-secondary/40 px-3 py-1.5 text-xs"
                        >
                          <span className="font-mono text-foreground">
                            {cls}
                          </span>
                          <span className="rounded-full bg-muted px-1.5 py-0.5 font-semibold text-[10px] text-muted-foreground">
                            {count} compile{count > 1 ? "s" : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground/60 text-xs italic">
                    Habits are tracked automatically when you run document
                    compilations.
                  </p>
                )}
              </div>
            )}
          </div>
        </SettingsCollapsibleSection>
      )}

      {/* Actions */}
      {showActions && (
        <SettingsCollapsibleSection
          id="personalization-data"
          icon={RefreshCwIcon}
          title="Data & reset"
          description="Clear on-device profile data"
          open={expandedSections.data}
          onToggle={() => toggleSection("data")}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <SparklesIcon className="size-3 animate-pulse text-primary" /> All
              profile data remains on-device.
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmClear(true)}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCwIcon className="size-3.5" /> Clear Profile
            </Button>
          </div>
          <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Clear profile data?</DialogTitle>
                <DialogDescription>
                  This permanently removes your on-device personalization
                  profile, including your identity, research interests, and
                  learned habits. This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmClear(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    resetProfile();
                    setConfirmClear(false);
                  }}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <RefreshCwIcon className="size-3.5" /> Clear Profile
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </SettingsCollapsibleSection>
      )}
    </div>
  );
}
