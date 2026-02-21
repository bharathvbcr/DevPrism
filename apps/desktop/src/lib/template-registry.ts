// ─── Template Data Architecture ───

export type TemplateCategory = "academic" | "professional" | "creative" | "starter";

export type TemplateSubcategory =
  | "papers"
  | "theses"
  | "presentations"
  | "posters"
  | "cv"
  | "letters"
  | "reports"
  | "books"
  | "newsletters"
  | "blank";

export interface TemplatePackage {
  name: string;
  description: string;
}

export interface TemplateDefinition {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  subcategory: TemplateSubcategory;
  tags: string[];
  icon: string; // lucide icon name
  documentClass: string;
  mainFileName: string;
  content: string;
  packages: TemplatePackage[];
  /** Accent color for thumbnail placeholder */
  accentColor: string;
  /** Whether template uses bibliography */
  hasBibliography: boolean;
}

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  academic: "Academic",
  professional: "Professional",
  creative: "Creative",
  starter: "Starter",
};

export const SUBCATEGORY_LABELS: Record<TemplateSubcategory, string> = {
  papers: "Papers",
  theses: "Theses & Dissertations",
  presentations: "Presentations",
  posters: "Posters",
  cv: "CV & Resume",
  letters: "Letters",
  reports: "Reports",
  books: "Books",
  newsletters: "Newsletters",
  blank: "Blank",
};

export const CATEGORY_SUBCATEGORIES: Record<TemplateCategory, TemplateSubcategory[]> = {
  academic: ["papers", "theses", "presentations", "posters"],
  professional: ["cv", "letters", "reports"],
  creative: ["books", "newsletters"],
  starter: ["blank"],
};

// ─── Template Definitions ───

const TEMPLATES: TemplateDefinition[] = [
  {
    id: "paper-standard",
    name: "Research Paper",
    description: "Academic paper with abstract, sections, and references",
    category: "academic",
    subcategory: "papers",
    tags: ["article", "research", "journal", "academic", "science", "abstract", "bibliography"],
    icon: "FileText",
    documentClass: "article",
    mainFileName: "main.tex",
    accentColor: "#3b82f6",
    hasBibliography: true,
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "geometry", description: "Page layout customization" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
      { name: "booktabs", description: "Professional table formatting" },
      { name: "natbib", description: "Bibliography management" },
    ],
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
    id: "paper-ieee",
    name: "IEEE Conference Paper",
    description: "Two-column IEEE conference format with standard sections",
    category: "academic",
    subcategory: "papers",
    tags: ["ieee", "conference", "two-column", "engineering", "computer science"],
    icon: "FileText",
    documentClass: "IEEEtran",
    mainFileName: "main.tex",
    accentColor: "#2563eb",
    hasBibliography: true,
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
      { name: "cite", description: "Citation sorting and compression" },
      { name: "algorithmic", description: "Algorithm typesetting" },
    ],
    content: `\\documentclass[conference]{IEEEtran}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{cite}

\\title{Paper Title}
\\author{
  \\IEEEauthorblockN{Author Name}
  \\IEEEauthorblockA{Department \\\\ University \\\\ email@example.com}
}

\\begin{document}

\\maketitle

\\begin{abstract}
Your abstract here.
\\end{abstract}

\\begin{IEEEkeywords}
keyword1, keyword2, keyword3
\\end{IEEEkeywords}

\\section{Introduction}

\\section{Related Work}

\\section{Proposed Method}

\\section{Experiments}

\\section{Results}

\\section{Conclusion}

\\bibliographystyle{IEEEtran}
\\bibliography{references}

\\end{document}
`,
  },
  {
    id: "paper-acm",
    name: "ACM Conference Paper",
    description: "ACM SIGCONF format for computing conferences",
    category: "academic",
    subcategory: "papers",
    tags: ["acm", "conference", "computing", "sigconf", "computer science"],
    icon: "FileText",
    documentClass: "acmart",
    mainFileName: "main.tex",
    accentColor: "#1d4ed8",
    hasBibliography: true,
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "booktabs", description: "Professional table formatting" },
    ],
    content: `\\documentclass[sigconf]{acmart}

\\title{Paper Title}
\\author{Author Name}
\\affiliation{
  \\institution{University}
  \\city{City}
  \\country{Country}
}
\\email{email@example.com}

\\begin{document}

\\begin{abstract}
Your abstract here.
\\end{abstract}

\\begin{CCSXML}
\\end{CCSXML}

\\keywords{keyword1, keyword2, keyword3}

\\maketitle

\\section{Introduction}

\\section{Related Work}

\\section{Method}

\\section{Evaluation}

\\section{Conclusion}

\\bibliographystyle{ACM-Reference-Format}
\\bibliography{references}

\\end{document}
`,
  },
  {
    id: "thesis-standard",
    name: "Thesis",
    description: "Dissertation or thesis with chapters and front matter",
    category: "academic",
    subcategory: "theses",
    tags: ["thesis", "dissertation", "phd", "masters", "chapters", "academic"],
    icon: "GraduationCap",
    documentClass: "report",
    mainFileName: "main.tex",
    accentColor: "#8b5cf6",
    hasBibliography: true,
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "geometry", description: "Page layout customization" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
      { name: "booktabs", description: "Professional table formatting" },
      { name: "natbib", description: "Bibliography management" },
      { name: "setspace", description: "Line spacing control" },
    ],
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
    id: "presentation-beamer",
    name: "Presentation (Beamer)",
    description: "Slide deck for talks, lectures, and conferences",
    category: "academic",
    subcategory: "presentations",
    tags: ["beamer", "slides", "talk", "lecture", "conference", "presentation"],
    icon: "Monitor",
    documentClass: "beamer",
    mainFileName: "main.tex",
    accentColor: "#f59e0b",
    hasBibliography: false,
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
    ],
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
    id: "poster-academic",
    name: "Academic Poster",
    description: "Conference or research poster with multi-column layout",
    category: "academic",
    subcategory: "posters",
    tags: ["poster", "conference", "research", "a0", "a1", "multi-column"],
    icon: "Layout",
    documentClass: "a0poster",
    mainFileName: "main.tex",
    accentColor: "#ec4899",
    hasBibliography: false,
    packages: [
      { name: "amsmath", description: "AMS mathematical typesetting" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "multicol", description: "Multi-column layouts" },
      { name: "geometry", description: "Page layout customization" },
      { name: "xcolor", description: "Color support" },
    ],
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
    id: "cv-modern",
    name: "CV / Resume",
    description: "Clean, professional curriculum vitae layout",
    category: "professional",
    subcategory: "cv",
    tags: ["cv", "resume", "curriculum vitae", "job", "career", "professional"],
    icon: "User",
    documentClass: "article",
    mainFileName: "main.tex",
    accentColor: "#10b981",
    hasBibliography: false,
    packages: [
      { name: "geometry", description: "Page layout customization" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
      { name: "enumitem", description: "List customization" },
      { name: "titlesec", description: "Section title formatting" },
    ],
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
    id: "letter-formal",
    name: "Formal Letter",
    description: "Professional or cover letter with standard formatting",
    category: "professional",
    subcategory: "letters",
    tags: ["letter", "formal", "cover letter", "business", "correspondence"],
    icon: "Mail",
    documentClass: "letter",
    mainFileName: "main.tex",
    accentColor: "#06b6d4",
    hasBibliography: false,
    packages: [
      { name: "geometry", description: "Page layout customization" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
    ],
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
    id: "report-technical",
    name: "Technical Report",
    description: "Structured report with table of contents and sections",
    category: "professional",
    subcategory: "reports",
    tags: ["report", "technical", "business", "documentation", "sections"],
    icon: "ClipboardList",
    documentClass: "report",
    mainFileName: "main.tex",
    accentColor: "#6366f1",
    hasBibliography: false,
    packages: [
      { name: "geometry", description: "Page layout customization" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
      { name: "booktabs", description: "Professional table formatting" },
      { name: "listings", description: "Source code typesetting" },
      { name: "xcolor", description: "Color support" },
    ],
    content: `\\documentclass[12pt,a4paper]{report}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{booktabs}
\\usepackage{listings}
\\usepackage{xcolor}

\\lstset{
  basicstyle=\\ttfamily\\small,
  frame=single,
  breaklines=true,
}

\\title{Technical Report Title}
\\author{Author Name}
\\date{\\today}

\\begin{document}

\\maketitle
\\tableofcontents

\\chapter{Introduction}

\\chapter{Background}

\\chapter{Implementation}

\\chapter{Results}

\\chapter{Conclusion}

\\end{document}
`,
  },
  {
    id: "book-standard",
    name: "Book",
    description: "Multi-chapter book or manuscript with front/back matter",
    category: "creative",
    subcategory: "books",
    tags: ["book", "manuscript", "chapters", "novel", "textbook", "publishing"],
    icon: "Book",
    documentClass: "book",
    mainFileName: "main.tex",
    accentColor: "#d946ef",
    hasBibliography: false,
    packages: [
      { name: "geometry", description: "Page layout customization" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "hyperref", description: "Hyperlinks and PDF metadata" },
    ],
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
    id: "newsletter",
    name: "Newsletter",
    description: "Multi-column newsletter with header and styled sections",
    category: "creative",
    subcategory: "newsletters",
    tags: ["newsletter", "column", "publication", "magazine", "bulletin"],
    icon: "Newspaper",
    documentClass: "article",
    mainFileName: "main.tex",
    accentColor: "#f97316",
    hasBibliography: false,
    packages: [
      { name: "geometry", description: "Page layout customization" },
      { name: "multicol", description: "Multi-column layouts" },
      { name: "graphicx", description: "Enhanced graphics support" },
      { name: "xcolor", description: "Color support" },
      { name: "titlesec", description: "Section title formatting" },
      { name: "fancyhdr", description: "Custom headers and footers" },
    ],
    content: `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=0.75in]{geometry}
\\usepackage{multicol}
\\usepackage{graphicx}
\\usepackage{xcolor}
\\usepackage{titlesec}
\\usepackage{fancyhdr}

\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[C]{\\textbf{Newsletter Title} --- \\today}
\\fancyfoot[C]{\\thepage}

\\titleformat{\\section}{\\large\\bfseries\\color{blue!70!black}}{}{0em}{}

\\begin{document}

\\begin{center}
  {\\Huge\\bfseries Newsletter Title}\\\\[0.5cm]
  {\\large Volume 1, Issue 1 --- \\today}
\\end{center}

\\vspace{0.5cm}

\\begin{multicols}{2}

\\section{Lead Story}
Your lead story content here.

\\section{Feature Article}
Your feature article content here.

\\section{Announcements}
Your announcements here.

\\end{multicols}

\\end{document}
`,
  },
  {
    id: "blank",
    name: "Blank Document",
    description: "Minimal template to start from scratch",
    category: "starter",
    subcategory: "blank",
    tags: ["blank", "empty", "minimal", "scratch", "custom"],
    icon: "File",
    documentClass: "article",
    mainFileName: "main.tex",
    accentColor: "#71717a",
    hasBibliography: false,
    packages: [],
    content: `\\documentclass[12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}

\\begin{document}

% Start writing here.

\\end{document}
`,
  },
];

export const BIB_TEMPLATE = `% Add your references here
% Example:
% @article{key,
%   author  = {Author Name},
%   title   = {Article Title},
%   journal = {Journal Name},
%   year    = {2024},
% }
`;

// ─── Registry API ───

let _templates = TEMPLATES;

export function getAllTemplates(): TemplateDefinition[] {
  return _templates;
}

export function getTemplateById(id: string): TemplateDefinition | undefined {
  return _templates.find((t) => t.id === id);
}

export function getTemplatesByCategory(category: TemplateCategory): TemplateDefinition[] {
  return _templates.filter((t) => t.category === category);
}

export function getCategories(): TemplateCategory[] {
  return ["academic", "professional", "creative", "starter"];
}

export function searchTemplates(query: string): TemplateDefinition[] {
  if (!query.trim()) return _templates;
  const q = query.toLowerCase().trim();
  const words = q.split(/\s+/);
  return _templates.filter((t) => {
    const haystack = [
      t.name,
      t.description,
      t.documentClass,
      ...t.tags,
      t.category,
      t.subcategory,
    ]
      .join(" ")
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}
