/**
 * Opaque-box Tauri IPC Simulator for DevPrism E2E Test Suite.
 *
 * Implements the exact command and event interfaces defined in PROJECT.md:
 * - M1 Typst Engine: typst_compile_document, typst_sync_forward, typst_sync_inverse
 * - M3 Manvi Bridge: manvi_tailor_resume, manvi_approve_action, manvi_cancel_run
 * - M3 Variant Data Model: list_variants, create_variant, update_variant, delete_variant, diff_variant
 * - M2 Native Window Theme: set_native_window_theme
 */

export interface TypstDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  hints: string[];
}

export interface TypstCompileError {
  message: string;
  errors: TypstDiagnostic[];
  warnings: TypstDiagnostic[];
  duration_ms: number;
}

export interface SynctexForwardResult {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SynctexResult {
  file: string;
  line: number;
  column: number;
}

export interface ExtendedVariantManifest {
  id: string;
  name: string;
  status: string;
  jd: string;
  createdAt: number;
  updatedAt: number;
  path: string;
  company?: string;
  role?: string;
  seniority?: string;
  persona?: string;
  atsScore?: number;
}

export interface VariantFileDiff {
  filePath: string;
  status: "added" | "modified" | "deleted";
  oldContent: string | null;
  newContent: string | null;
}

export interface VaniTailorRequest {
  masterPath: string;
  jobDescription: string;
  targetPageBudget: 1 | 2;
  strictMetrics: boolean;
}

export interface VaniTailorResult {
  runId: string;
  status: "completed" | "cancelled" | "failed";
  rewrittenContent: string;
  atsScore: number;
  metricsPreserved: boolean;
  phasesCompleted: number;
}

export interface TailorProgressEvent {
  runId: string;
  phase: number;
  step: string;
  percent: number;
}

export interface ApprovalRequiredEvent {
  approvalId: string;
  runId: string;
  prompt: string;
  options: string[];
  defaultChoice?: string;
}

export type EventListener = (payload: any) => void;

export class OpaqueTauriBridge {
  private eventListeners = new Map<string, Set<EventListener>>();
  private variants = new Map<string, ExtendedVariantManifest>();
  private activeRuns = new Map<
    string,
    { status: string; cancelled: boolean }
  >();
  private pendingApprovals = new Map<
    string,
    {
      resolve: (decision: { allow: boolean; chosen?: string }) => void;
      event: ApprovalRequiredEvent;
    }
  >();
  public nativeTheme: "light" | "dark" = "dark";
  public compileCallCount = 0;
  public lastCompileOverlay?: Record<string, string>;

  // PDF Generator Helper creating valid %PDF-1.7 binary ArrayBuffer
  public generatePdfBuffer(contentStr: string): ArrayBuffer {
    const header = "%PDF-1.7\n";
    const body = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${contentStr.length} >>\nstream\n${contentStr}\nendstream\nendobj\n`;
    const xref =
      "xref\n0 5\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000115 00000 n \n0000000170 00000 n \n";
    const trailer = `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${(header + body).length}\n%%EOF\n`;
    const full = header + body + xref + trailer;
    const buf = new ArrayBuffer(full.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < full.length; i++) {
      view[i] = full.charCodeAt(i);
    }
    return buf;
  }

  // Event Subscription
  public listen(event: string, callback: EventListener): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);
    return () => {
      this.eventListeners.get(event)?.delete(callback);
    };
  }

  public emit(event: string, payload: any): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach((cb) => cb(payload));
    }
  }

  // Reset internal simulator state
  public reset(): void {
    this.eventListeners.clear();
    this.variants.clear();
    this.activeRuns.clear();
    this.pendingApprovals.clear();
    this.compileCallCount = 0;
    this.lastCompileOverlay = undefined;
    this.nativeTheme = "dark";
  }

  // Handle Tauri invokes
  public async invoke(cmd: string, args?: Record<string, any>): Promise<any> {
    switch (cmd) {
      case "typst_compile_document": {
        this.compileCallCount++;
        const _projectDir = String(args?.project_dir ?? args?.projectDir ?? "");
        const mainFile = String(
          args?.main_file ?? args?.mainFile ?? "main.typ",
        );
        const overlay = (args?.overlay as Record<string, string>) || {};
        this.lastCompileOverlay = overlay;

        // Resolve source either from overlay or default
        const effectiveSource =
          overlay[mainFile] ??
          overlay[`/${mainFile}`] ??
          "= Sample Resume\nHello World";

        // Check for simulated syntax error
        if (
          effectiveSource.includes("#syntax_error") ||
          effectiveSource.includes("#unclosed_let")
        ) {
          const err: TypstCompileError = {
            message: "Compilation failed: unexpected token or syntax error",
            errors: [
              {
                severity: "error",
                message: "syntax error: expected expression",
                file: mainFile,
                line: 2,
                column: 8,
                hints: ["check for unclosed delimiters or missing semicolons"],
              },
            ],
            warnings: [],
            duration_ms: 18,
          };
          throw err;
        }

        if (effectiveSource.includes("#warning_tag")) {
          // Returns valid PDF while reporting warnings
          return this.generatePdfBuffer(effectiveSource);
        }

        return this.generatePdfBuffer(effectiveSource);
      }

      case "typst_sync_forward": {
        const line = Number(args?.line ?? 1);
        if (line <= 0) return null;
        if (line > 1000) return null;
        const result: SynctexForwardResult = {
          page: Math.min(Math.floor((line - 1) / 50) + 1, 2),
          x: 72.0,
          y: 100.0 + (line % 50) * 12.0,
          width: 450.0,
          height: 14.0,
        };
        return result;
      }

      case "typst_sync_inverse": {
        const page = Number(args?.page ?? 1);
        const y = Number(args?.y ?? 0);
        if (page < 1 || page > 2) return null;
        if (y < 50 || y > 750) return null; // clicked margins
        const line = Math.floor((y - 100) / 12) + (page - 1) * 50;
        const result: SynctexResult = {
          file: "main.typ",
          line: Math.max(1, line),
          column: 1,
        };
        return result;
      }

      case "set_native_window_theme": {
        this.nativeTheme = args?.theme === "light" ? "light" : "dark";
        return;
      }

      case "list_variants": {
        return Array.from(this.variants.values());
      }

      case "create_variant": {
        const projectRoot = String(
          args?.projectRoot ?? args?.project_root ?? "/mock/project",
        );
        const name = String(args?.name ?? "Untitled").trim();
        if (!name) throw new Error("Version name cannot be empty.");
        const jd = String(args?.jd ?? "");
        const status = String(args?.status ?? "draft");
        const slug =
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "version";
        const id = this.variants.has(slug)
          ? `${slug}-${Date.now().toString().slice(-4)}`
          : slug;

        const variant: ExtendedVariantManifest = {
          id,
          name,
          status,
          jd,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          path: `${projectRoot}/.prism/variants/${id}`,
          company: args?.company,
          role: args?.role,
          seniority: args?.seniority,
          persona: args?.persona,
          atsScore: args?.atsScore ?? 75,
        };
        this.variants.set(id, variant);
        return variant;
      }

      case "update_variant": {
        const variantId = String(args?.variantId ?? args?.variant_id ?? "");
        const variant = this.variants.get(variantId);
        if (!variant) throw new Error("That version no longer exists.");

        if (args?.name) variant.name = String(args.name).trim();
        if (args?.status) variant.status = String(args.status).trim();
        if (args?.jd !== undefined && args?.jd !== null)
          variant.jd = String(args.jd);
        if (args?.company !== undefined) variant.company = args.company;
        if (args?.role !== undefined) variant.role = args.role;
        if (args?.seniority !== undefined) variant.seniority = args.seniority;
        if (args?.persona !== undefined) variant.persona = args.persona;
        if (args?.atsScore !== undefined) {
          const score = Number(args.atsScore);
          if (score < 0 || score > 100)
            throw new Error("ATS score must be between 0 and 100.");
          variant.atsScore = score;
        }
        variant.updatedAt = Date.now();
        this.variants.set(variantId, variant);
        return variant;
      }

      case "delete_variant": {
        const variantId = String(args?.variantId ?? args?.variant_id ?? "");
        this.variants.delete(variantId);
        return;
      }

      case "diff_variant": {
        const variantId = String(args?.variantId ?? args?.variant_id ?? "");
        const variant = this.variants.get(variantId);
        if (!variant) throw new Error("That version no longer exists.");

        const diffs: VariantFileDiff[] = [
          {
            filePath: "main.typ",
            status: "modified",
            oldContent:
              "= Master Document\nExperienced Engineer with 5+ years experience.",
            newContent:
              "= Tailored Document\nExperienced Distributed Systems Engineer with 5+ years leading high-throughput Go/Rust pipelines.",
          },
          {
            filePath: "cover-letter.typ",
            status: "added",
            oldContent: null,
            newContent: `= Cover Letter for ${variant.company || "Target Company"}`,
          },
        ];
        return diffs;
      }

      case "manvi_tailor_resume": {
        const runId = `run_${Math.random().toString(36).slice(2, 9)}`;
        this.activeRuns.set(runId, { status: "running", cancelled: false });

        const req = args?.request as VaniTailorRequest;
        const jd = req?.jobDescription ?? "";
        if (!jd.trim()) {
          throw new Error("Job description cannot be empty.");
        }

        // Emit Phase 1: JD Extraction
        this.emit("vani://tailor-progress", {
          runId,
          phase: 1,
          step: "Extracting skills and requirements from JD",
          percent: 0.25,
        });

        // Emit Phase 2: Knapsack Packing
        this.emit("vani://tailor-progress", {
          runId,
          phase: 2,
          step: "Selecting high-impact career blocks for page budget",
          percent: 0.5,
        });

        // Trigger Approval if interactive decision required
        const approvalId = `appr_${Math.random().toString(36).slice(2, 9)}`;
        const approvalPromise = new Promise<{
          allow: boolean;
          chosen?: string;
        }>((resolve) => {
          this.pendingApprovals.set(approvalId, {
            resolve,
            event: {
              approvalId,
              runId,
              prompt:
                "Select bullet focus: Performance Optimization vs Developer Productivity",
              options: [
                "Performance Optimization (40% latency reduction)",
                "Developer Productivity (2x deployment speed)",
              ],
              defaultChoice: "Performance Optimization (40% latency reduction)",
            },
          });
        });

        this.emit("vani://approval-required", {
          approvalId,
          runId,
          prompt:
            "Select bullet focus: Performance Optimization vs Developer Productivity",
          options: [
            "Performance Optimization (40% latency reduction)",
            "Developer Productivity (2x deployment speed)",
          ],
          defaultChoice: "Performance Optimization (40% latency reduction)",
        });

        // For non-blocking automated testing, if no listener intercepts immediately, auto-resolve
        const decision = await Promise.race([
          approvalPromise,
          new Promise<{ allow: boolean; chosen?: string }>((res) => {
            setTimeout(
              () => res({ allow: true, chosen: "Performance Optimization" }),
              50,
            );
          }),
        ]);

        if (!decision.allow) {
          this.activeRuns.set(runId, { status: "cancelled", cancelled: true });
          return {
            runId,
            status: "cancelled",
            rewrittenContent: "",
            atsScore: 0,
            metricsPreserved: true,
            phasesCompleted: 2,
          };
        }

        // Emit Phase 3: Schema-Aware Rewrites with Metric Preservation
        this.emit("vani://tailor-progress", {
          runId,
          phase: 3,
          step: "Generating schema-compliant bullets preserving 40% latency metric",
          percent: 0.75,
        });

        // Emit Phase 4: Critic Audit
        this.emit("vani://tailor-progress", {
          runId,
          phase: 4,
          step: "Critic verifying fact pool membership and metric safety",
          percent: 1.0,
        });

        const result: VaniTailorResult = {
          runId,
          status: "completed",
          rewrittenContent:
            "= Tailored Resume\n- Architected distributed ingestion pipeline reducing p99 latency by 40% across 50M daily events.",
          atsScore: 92,
          metricsPreserved: true,
          phasesCompleted: 4,
        };
        this.activeRuns.set(runId, { status: "completed", cancelled: false });
        return result;
      }

      case "manvi_approve_action": {
        const approvalId = String(args?.approval_id ?? args?.approvalId ?? "");
        const allow = Boolean(args?.allow ?? true);
        const chosen = args?.chosen ? String(args.chosen) : undefined;
        const pending = this.pendingApprovals.get(approvalId);
        if (pending) {
          pending.resolve({ allow, chosen });
          this.pendingApprovals.delete(approvalId);
        }
        return;
      }

      case "manvi_cancel_run": {
        const runId = String(args?.run_id ?? args?.runId ?? "");
        const run = this.activeRuns.get(runId);
        if (run) {
          run.cancelled = true;
          run.status = "cancelled";
        }
        this.emit("vani://tailor-cancelled", { runId });
        return;
      }

      default:
        return undefined;
    }
  }
}
