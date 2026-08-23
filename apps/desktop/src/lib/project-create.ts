import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { exists, join } from "@/lib/tauri/fs";
import {
  BIB_TEMPLATE,
  getTemplateSkeleton,
  type TemplateDefinition,
} from "@/lib/template-registry";
import { DEFAULT_CLAUDE_MD } from "@/lib/default-claude-md";
import { DEFAULT_AGENT_MD } from "@/lib/default-agent-md";
import {
  buildReferenceFilesSection,
  importReferenceFiles,
  type ImportedReferenceFile,
} from "@/lib/project-attachments";
import { normalizeProjectName } from "@/lib/project-name";
import { useClaudeChatStore } from "@/stores/claude-chat-store";

/** Thrown when the target folder already exists on disk. */
export class ProjectFolderExistsError extends Error {
  constructor() {
    super("A folder with this name already exists here");
    this.name = "ProjectFolderExistsError";
  }
}

export interface CreateTemplateProjectArgs {
  projectFolder: string;
  /** Raw user input; normalized here so all callers behave identically. */
  projectName: string;
  template: TemplateDefinition;
  /** Staged attachment paths (from the platform file picker). */
  attachments: string[];
  purpose: string;
}

export interface CreatedProject {
  projectPath: string;
  mainTexPath: string;
  referenceFiles: ImportedReferenceFile[];
}

/**
 * Single owner of template-project creation.
 *
 * This flow used to exist twice (project wizard + template gallery preview)
 * and had already drifted: the gallery path silently skipped CLAUDE.md /
 * AGENTS.md and the space-setup main-file hint. Any behavioral change must
 * land here so both entry points stay identical.
 */
export async function createTemplateProject(
  args: CreateTemplateProjectArgs,
): Promise<CreatedProject> {
  const name = normalizeProjectName(args.projectName);
  const projectPath = await join(args.projectFolder, name);
  if (await exists(projectPath)) {
    throw new ProjectFolderExistsError();
  }
  await mkdir(projectPath, { recursive: true });

  // CLAUDE.md gives Claude Code its project context…
  const claudeMdPath = await join(projectPath, "CLAUDE.md");
  if (!(await exists(claudeMdPath))) {
    await writeTextFile(claudeMdPath, DEFAULT_CLAUDE_MD);
  }

  // …and AGENTS.md covers backends that read that convention (including
  // DevPrism's native local agent).
  const agentMdPath = await join(projectPath, "AGENTS.md");
  if (!(await exists(agentMdPath))) {
    await writeTextFile(agentMdPath, DEFAULT_AGENT_MD);
  }

  const mainTexPath = await join(projectPath, args.template.mainFileName);
  if (!(await exists(mainTexPath))) {
    await writeTextFile(mainTexPath, getTemplateSkeleton(args.template));
  }

  if (args.template.hasBibliography) {
    const bibPath = await join(projectPath, "references.bib");
    if (!(await exists(bibPath))) {
      await writeTextFile(bibPath, BIB_TEMPLATE);
    }
  }

  const referenceFiles =
    args.attachments.length > 0
      ? await importReferenceFiles(projectPath, args.attachments)
      : [];

  const prompt = buildInitialGenerationPrompt(
    args.template,
    args.purpose,
    referenceFiles,
  );
  if (prompt) {
    useClaudeChatStore.getState().newSession();
    useClaudeChatStore.getState().setPendingInitialPrompt(prompt);
  }

  return { projectPath, mainTexPath, referenceFiles };
}

/**
 * The queued first prompt describing what the AI should generate. Empty when
 * no purpose was given (plain project, nothing to generate).
 */
export function buildInitialGenerationPrompt(
  template: TemplateDefinition,
  purpose: string,
  referenceFiles: ImportedReferenceFile[],
): string | null {
  const trimmedPurpose = purpose.trim();
  if (!trimmedPurpose) return null;

  const attachmentSection = buildReferenceFilesSection(referenceFiles);

  return [
    `## New ${template.name} Project`,
    "",
    `**Template:** \`${template.documentClass}\`  `,
    `**File:** \`${template.mainFileName}\``,
    "",
    `> The file currently contains only the LaTeX preamble (packages, styling, custom commands) with an empty document body.`,
    "",
    `### What I want to create`,
    "",
    trimmedPurpose,
    attachmentSection,
    `### Instructions`,
    "",
    `Please generate the full document content based on my description. Keep the existing preamble and fill in the document body (between \`\\begin{document}\` and \`\\end{document}\`) with appropriate title, author, sections, and content. Make it a complete, well-structured **${template.name.toLowerCase()}** ready for me to refine.`,
  ].join("\n");
}
