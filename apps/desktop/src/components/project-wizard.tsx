import { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  FileTextIcon,
  UserIcon,
  LayoutIcon,
  BookOpenIcon,
  MailIcon,
  MonitorIcon,
  BookIcon,
  FileIcon,
  FolderOpenIcon,
  PaperclipIcon,
  XIcon,
  SparklesIcon,
  GraduationCapIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { exists, join } from "@/lib/tauri/fs";

// ─── Template Definitions ───

interface Template {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  documentClass: string;
  mainFileName: string;
  content: string;
}

const TEMPLATES: Template[] = [
  {
    id: "paper",
    name: "Research Paper",
    description: "Academic paper with abstract, sections, references",
    icon: <FileTextIcon className="size-6" />,
    documentClass: "article",
    mainFileName: "main.tex",
    content: `\\documentclass[12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}
\\usepackage{booktabs}
\\usepackage{natbib}

\\title{Title}
\\author{Author Name}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Your abstract here.
\\end{abstract}

\\section{Introduction}

\\section{Related Work}

\\section{Method}

\\section{Results}

\\section{Conclusion}

\\bibliographystyle{plainnat}
\\bibliography{references}

\\end{document}
`,
  },
  {
    id: "cv",
    name: "CV / Resume",
    description: "Professional curriculum vitae",
    icon: <UserIcon className="size-6" />,
    documentClass: "article",
    mainFileName: "main.tex",
    content: `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=0.8in]{geometry}
\\usepackage{hyperref}
\\usepackage{enumitem}
\\usepackage{titlesec}

\\titleformat{\\section}{\\large\\bfseries}{}{0em}{}[\\titlerule]
\\titlespacing{\\section}{0pt}{12pt}{6pt}

\\pagestyle{empty}

\\begin{document}

\\begin{center}
  {\\LARGE\\bfseries Your Name}\\\\[4pt]
  your.email@example.com \\quad | \\quad City, Country
\\end{center}

\\section{Education}

\\section{Experience}

\\section{Skills}

\\section{Publications}

\\end{document}
`,
  },
  {
    id: "poster",
    name: "Poster",
    description: "Conference or research poster",
    icon: <LayoutIcon className="size-6" />,
    documentClass: "a0poster",
    mainFileName: "main.tex",
    content: `\\documentclass[a1paper,portrait]{a0poster}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{multicol}
\\usepackage[margin=2cm]{geometry}
\\usepackage{xcolor}

\\begin{document}

\\begin{center}
  {\\VERYHuge\\bfseries Poster Title}\\\\[1cm]
  {\\LARGE Author Name \\quad Institution}
\\end{center}

\\vspace{1cm}

\\begin{multicols}{2}

\\section*{Introduction}

\\section*{Methods}

\\section*{Results}

\\section*{Conclusions}

\\section*{References}

\\end{multicols}

\\end{document}
`,
  },
  {
    id: "thesis",
    name: "Thesis",
    description: "Dissertation or thesis with chapters",
    icon: <GraduationCapIcon className="size-6" />,
    documentClass: "report",
    mainFileName: "main.tex",
    content: `\\documentclass[12pt,a4paper]{report}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}
\\usepackage{booktabs}
\\usepackage{natbib}
\\usepackage{setspace}

\\onehalfspacing

\\title{Thesis Title}
\\author{Author Name}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Your abstract here.
\\end{abstract}

\\tableofcontents

\\chapter{Introduction}

\\chapter{Literature Review}

\\chapter{Methodology}

\\chapter{Results}

\\chapter{Discussion}

\\chapter{Conclusion}

\\bibliographystyle{plainnat}
\\bibliography{references}

\\end{document}
`,
  },
  {
    id: "presentation",
    name: "Presentation",
    description: "Beamer slides for talks and lectures",
    icon: <MonitorIcon className="size-6" />,
    documentClass: "beamer",
    mainFileName: "main.tex",
    content: `\\documentclass{beamer}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}

\\usetheme{Madrid}

\\title{Presentation Title}
\\author{Author Name}
\\institute{Institution}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Outline}
  \\tableofcontents
\\end{frame}

\\section{Introduction}
\\begin{frame}{Introduction}
  Content here.
\\end{frame}

\\section{Main Content}
\\begin{frame}{Main Content}
  Content here.
\\end{frame}

\\section{Conclusion}
\\begin{frame}{Conclusion}
  Content here.
\\end{frame}

\\end{document}
`,
  },
  {
    id: "letter",
    name: "Letter",
    description: "Formal or cover letter",
    icon: <MailIcon className="size-6" />,
    documentClass: "letter",
    mainFileName: "main.tex",
    content: `\\documentclass[12pt]{letter}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}

\\signature{Your Name}
\\address{Your Address \\\\ City, Country}

\\begin{document}

\\begin{letter}{Recipient Name \\\\ Recipient Address \\\\ City, Country}

\\opening{Dear Recipient,}

Your letter content here.

\\closing{Sincerely,}

\\end{letter}

\\end{document}
`,
  },
  {
    id: "book",
    name: "Book",
    description: "Multi-chapter book or manuscript",
    icon: <BookIcon className="size-6" />,
    documentClass: "book",
    mainFileName: "main.tex",
    content: `\\documentclass[12pt,a4paper]{book}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}

\\title{Book Title}
\\author{Author Name}
\\date{\\today}

\\begin{document}

\\frontmatter
\\maketitle
\\tableofcontents

\\mainmatter

\\chapter{First Chapter}

\\chapter{Second Chapter}

\\backmatter

\\end{document}
`,
  },
  {
    id: "blank",
    name: "Blank",
    description: "Minimal template to start from scratch",
    icon: <FileIcon className="size-6" />,
    documentClass: "article",
    mainFileName: "main.tex",
    content: `\\documentclass[12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}

\\begin{document}

% Start writing here.

\\end{document}
`,
  },
];

const BIB_TEMPLATE = `% Add your references here
% Example:
% @article{key,
%   author  = {Author Name},
%   title   = {Article Title},
%   journal = {Journal Name},
%   year    = {2024},
% }
`;

// ─── Wizard Component ───

interface ProjectWizardProps {
  onBack: () => void;
}

export function ProjectWizard({ onBack }: ProjectWizardProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [projectFolder, setProjectFolder] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const openProject = useDocumentStore((s) => s.openProject);

  const template = TEMPLATES.find((t) => t.id === selectedTemplate);

  const handleSelectTemplate = (id: string) => {
    setSelectedTemplate(id);
    setStep(2);
  };

  const handleChooseFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose Location for New Project",
    });
    if (selected) {
      setProjectFolder(selected);
      if (!projectName) {
        setProjectName(selected.split("/").pop() || "my-project");
      }
    }
  }, [projectName]);

  const handleAddAttachments = useCallback(async () => {
    const selected = await open({
      multiple: true,
      title: "Add Reference Files",
      filters: [
        {
          name: "Documents & Images",
          extensions: [
            "pdf", "tex", "bib", "txt", "md",
            "png", "jpg", "jpeg", "gif", "svg",
            "csv", "tsv", "json",
          ],
        },
      ],
    });
    if (selected) {
      const paths = Array.isArray(selected) ? selected : [selected];
      setAttachments((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]);
    }
  }, []);

  const handleRemoveAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  };

  const handleCreate = async () => {
    if (!template || !projectFolder || !projectName.trim()) return;
    setIsCreating(true);

    try {
      // Create project directory
      const projectPath = await join(projectFolder, projectName.trim());
      await mkdir(projectPath, { recursive: true }).catch(() => {});

      // Write main.tex
      const mainTexPath = await join(projectPath, template.mainFileName);
      const mainExists = await exists(mainTexPath);
      if (!mainExists) {
        await writeTextFile(mainTexPath, template.content);
      }

      // Write references.bib for templates that use bibliography
      if (["paper", "thesis"].includes(template.id)) {
        const bibPath = await join(projectPath, "references.bib");
        const bibExists = await exists(bibPath);
        if (!bibExists) {
          await writeTextFile(bibPath, BIB_TEMPLATE);
        }
      }

      // Import attachments into project
      if (attachments.length > 0) {
        const attachmentsDir = await join(projectPath, "attachments");
        await mkdir(attachmentsDir, { recursive: true }).catch(() => {});
      }

      // Build the initial prompt for Claude
      if (purpose.trim()) {
        const attachmentNames = attachments.map((p) => p.split("/").pop()).filter(Boolean);
        let prompt = `I just created a new ${template.name} project using a ${template.documentClass} template.\n\n`;
        prompt += `Here is what I want to create:\n${purpose.trim()}\n\n`;
        if (attachmentNames.length > 0) {
          prompt += `I've included these reference files in the attachments/ folder: ${attachmentNames.join(", ")}\n`;
          prompt += `Please review them and incorporate relevant information.\n\n`;
        }
        prompt += `Please customize the template to match my requirements. Update the content, title, author, and structure as needed. Make it a complete, well-structured document ready for me to refine.`;

        // Set as pending so it fires after workspace initializes
        useClaudeChatStore.getState().newSession();
        useClaudeChatStore.getState().setPendingInitialPrompt(prompt);
      }

      // Open the project
      addRecentProject(projectPath);
      await openProject(projectPath);

      // Import attachments after project is open
      if (attachments.length > 0) {
        await useDocumentStore.getState().importFiles(attachments, "attachments");
      }
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      setIsCreating(false);
    }
  };

  const canCreate = template && projectFolder && projectName.trim();

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header — padded top for macOS overlay titlebar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 pt-[var(--titlebar-height)] h-[calc(48px+var(--titlebar-height))]">
        <Button variant="ghost" size="icon" className="size-7" onClick={step === 1 ? onBack : () => setStep(1)}>
          <ArrowLeftIcon className="size-4" />
        </Button>
        <div className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">
            {step === 1 ? "Choose a Template" : "Project Details"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          <div className={`size-2 rounded-full ${step >= 1 ? "bg-foreground" : "bg-muted-foreground/30"}`} />
          <div className={`size-2 rounded-full ${step >= 2 ? "bg-foreground" : "bg-muted-foreground/30"}`} />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {step === 1 ? (
          <TemplateGrid onSelect={handleSelectTemplate} selected={selectedTemplate} />
        ) : (
          <div className="mx-auto max-w-lg space-y-6 p-6">
            {/* Selected template indicator */}
            {template && (
              <button
                onClick={() => setStep(1)}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-muted/30 p-3 text-left transition-colors hover:bg-muted/50"
              >
                <div className="flex size-10 items-center justify-center rounded-md bg-background text-muted-foreground">
                  {template.icon}
                </div>
                <div className="flex-1">
                  <div className="font-medium text-sm">{template.name}</div>
                  <div className="text-muted-foreground text-xs">{template.description}</div>
                </div>
                <span className="text-muted-foreground text-xs">Change</span>
              </button>
            )}

            {/* Purpose */}
            <div className="space-y-2">
              <label className="font-medium text-sm">What are you writing?</label>
              <Textarea
                placeholder="e.g., A research paper on transformer architectures for protein structure prediction, targeting NeurIPS 2025..."
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                rows={4}
                className="resize-none"
              />
              <p className="text-muted-foreground text-xs">
                Claude will use this to customize your template with relevant content and structure.
              </p>
            </div>

            {/* Attachments */}
            <div className="space-y-2">
              <label className="font-medium text-sm">Reference files (optional)</label>
              <div className="space-y-1.5">
                {attachments.map((path) => (
                  <div
                    key={path}
                    className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-1.5 text-sm"
                  >
                    <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-xs">{path.split("/").pop()}</span>
                    <button
                      onClick={() => handleRemoveAttachment(path)}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </div>
                ))}
                <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={handleAddAttachments}>
                  <PaperclipIcon className="size-3.5" />
                  Add files
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                PDFs, images, .bib, .tex, or data files to include as references.
              </p>
            </div>

            {/* Project location */}
            <div className="space-y-2">
              <label className="font-medium text-sm">Project location</label>
              <div className="flex gap-2">
                <Input
                  placeholder="Project name"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="flex-1"
                />
                <Button variant="outline" className="shrink-0 gap-1.5" onClick={handleChooseFolder}>
                  <FolderOpenIcon className="size-4" />
                  {projectFolder ? "Change" : "Choose folder"}
                </Button>
              </div>
              {projectFolder && (
                <p className="truncate text-muted-foreground text-xs">
                  {projectFolder}/{projectName.trim() || "..."}
                </p>
              )}
            </div>

            {/* Create button */}
            <Button
              className="w-full gap-2"
              size="lg"
              disabled={!canCreate || isCreating}
              onClick={handleCreate}
            >
              {isCreating ? (
                "Creating..."
              ) : purpose.trim() ? (
                <>
                  <SparklesIcon className="size-4" />
                  Create & Generate with AI
                </>
              ) : (
                "Create Project"
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Template Grid ───

function TemplateGrid({
  onSelect,
  selected,
}: {
  onSelect: (id: string) => void;
  selected: string | null;
}) {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <p className="mb-6 text-center text-muted-foreground text-sm">
        Pick a starting template. Claude will customize it based on your needs.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {TEMPLATES.map((tmpl) => (
          <button
            key={tmpl.id}
            onClick={() => onSelect(tmpl.id)}
            className={`flex flex-col items-center gap-2.5 rounded-xl border p-5 text-center transition-all hover:border-foreground/30 hover:bg-muted/50 ${
              selected === tmpl.id
                ? "border-foreground bg-muted/50"
                : "border-border"
            }`}
          >
            <div className="text-muted-foreground">{tmpl.icon}</div>
            <div>
              <div className="font-medium text-sm">{tmpl.name}</div>
              <div className="mt-0.5 text-muted-foreground text-xs leading-tight">
                {tmpl.description}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
