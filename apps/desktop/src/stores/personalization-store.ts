import { create } from "zustand";
import { persist } from "zustand/middleware";
import { aiComplete, canUseAiAssist } from "@/lib/ai-assist";
import {
  clearBehavioralPersonalization,
  scheduleIdentityProfileSync,
  syncPersonalizationEnabled,
} from "@/lib/personalization";
import { ClaudeStreamMessage, messageContentText } from "./claude-chat-store";

export interface UserProfile {
  name: string;
  role: string;
  affiliation: string;
  writingStyle: string;
  researchInterests: string[];
  customInstructions: string;
}

interface PersonalizationState {
  personalizationEnabled: boolean;
  autoExtractEnabled: boolean;
  profile: UserProfile;
  favoriteDocumentClasses: Record<string, number>;
  recentTopics: string[];
  lastAnalyzedFile: string | null;
  lastAnalyzedContentHash: string | null;

  setPersonalizationEnabled: (enabled: boolean) => void;
  setAutoExtractEnabled: (enabled: boolean) => void;
  updateProfile: (updates: Partial<UserProfile>) => void;
  addResearchInterest: (interest: string) => void;
  removeResearchInterest: (interest: string) => void;
  incrementDocumentClass: (docClass: string) => void;
  
  analyzeLaTeXContent: (filePath: string, content: string) => void;
  analyzeChatConversation: (messages: ClaudeStreamMessage[]) => Promise<void>;
  triggerAiRefinement: (text: string, contextDescription: string) => Promise<void>;
  resetProfile: () => void;
}

function cleanLatexText(text: string): string {
  return text
    .replace(/%.*$/gm, "") // remove comments
    .replace(/\\thanks\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "") // remove thanks
    .replace(/\\inst\{[^{}]*\}/g, "") // remove institute markers
    .replace(/\\fnref\{[^{}]*\}/g, "")
    .replace(/\\corref\{[^{}]*\}/g, "")
    .replace(/\\and/g, ",") // convert \and to comma
    .replace(/\\\\/g, " ") // replace newlines
    .replace(/\s+/g, " ") // collapse spaces
    .trim();
}

function extractFirstMatch(content: string, regexes: RegExp[]): string | null {
  for (const regex of regexes) {
    const match = content.match(regex);
    if (match && match[1]) {
      const clean = cleanLatexText(match[1]);
      if (clean && clean.length > 1 && clean.length < 120) {
        return clean;
      }
    }
  }
  return null;
}

function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

// Vocab of common research disciplines to match against title words/abstract
const RESEARCH_DISCIPLINES = [
  "Quantum Computing", "Quantum Physics", "Quantum Mechanics", "Astrobiology", "Astrophysics", 
  "Cosmology", "String Theory", "Particle Physics", "Condensed Matter", "Plasma Physics", 
  "Optics", "Photonics", "Nanotechnology", "Materials Science", "Biophysics",
  "Machine Learning", "Deep Learning", "Artificial Intelligence", "Neural Networks", 
  "Computer Vision", "Natural Language Processing", "Robotics", "Human-Computer Interaction", 
  "Bioinformatics", "Data Science", "Cryptography", "Distributed Systems", "Software Engineering", 
  "Cloud Computing", "Biochemistry", "Molecular Biology", "Genetics", "Neuroscience", 
  "Immunology", "Microbiology", "Ecology", "Evolutionary Biology", "Oncology", "Pharmacology", 
  "Virology", "Organic Chemistry", "Inorganic Chemistry", "Physical Chemistry", "Analytical Chemistry", 
  "Polymer Chemistry", "Pure Mathematics", "Applied Mathematics", "Statistics", "Topology", 
  "Algebra", "Geometry", "Probability", "Number Theory", "Economics", "Macroeconomics", 
  "Microeconomics", "Behavioral Economics", "Finance", "Econometrics", "Cognitive Science", 
  "Psychology", "Sociology", "Anthropology", "Linguistics", "Political Science", "Geology", 
  "Geophysics", "Meteorology", "Oceanography", "Climate Science", "Environmental Science"
];

export const usePersonalizationStore = create<PersonalizationState>()(
  persist(
    (set, get) => ({
      personalizationEnabled: true,
      autoExtractEnabled: true,
      profile: {
        name: "",
        role: "",
        affiliation: "",
        writingStyle: "",
        researchInterests: [],
        customInstructions: "",
      },
      favoriteDocumentClasses: {},
      recentTopics: [],
      lastAnalyzedFile: null,
      lastAnalyzedContentHash: null,

      setPersonalizationEnabled: (enabled) => {
        set({ personalizationEnabled: enabled });
        void syncPersonalizationEnabled(enabled);
      },
      setAutoExtractEnabled: (enabled) => set({ autoExtractEnabled: enabled }),
      
      updateProfile: (updates) =>
        set((state) => {
          const profile = { ...state.profile, ...updates };
          scheduleIdentityProfileSync(profile);
          return { profile };
        }),

      addResearchInterest: (interest) =>
        set((state) => {
          const clean = interest.trim();
          if (!clean || state.profile.researchInterests.includes(clean)) return {};
          const profile = {
            ...state.profile,
            researchInterests: [...state.profile.researchInterests, clean],
          };
          scheduleIdentityProfileSync(profile);
          return { profile };
        }),

      removeResearchInterest: (interest) =>
        set((state) => {
          const profile = {
            ...state.profile,
            researchInterests: state.profile.researchInterests.filter(
              (x) => x !== interest,
            ),
          };
          scheduleIdentityProfileSync(profile);
          return { profile };
        }),

      incrementDocumentClass: (docClass) =>
        set((state) => {
          const cls = docClass.trim().toLowerCase();
          if (!cls) return {};
          const favoriteDocumentClasses = { ...state.favoriteDocumentClasses };
          favoriteDocumentClasses[cls] = (favoriteDocumentClasses[cls] ?? 0) + 1;
          return { favoriteDocumentClasses };
        }),

      resetProfile: () => {
        void clearBehavioralPersonalization();
        set({
          profile: {
            name: "",
            role: "",
            affiliation: "",
            writingStyle: "",
            researchInterests: [],
            customInstructions: "",
          },
          favoriteDocumentClasses: {},
          recentTopics: [],
          lastAnalyzedFile: null,
          lastAnalyzedContentHash: null,
        });
      },

      analyzeLaTeXContent: (filePath, content) => {
        const state = get();
        if (!state.autoExtractEnabled) return;

        const hash = simpleHash(content);
        if (state.lastAnalyzedFile === filePath && state.lastAnalyzedContentHash === hash) {
          return; // Skip if already analyzed
        }

        // 1. Document class
        const docClass = extractFirstMatch(content, [/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/]);
        if (docClass) {
          state.incrementDocumentClass(docClass);
        }

        // 2. Author info
        const author = extractFirstMatch(content, [
          /\\author(?:\[[^\]]*\])?\{([^}]+)\}/
        ]);

        // 3. Affiliation
        const affiliation = extractFirstMatch(content, [
          /\\institute(?:\[[^\]]*\])?\{([^}]+)\}/,
          /\\institution(?:\[[^\]]*\])?\{([^}]+)\}/,
          /\\affil(?:\[[^\]]*\])?\{([^}]+)\}/,
          /\\address(?:\[[^\]]*\])?\{([^}]+)\}/
        ]);

        const profileUpdates: Partial<UserProfile> = {};
        if (author && !state.profile.name) {
          profileUpdates.name = author;
        }
        if (affiliation && !state.profile.affiliation) {
          profileUpdates.affiliation = affiliation;
        }

        // 4. Research interests from title
        const title = extractFirstMatch(content, [/\\title(?:\[[^\]]*\])?\{([^}]+)\}/]);
        const matchedTopics: string[] = [];
        if (title) {
          const lowerTitle = title.toLowerCase();
          for (const field of RESEARCH_DISCIPLINES) {
            if (lowerTitle.includes(field.toLowerCase())) {
              matchedTopics.push(field);
            }
          }
        }

        // Update profile
        if (Object.keys(profileUpdates).length > 0 || matchedTopics.length > 0) {
          set((s) => {
            const newInterests = [...s.profile.researchInterests];
            for (const topic of matchedTopics) {
              if (!newInterests.includes(topic)) {
                newInterests.push(topic);
              }
            }
              return {
                profile: {
                  ...s.profile,
                  ...profileUpdates,
                  researchInterests: newInterests,
                },
                lastAnalyzedFile: filePath,
                lastAnalyzedContentHash: hash,
              };
            });
            scheduleIdentityProfileSync(get().profile);
        } else {
          set({
            lastAnalyzedFile: filePath,
            lastAnalyzedContentHash: hash,
          });
        }

        // Trigger asynchronous deep refinement using local AI if appropriate
        if (canUseAiAssist()) {
          void state.triggerAiRefinement(
            content.slice(0, 15000), 
            `LaTeX document (${filePath})`
          );
        }
      },

      analyzeChatConversation: async (messages) => {
        const state = get();
        if (!state.autoExtractEnabled) return;

        // Combine recent messages
        const textParts: string[] = [];
        for (const msg of messages.slice(-6)) {
          const contentText = messageContentText(msg);
          if (contentText) {
            textParts.push(`${msg.type === "user" ? "User" : "Assistant"}: ${contentText}`);
          }
        }
        const text = textParts.join("\n");
        if (!text.trim() || text.length < 50) return;

        // Perform simple regex heuristic scan for identity
        const nameMatches = text.match(/my name is ([a-zA-Z\s]{2,30})/i);
        const univMatches = text.match(/(?:at|from)\s+([a-zA-Z\s]{4,40}\s+university|mit|stanford|harvard|caltech|oxford|cambridge)/i);
        const roleMatches = text.match(/(phd candidate|phd student|postdoc|professor|researcher|undergraduate|student)/i);

        const profileUpdates: Partial<UserProfile> = {};
        if (nameMatches && nameMatches[1] && !state.profile.name) {
          const rawName = nameMatches[1].trim();
          const stopWords = /\b(and|i|am|a|an|the|is|at|from|who|im|i'm)\b/i;
          const parts = rawName.split(stopWords);
          const cleanedName = parts[0].trim();
          if (cleanedName) {
            profileUpdates.name = cleanedName;
          }
        }
        if (univMatches && univMatches[1] && !state.profile.affiliation) {
          profileUpdates.affiliation = univMatches[1].trim();
        }
        if (roleMatches && roleMatches[1] && !state.profile.role) {
          profileUpdates.role = roleMatches[1].trim();
        }

        if (Object.keys(profileUpdates).length > 0) {
          set((s) => ({
            profile: { ...s.profile, ...profileUpdates },
          }));
          scheduleIdentityProfileSync(get().profile);
        }

        // Trigger asynchronous deep refinement using local AI if appropriate
        if (canUseAiAssist() && messages.length >= 2) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.type === "assistant") {
            void state.triggerAiRefinement(text, "Chat interaction");
          }
        }
      },

      triggerAiRefinement: async (text, contextDescription) => {
        try {
          const currentProfile = get().profile;
          
          const systemPrompt = 
            "You are a quiet background profiling system. Your job is to extract user facts from text to help customize their LaTeX workspace.\n" +
            "Given text from a " + contextDescription + ", extract or refine details about the user.\n" +
            "You must return a JSON object with the following fields:\n" +
            '{"name": string, "role": string, "affiliation": string, "writingStyle": string, "researchInterests": string[]}\n' +
            "Follow these strict guidelines:\n" +
            "1. ONLY extract information that is explicitly stated or strongly implied.\n" +
            "2. If a detail is missing or cannot be inferred, return null or empty string for that field.\n" +
            "3. Do NOT invent details.\n" +
            "4. For 'writingStyle', summarize in 3-6 words if visible (e.g. 'Precise academic', 'Active voice, simple sentences').\n" +
            "5. Return ONLY valid JSON. No explanations, no markdown fences.";

          const rawResponse = await aiComplete({
            system: systemPrompt,
            prompt: `Current profile: ${JSON.stringify(currentProfile)}\n\nText to analyze:\n${text}`,
            temperature: 0.1,
            format: "json",
          });

          // Parse JSON response
          let parsed: any = null;
          try {
            parsed = JSON.parse(rawResponse.trim());
          } catch {
            const match = rawResponse.match(/\{[\s\S]*\}/);
            if (match) {
              parsed = JSON.parse(match[0]);
            }
          }

          if (parsed && typeof parsed === "object") {
            set((state) => {
              const updates: Partial<UserProfile> = {};
              
              if (parsed.name && typeof parsed.name === "string" && !state.profile.name) {
                updates.name = parsed.name.trim();
              }
              if (parsed.role && typeof parsed.role === "string" && !state.profile.role) {
                updates.role = parsed.role.trim();
              }
              if (parsed.affiliation && typeof parsed.affiliation === "string" && !state.profile.affiliation) {
                updates.affiliation = parsed.affiliation.trim();
              }
              if (parsed.writingStyle && typeof parsed.writingStyle === "string" && !state.profile.writingStyle) {
                updates.writingStyle = parsed.writingStyle.trim();
              }
              
              let researchInterests = [...state.profile.researchInterests];
              if (Array.isArray(parsed.researchInterests)) {
                for (const item of parsed.researchInterests) {
                  if (typeof item === "string" && item.trim()) {
                    const cleanItem = item.trim();
                    if (!researchInterests.includes(cleanItem)) {
                      researchInterests.push(cleanItem);
                    }
                  }
                }
              }

              return {
                profile: {
                  ...state.profile,
                  ...updates,
                  researchInterests,
                },
              };
            });
            scheduleIdentityProfileSync(get().profile);
          }
        } catch (e) {
          // Fail silently in background
          console.debug("Personalization background refinement failed:", e);
        }
      },
    }),
    {
      name: "claude-prism-personalization",
      onRehydrateStorage: () => (state) => {
        if (state?.profile) scheduleIdentityProfileSync(state.profile);
      },
    },
  )
);

export function buildPersonalizationContext(): string {
  const store = usePersonalizationStore.getState();
  if (!store.personalizationEnabled) return "";
  
  const { profile } = store;
  const parts: string[] = [];
  
  if (profile.name) parts.push(`Name: ${profile.name}`);
  if (profile.role) parts.push(`Role: ${profile.role}`);
  if (profile.affiliation) parts.push(`Affiliation: ${profile.affiliation}`);
  if (profile.writingStyle) parts.push(`Writing Style: ${profile.writingStyle}`);
  if (profile.researchInterests && profile.researchInterests.length > 0) {
    parts.push(`Research Interests: ${profile.researchInterests.join(", ")}`);
  }
  if (profile.customInstructions) {
    parts.push(`Instructions: ${profile.customInstructions}`);
  }

  const topDocClasses = Object.entries(store.favoriteDocumentClasses)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cls]) => cls);
  if (topDocClasses.length > 0) {
    parts.push(`Preferred document classes: ${topDocClasses.join(", ")}`);
  }
  
  if (parts.length === 0) return "";
  
  return [
    "## USER PROFILE (Local on-device personalization)",
    "Adopt these settings and details automatically for this user when writing papers, abstracts, biographies, emails, or compiling document authorship block details. Keep tone natural. A separate behavioral adaptation layer also tunes depth and suggestions from on-device usage — follow both.",
    ...parts.map(p => `- ${p}`),
    ""
  ].join("\n");
}
