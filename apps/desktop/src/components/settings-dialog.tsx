import { type ReactNode, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  BotIcon,
  DownloadIcon,
  FolderIcon,
  KeyIcon,
  LinkIcon,
  PlusIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
  UserCircleIcon,
  WrenchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";
import { type AgentProvider, useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface ProviderHealth {
  ok: boolean;
  message: string;
  models: string[];
}

interface SlashCommand {
  id: string;
  name: string;
  scope: string;
  full_command: string;
  description?: string | null;
  content: string;
}

interface ProjectSummary {
  project_id: string;
  summary: string;
  updated_at: string;
}

interface ProjectObservation {
  project_id: string;
  file_path: string;
  summary: string;
  key_technologies: string[];
}

type Tab = "providers" | "general" | "knowledge" | "skills" | "security";

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 rounded-full border transition-colors",
        checked ? "border-primary bg-primary" : "border-input bg-muted",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-5 rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const {
    personalBio,
    setPersonalBio,
    resumeProfile,
    setResumeProfile,
    manualExperience,
    setManualExperience,
    evidenceEntries,
    setEvidenceEntries,
    redactSecrets,
    setRedactSecrets,
    safeMode,
    setSafeMode,
    agentProviderSettings,
    setAgentProviderSettings,
  } = useSettingsStore();
  const {
    linkedProjects,
    loadLinkedProjects,
    addLinkedProject,
    removeLinkedProject,
    analyzeLinkedProject,
  } = useProjectStore();
  const projectRoot = useDocumentStore((state) => state.projectRoot);

  const [activeTab, setActiveTab] = useState<Tab>("providers");
  const [bioInput, setBioInput] = useState(personalBio);
  const [resumeInput, setResumeInput] = useState(resumeProfile);
  const [experienceInput, setExperienceInput] = useState(manualExperience);
  const [evidenceInput, setEvidenceInput] = useState(evidenceEntries);
  const [authorizedPaths, setAuthorizedPaths] = useState<string[]>([]);
  const [health, setHealth] = useState<ProviderHealth | null>(null);
  const [skills, setSkills] = useState<SlashCommand[]>([]);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillContent, setSkillContent] = useState("");
  const [skillScope, setSkillScope] = useState<"global" | "project">("global");
  const [projectRole, setProjectRole] = useState("");
  const [projectTags, setProjectTags] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectSummaries, setProjectSummaries] = useState<ProjectSummary[]>(
    [],
  );
  const [projectObservations, setProjectObservations] = useState<
    ProjectObservation[]
  >([]);
  const [selectedEvidenceProjectId, setSelectedEvidenceProjectId] =
    useState<string>("");
  const [summaryInput, setSummaryInput] = useState("");

  useEffect(() => {
    if (!open) return;
    setBioInput(personalBio);
    setResumeInput(resumeProfile);
    setExperienceInput(manualExperience);
    setEvidenceInput(evidenceEntries);
    loadLinkedProjects();
    invoke<string[]>("list_authorized_paths")
      .then(setAuthorizedPaths)
      .catch(console.error);
    invoke<SlashCommand[]>("slash_commands_list", {
      projectPath: projectRoot ?? undefined,
    })
      .then((items) =>
        setSkills(items.filter((item) => item.scope === "skill")),
      )
      .catch(() => setSkills([]));
    invoke<ProjectSummary[]>("list_project_summaries")
      .then(setProjectSummaries)
      .catch(() => setProjectSummaries([]));
  }, [
    open,
    personalBio,
    resumeProfile,
    manualExperience,
    evidenceEntries,
    loadLinkedProjects,
    projectRoot,
  ]);

  const providerLabel = useMemo(() => {
    if (agentProviderSettings.provider === "gemini-api") return "Gemini API";
    if (agentProviderSettings.provider === "gemini-cli") return "Gemini CLI";
    if (agentProviderSettings.provider === "ollama") return "Ollama";
    return "Gemini CLI";
  }, [agentProviderSettings.provider]);

  const saveKnowledge = async () => {
    await setPersonalBio(bioInput);
    await setResumeProfile(resumeInput);
    await setManualExperience(experienceInput);
    await setEvidenceEntries(evidenceInput);
  };

  const handleProviderChange = async (provider: AgentProvider) => {
    await setAgentProviderSettings({
      provider,
      backendMode:
        provider === "gemini-api"
          ? "api"
          : provider === "gemini-cli"
            ? "cli"
            : "local",
      model:
        provider === "ollama"
          ? agentProviderSettings.ollamaModel
          : provider === "gemini-cli"
            ? agentProviderSettings.geminiCliModel || "gemini-1.5-pro"
            : agentProviderSettings.model,
    });
  };

  const checkProvider = async () => {
    if (agentProviderSettings.provider === "ollama") {
      const result = await invoke<ProviderHealth>("check_ollama_status", {
        baseUrl: agentProviderSettings.ollamaBaseUrl,
        model: agentProviderSettings.ollamaModel,
      });
      setHealth(result);
      if (
        result.models.length > 0 &&
        !result.models.includes(agentProviderSettings.ollamaModel)
      ) {
        await setAgentProviderSettings({ ollamaModel: result.models[0] });
      }
      return;
    }
    if (agentProviderSettings.provider === "gemini-cli") {
      setHealth(await invoke<ProviderHealth>("check_gemini_cli_status"));
      return;
    }
    if (agentProviderSettings.provider === "gemini-api") {
      setHealth(
        await invoke<ProviderHealth>("check_gemini_api_status", {
          apiKey: agentProviderSettings.geminiApiKey,
        }),
      );
      return;
    }
    setHealth({
      ok: false,
      message: "Select Gemini CLI, Gemini API, or Ollama.",
      models: [],
    });
  };

  const handleAddProject = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      const name = selected.split(/[/\\]/).pop() || selected;
      await addLinkedProject(name, selected, [], {
        tags: projectTags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        role: projectRole || null,
        description: projectDescription || null,
      });
      setProjectRole("");
      setProjectTags("");
      setProjectDescription("");
    }
  };

  useEffect(() => {
    if (!open) return;
    if (!selectedEvidenceProjectId && linkedProjects.length > 0) {
      setSelectedEvidenceProjectId(linkedProjects[0].id);
    }
  }, [open, linkedProjects, selectedEvidenceProjectId]);

  useEffect(() => {
    if (!selectedEvidenceProjectId) {
      setSummaryInput("");
      setProjectObservations([]);
      return;
    }
    const summary =
      projectSummaries.find(
        (item) => item.project_id === selectedEvidenceProjectId,
      )?.summary ?? "";
    setSummaryInput(summary);
    invoke<ProjectObservation[]>("list_project_observations", {
      projectId: selectedEvidenceProjectId,
    })
      .then(setProjectObservations)
      .catch(() => setProjectObservations([]));
  }, [selectedEvidenceProjectId, projectSummaries]);

  const saveSelectedProjectSummary = async () => {
    if (!selectedEvidenceProjectId) return;
    const saved = await invoke<ProjectSummary>("save_project_summary", {
      projectId: selectedEvidenceProjectId,
      summary: summaryInput,
    });
    setProjectSummaries((current) => [
      saved,
      ...current.filter((item) => item.project_id !== saved.project_id),
    ]);
  };

  const exportKnowledgebase = async () => {
    const selected = await saveDialog({
      defaultPath: "devcouncil-knowledgebase.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!selected) return;
    await invoke("export_knowledgebase", { path: selected });
  };

  const importKnowledgebase = async () => {
    const selected = await openDialog({
      directory: false,
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return;
    await invoke("import_knowledgebase", { path: selected });
    await loadLinkedProjects();
    await useSettingsStore.getState().loadFromBackend();
  };

  const handleAddAuthorizedPath = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      await invoke("add_authorized_path", { path: selected });
      setAuthorizedPaths(await invoke<string[]>("list_authorized_paths"));
    }
  };

  const handleRemoveAuthorizedPath = async (path: string) => {
    await invoke("remove_authorized_path", { path });
    setAuthorizedPaths(await invoke<string[]>("list_authorized_paths"));
  };

  const saveSkill = async () => {
    if (!skillName.trim() || !skillContent.trim()) return;
    if (skillScope === "project" && !projectRoot) return;
    await invoke("manual_skill_save", {
      scope: skillScope,
      name: skillName,
      content: skillContent,
      description: skillDescription || null,
      projectPath: skillScope === "project" ? projectRoot : null,
    });
    setSkillName("");
    setSkillDescription("");
    setSkillContent("");
    const updated = await invoke<SlashCommand[]>("slash_commands_list", {
      projectPath: projectRoot ?? undefined,
    });
    setSkills(updated.filter((item) => item.scope === "skill"));
  };

  const deleteSkill = async (skillId: string) => {
    await invoke("manual_skill_delete", {
      skillId,
      projectPath: projectRoot ?? undefined,
    });
    const updated = await invoke<SlashCommand[]>("slash_commands_list", {
      projectPath: projectRoot ?? undefined,
    });
    setSkills(updated.filter((item) => item.scope === "skill"));
  };

  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    {
      id: "providers",
      label: "Providers",
      icon: <BotIcon className="size-4" />,
    },
    {
      id: "general",
      label: "Resume",
      icon: <UserCircleIcon className="size-4" />,
    },
    {
      id: "knowledge",
      label: "Knowledgebase",
      icon: <LinkIcon className="size-4" />,
    },
    { id: "skills", label: "Skills", icon: <WrenchIcon className="size-4" /> },
    {
      id: "security",
      label: "Security",
      icon: <ShieldCheckIcon className="size-4" />,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="flex h-[82vh] max-w-4xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure providers, resume knowledge, linked projects, skills, and
            security.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <div className="w-52 shrink-0 space-y-1 border-r bg-muted/30 p-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left font-medium text-sm transition-colors",
                  activeTab === tab.id
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50",
                )}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            {activeTab === "providers" && (
              <div className="space-y-5">
                <div className="space-y-2">
                  <Label>Active provider</Label>
                  <Select
                    value={agentProviderSettings.provider}
                    onValueChange={(value) =>
                      handleProviderChange(value as AgentProvider)
                    }
                  >
                    <SelectTrigger className="w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gemini-api">Gemini API</SelectItem>
                      <SelectItem value="gemini-cli">Gemini CLI</SelectItem>
                      <SelectItem value="ollama">Ollama</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Gemini API key</Label>
                    <Input
                      type="password"
                      value={agentProviderSettings.geminiApiKey ?? ""}
                      onChange={(event) =>
                        setAgentProviderSettings({
                          geminiApiKey: event.target.value,
                        })
                      }
                      placeholder="AIza..."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Gemini API model</Label>
                    <Input
                      value={agentProviderSettings.model}
                      onChange={(event) =>
                        setAgentProviderSettings({ model: event.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Gemini CLI model</Label>
                    <Input
                      value={agentProviderSettings.geminiCliModel ?? ""}
                      onChange={(event) =>
                        setAgentProviderSettings({
                          geminiCliModel: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Ollama base URL</Label>
                    <Input
                      value={agentProviderSettings.ollamaBaseUrl}
                      onChange={(event) =>
                        setAgentProviderSettings({
                          ollamaBaseUrl: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Ollama model</Label>
                    <Input
                      value={agentProviderSettings.ollamaModel}
                      onChange={(event) =>
                        setAgentProviderSettings({
                          ollamaModel: event.target.value,
                        })
                      }
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Button size="sm" onClick={checkProvider}>
                    <SparklesIcon className="mr-1.5 size-4" />
                    Check {providerLabel}
                  </Button>
                  {health && (
                    <div className="min-w-0">
                      <span
                        className={cn(
                          "text-sm",
                          health.ok ? "text-emerald-600" : "text-destructive",
                        )}
                      >
                        {health.message}
                      </span>
                      {agentProviderSettings.provider === "ollama" &&
                        health.models.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {health.models.map((model) => (
                              <button
                                key={model}
                                type="button"
                                onClick={() =>
                                  setAgentProviderSettings({
                                    ollamaModel: model,
                                  })
                                }
                                className={cn(
                                  "rounded-md border px-2 py-1 font-mono text-xs",
                                  model === agentProviderSettings.ollamaModel
                                    ? "border-primary bg-primary/10 text-primary"
                                    : "border-border text-muted-foreground hover:bg-muted",
                                )}
                              >
                                {model}
                              </button>
                            ))}
                          </div>
                        )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === "general" && (
              <div className="space-y-5">
                <div className="space-y-2">
                  <Label>Personal bio</Label>
                  <Textarea
                    value={bioInput}
                    onChange={(event) => setBioInput(event.target.value)}
                    className="h-28 resize-none"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Resume target profile</Label>
                  <Textarea
                    value={resumeInput}
                    onChange={(event) => setResumeInput(event.target.value)}
                    placeholder="Target role, company type, seniority, keywords, tone, contact, education."
                    className="h-28 resize-none"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Manual experience</Label>
                  <Textarea
                    value={experienceInput}
                    onChange={(event) => setExperienceInput(event.target.value)}
                    placeholder="Experience entries the agent should always consider."
                    className="h-32 resize-none"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Evidence entries</Label>
                  <Textarea
                    value={evidenceInput}
                    onChange={(event) => setEvidenceInput(event.target.value)}
                    placeholder="Metrics, accomplishments, links, project evidence, or resume bullets."
                    className="h-32 resize-none"
                  />
                </div>
                <Button size="sm" onClick={saveKnowledge}>
                  Save Resume Knowledge
                </Button>
              </div>
            )}

            {activeTab === "knowledge" && (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <Label>Knowledgebase portability</Label>
                    <p className="text-muted-foreground text-xs">
                      Export or import linked projects, resume knowledge,
                      provider settings, and security preferences.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={importKnowledgebase}
                    >
                      <UploadIcon className="mr-1.5 size-4" />
                      Import
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={exportKnowledgebase}
                    >
                      <DownloadIcon className="mr-1.5 size-4" />
                      Export
                    </Button>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <Input
                    placeholder="Role on project"
                    value={projectRole}
                    onChange={(event) => setProjectRole(event.target.value)}
                  />
                  <Input
                    placeholder="Tags, comma separated"
                    value={projectTags}
                    onChange={(event) => setProjectTags(event.target.value)}
                  />
                  <Input
                    placeholder="Short project description"
                    value={projectDescription}
                    onChange={(event) =>
                      setProjectDescription(event.target.value)
                    }
                  />
                </div>
                <Button size="sm" onClick={handleAddProject}>
                  <PlusIcon className="mr-1.5 size-4" />
                  Link Project
                </Button>
                <div className="space-y-2">
                  {linkedProjects.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
                      <FolderIcon className="mb-2 size-8 text-muted-foreground/40" />
                      <p className="text-muted-foreground text-sm">
                        No projects linked yet.
                      </p>
                    </div>
                  ) : (
                    linkedProjects.map((project) => (
                      <div
                        key={project.id}
                        className={cn(
                          "group flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/30",
                          selectedEvidenceProjectId === project.id &&
                            "border-primary/60",
                        )}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() =>
                            setSelectedEvidenceProjectId(project.id)
                          }
                        >
                          <div className="font-medium text-sm">
                            {project.name}
                          </div>
                          <div className="truncate font-mono text-muted-foreground text-xs">
                            {project.path}
                          </div>
                          <div className="mt-1 text-muted-foreground text-xs">
                            {[project.role, ...(project.tags ?? [])]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                          <div className="mt-1 text-muted-foreground text-xs">
                            Last analyzed: {project.last_analyzed ?? "Never"}
                          </div>
                        </button>
                        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2 text-xs"
                            onClick={() => analyzeLinkedProject(project.id)}
                          >
                            Analyze
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => removeLinkedProject(project.id)}
                          >
                            <Trash2Icon className="size-4" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                {selectedEvidenceProjectId && (
                  <div className="space-y-3 border-t pt-5">
                    <div>
                      <Label>Project evidence summary</Label>
                      <p className="text-muted-foreground text-xs">
                        Editable durable summary stored in SQLite and included
                        in knowledgebase exports.
                      </p>
                    </div>
                    <Textarea
                      value={summaryInput}
                      onChange={(event) => setSummaryInput(event.target.value)}
                      placeholder="Architecture, ownership, measurable impact, reusable patterns, and resume evidence."
                      className="h-28 resize-none"
                    />
                    <Button size="sm" onClick={saveSelectedProjectSummary}>
                      Save Project Summary
                    </Button>
                    <div className="space-y-2">
                      <Label>Evidence observations</Label>
                      {projectObservations.length === 0 ? (
                        <p className="text-muted-foreground text-xs">
                          No cached observations for this project yet.
                        </p>
                      ) : (
                        projectObservations.slice(0, 8).map((observation) => (
                          <div
                            key={`${observation.file_path}-${observation.summary}`}
                            className="rounded-md border p-2"
                          >
                            <div className="truncate font-mono text-muted-foreground text-xs">
                              {observation.file_path}
                            </div>
                            <div className="mt-1 text-sm">
                              {observation.summary}
                            </div>
                            <div className="mt-1 text-muted-foreground text-xs">
                              {observation.key_technologies.join(", ")}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === "skills" && (
              <div className="space-y-5">
                <div className="grid gap-3 md:grid-cols-[1fr_1fr_160px]">
                  <Input
                    placeholder="Skill name"
                    value={skillName}
                    onChange={(event) => setSkillName(event.target.value)}
                  />
                  <Input
                    placeholder="Description"
                    value={skillDescription}
                    onChange={(event) =>
                      setSkillDescription(event.target.value)
                    }
                  />
                  <Select
                    value={skillScope}
                    onValueChange={(value) =>
                      setSkillScope(value as "global" | "project")
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="global">Global</SelectItem>
                      <SelectItem value="project" disabled={!projectRoot}>
                        Project
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Textarea
                  value={skillContent}
                  onChange={(event) => setSkillContent(event.target.value)}
                  placeholder="# Skill instructions..."
                  className="h-36 resize-none font-mono text-xs"
                />
                <Button
                  size="sm"
                  onClick={saveSkill}
                  disabled={skillScope === "project" && !projectRoot}
                >
                  Save Manual Skill
                </Button>
                <div className="space-y-2">
                  {skills.map((skill) => (
                    <div
                      key={skill.id}
                      className="group flex items-center justify-between rounded-lg border p-3"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          {skill.full_command}
                        </div>
                        <div className="truncate text-muted-foreground text-xs">
                          {skill.description ?? skill.name}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() => deleteSkill(skill.id)}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === "security" && (
              <div className="space-y-8">
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-6">
                    <div>
                      <Label>Redact secrets</Label>
                      <p className="text-muted-foreground text-xs">
                        Scrub API keys, tokens, and sensitive patterns before
                        cloud calls.
                      </p>
                    </div>
                    <Toggle
                      checked={redactSecrets}
                      onChange={setRedactSecrets}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-6">
                    <div>
                      <Label>Safe mode</Label>
                      <p className="text-muted-foreground text-xs">
                        Require confirmation before shell commands or file
                        edits.
                      </p>
                    </div>
                    <Toggle checked={safeMode} onChange={setSafeMode} />
                  </div>
                </div>

                <div className="space-y-4 border-t pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Authorized paths</Label>
                      <p className="text-muted-foreground text-xs">
                        Additional directories the agent can read or edit.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleAddAuthorizedPath}
                    >
                      <PlusIcon className="mr-1.5 size-4" />
                      Add Path
                    </Button>
                  </div>

                  <div className="space-y-2">
                    {authorizedPaths.length === 0 ? (
                      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-6 text-center">
                        <KeyIcon className="mb-2 size-6 text-muted-foreground/40" />
                        <p className="text-muted-foreground text-xs">
                          No additional paths authorized.
                        </p>
                      </div>
                    ) : (
                      authorizedPaths.map((path) => (
                        <div
                          key={path}
                          className="group flex items-center justify-between rounded-lg border p-2.5"
                        >
                          <div className="min-w-0 flex-1 truncate font-mono text-xs">
                            {path}
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 opacity-0 transition-opacity group-hover:opacity-100"
                            onClick={() => handleRemoveAuthorizedPath(path)}
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="border-t bg-muted/20 px-6 py-4">
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
