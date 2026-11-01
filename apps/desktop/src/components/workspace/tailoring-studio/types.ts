export interface VaniTailorRequest {
  masterPath: string;
  jobDescription: string;
  targetPageBudget: number;
  strictMetrics: boolean;
  personaId?: string | null;
}

export interface VaniTailorResult {
  runId: string;
  status: "completed" | "cancelled";
  rewrittenContent: string;
  atsScore: number;
  metricsPreserved: boolean;
  phasesCompleted: number;
}

export interface VaniTailorProgressPayload {
  runId?: string;
  phase: number;
  step: string;
  percent: number;
}

export interface VaniApprovalRequiredPayload {
  approvalId: string;
  runId: string;
  prompt: string;
  options: string[];
  defaultChoice: string | null;
}

export interface VaniTailorCancelledPayload {
  runId: string;
}

export type TailoringPhase = 1 | 2 | 3 | 4;

export interface PhaseInfo {
  phase: TailoringPhase;
  title: string;
  description: string;
  expectedStep: string;
}

export const TAILORING_PHASES: PhaseInfo[] = [
  {
    phase: 1,
    title: "Phase 1: JD Extraction",
    description:
      "Extracting core competencies, skills, and ATS requirements from job description",
    expectedStep: "Extracting skills and requirements from JD",
  },
  {
    phase: 2,
    title: "Phase 2: Knapsack Optimization",
    description:
      "Selecting highest-affinity experience blocks fitting strict page layout budget",
    expectedStep: "Selecting high-impact career blocks for page budget",
  },
  {
    phase: 3,
    title: "Phase 3: Metric-Preserving Synthesis",
    description:
      "Rewriting bullet points while strictly preserving quantified impact metrics",
    expectedStep:
      "Generating schema-compliant bullets with metric preservation",
  },
  {
    phase: 4,
    title: "Phase 4: Critic Audit & Verification",
    description:
      "Running adversarial audit to verify fact pool grounding and invariant safety",
    expectedStep: "Critic verifying fact pool membership and metric safety",
  },
];
