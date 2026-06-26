import React, { useEffect, useState } from "react";
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

export function PersonalizationSettings() {
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
  const [behavioral, setBehavioral] = useState<BehavioralProfile | null>(null);

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

  return (
    <div className="flex flex-col divide-y divide-border/40">
      {/* Toggles section */}
      <div className="p-4 space-y-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-primary rounded border-border"
            checked={personalizationEnabled}
            onChange={(e) => setPersonalizationEnabled(e.target.checked)}
          />
          <div className="min-w-0">
            <div className="font-medium text-sm text-foreground">
              Enable On-Device Personalization
            </div>
            <p className="mt-0.5 text-muted-foreground text-xs">
              Injects your profile and preferences automatically into system instructions for both local Ollama models and Claude Code, adapting answers to your role, affiliation, and style.
            </p>
          </div>
        </label>

        <label
          className={`flex cursor-pointer items-start gap-3 transition-opacity duration-200 ${
            !personalizationEnabled ? "pointer-events-none opacity-50" : ""
          }`}
        >
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-primary rounded border-border"
            checked={autoExtractEnabled}
            disabled={!personalizationEnabled}
            onChange={(e) => setAutoExtractEnabled(e.target.checked)}
          />
          <div className="min-w-0">
            <div className="font-medium text-sm text-foreground">
              Automatic Profiling
            </div>
            <p className="mt-0.5 text-muted-foreground text-xs">
              Automatically extracts and refines your profile (such as name, affiliation, and research interests) in the background by analyzing your LaTeX files and chat interactions.
            </p>
          </div>
        </label>
      </div>

      {/* Profile Form */}
      <div
        className={`p-4 space-y-4 transition-opacity duration-200 ${
          !personalizationEnabled ? "pointer-events-none opacity-40" : ""
        }`}
      >
        <h3 className="font-medium text-xs uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
          <UserIcon className="size-3.5" /> Identity & Background
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label htmlFor="user-name-input" className="text-xs text-muted-foreground font-medium flex items-center gap-1">
              Name
            </label>
            <div className="relative">
              <input
                id="user-name-input"
                type="text"
                className="w-full rounded-md border border-input bg-background/50 px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring transition-colors"
                placeholder="e.g. John Doe (Auto-detected if in \author{})"
                value={profile.name}
                onChange={(e) => updateProfile({ name: e.target.value })}
                disabled={!personalizationEnabled}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="user-role-input" className="text-xs text-muted-foreground font-medium flex items-center gap-1">
              Role
            </label>
            <input
              id="user-role-input"
              type="text"
              className="w-full rounded-md border border-input bg-background/50 px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring transition-colors"
              placeholder="e.g. PhD Candidate, Researcher"
              value={profile.role}
              onChange={(e) => updateProfile({ role: e.target.value })}
              disabled={!personalizationEnabled}
            />
          </div>

          <div className="space-y-1 md:col-span-2">
            <label htmlFor="user-affiliation-input" className="text-xs text-muted-foreground font-medium flex items-center gap-1">
              Affiliation
            </label>
            <div className="relative">
              <Building2Icon className="absolute left-3 top-2.5 size-4 text-muted-foreground/60" />
              <input
                id="user-affiliation-input"
                type="text"
                className="w-full rounded-md border border-input bg-background/50 pl-9 pr-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring transition-colors"
                placeholder="e.g. Stanford University (Auto-detected if in \institute{})"
                value={profile.affiliation}
                onChange={(e) => updateProfile({ affiliation: e.target.value })}
                disabled={!personalizationEnabled}
              />
            </div>
          </div>
        </div>

        <div className="space-y-1 mt-2">
          <label htmlFor="user-style-input" className="text-xs text-muted-foreground font-medium flex items-center gap-1">
            Writing Style Preference
          </label>
          <div className="relative">
            <PenToolIcon className="absolute left-3 top-2.5 size-4 text-muted-foreground/60" />
            <input
              id="user-style-input"
              type="text"
              className="w-full rounded-md border border-input bg-background/50 pl-9 pr-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring transition-colors"
              placeholder="e.g. Formal academic, active voice, concise"
              value={profile.writingStyle}
              onChange={(e) => updateProfile({ writingStyle: e.target.value })}
              disabled={!personalizationEnabled}
            />
          </div>
          <p className="text-[10px] text-muted-foreground/80 mt-0.5 pl-1">
            The assistant will prioritize this tone/style when writing or editing.
          </p>
        </div>

        <div className="space-y-1 mt-2">
          <label htmlFor="user-instructions-input" className="text-xs text-muted-foreground font-medium flex items-center gap-1">
            Custom Prompts & Instructions
          </label>
          <textarea
            id="user-instructions-input"
            className="w-full min-h-16 rounded-md border border-input bg-background/50 px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring transition-colors resize-none"
            placeholder="e.g. Always write in American English. Use passive voice in methods but active voice in introductions."
            value={profile.customInstructions}
            onChange={(e) => updateProfile({ customInstructions: e.target.value })}
            disabled={!personalizationEnabled}
          />
        </div>
      </div>

      {/* Research Interests (Tags) */}
      <div
        className={`p-4 space-y-3 transition-opacity duration-200 ${
          !personalizationEnabled ? "pointer-events-none opacity-40" : ""
        }`}
      >
        <h3 className="font-medium text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <GraduationCapIcon className="size-3.5" /> Research Interests & Fields
        </h3>

        <div className="flex flex-wrap gap-1.5 min-h-[2rem] p-2 rounded-md bg-secondary/30 border border-border/40">
          {profile.researchInterests.length === 0 ? (
            <span className="text-xs text-muted-foreground/60 italic p-1">
              No interests added yet. (Discovered automatically as you write papers).
            </span>
          ) : (
            profile.researchInterests.map((interest) => (
              <span
                key={interest}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 border border-primary/20 text-primary px-2.5 py-0.5 text-xs font-medium group hover:bg-primary/15 transition-colors"
              >
                {interest}
                <button
                  type="button"
                  onClick={() => removeResearchInterest(interest)}
                  className="rounded-full text-primary/60 hover:text-primary hover:bg-primary/20 transition-all p-0.5 ml-0.5 cursor-pointer"
                  title={`Remove ${interest}`}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ))
          )}
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            className="flex-1 rounded-md border border-input bg-background/50 px-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring transition-colors"
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
          <button
            type="button"
            className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/95 active:scale-95 transition-all shadow-sm cursor-pointer disabled:opacity-50"
            disabled={!personalizationEnabled || !newInterest.trim()}
            onClick={handleAddInterest}
          >
            <PlusIcon className="size-3.5" /> Add
          </button>
        </div>
      </div>

      {/* Automatically Tracked Statistics */}
      <div
        className={`p-4 space-y-3 transition-opacity duration-200 ${
          !personalizationEnabled ? "pointer-events-none opacity-40" : ""
        }`}
      >
        <h3 className="font-medium text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <ActivityIcon className="size-3.5" /> Learned Adaptation
        </h3>

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
                <p className="text-xs text-muted-foreground">
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
                <p className="text-xs text-muted-foreground">Recent interests:</p>
                <div className="flex flex-wrap gap-1.5">
                  {recentTopics.map((topic) => (
                    <span
                      key={topic}
                      className="rounded-full border border-primary/20 bg-primary/8 px-2.5 py-0.5 text-[11px] text-primary"
                    >
                      {topic}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <p className="text-[10px] text-muted-foreground/70">
              Based on {behavioral.interactionCount} on-device interactions.
              This shapes AI tone, depth, and suggestions automatically.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground/60 italic">
            Keep using chat, suggestions, and compilations — DevPrism will learn
            your preferences after a few interactions.
          </p>
        )}
      </div>

      {/* Document class habits */}
      <div
        className={`p-4 space-y-3 transition-opacity duration-200 ${
          !personalizationEnabled ? "pointer-events-none opacity-40" : ""
        }`}
      >
        <h3 className="font-medium text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <ActivityIcon className="size-3.5" /> Document Classes
        </h3>

        {hasFavoriteClasses || behavioralDocClasses.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Most compiled LaTeX document classes:
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {(behavioralDocClasses.length > 0
                ? behavioralDocClasses
                : Object.entries(favoriteDocumentClasses)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 6)
              ).map(([cls, count]) => (
                  <div
                    key={cls}
                    className="flex justify-between items-center rounded bg-secondary/40 border border-border/30 px-3 py-1.5 text-xs"
                  >
                    <span className="font-mono text-foreground">{cls}</span>
                    <span className="text-[10px] text-muted-foreground font-semibold bg-muted px-1.5 py-0.5 rounded-full">
                      {count} compile{count > 1 ? "s" : ""}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground/60 italic">
            Habits are tracked automatically when you run document compilations.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="p-4 flex justify-between items-center bg-secondary/10">
        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
          <SparklesIcon className="size-3 text-primary animate-pulse" /> All profile data remains on-device.
        </span>
        <button
          type="button"
          onClick={resetProfile}
          className="inline-flex items-center gap-1 text-xs text-destructive hover:bg-destructive/10 active:scale-95 border border-transparent hover:border-destructive/20 px-2.5 py-1.5 rounded transition-all cursor-pointer font-medium"
        >
          <RefreshCwIcon className="size-3.5" /> Clear Profile
        </button>
      </div>
    </div>
  );
}
