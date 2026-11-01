export interface TypstDiagnostic {
  severity: "error" | "warning";
  message: string;
  file: string | null;
  line: number | null;
  column: number | null;
  hints: string[];
}

export interface TypstCompileErrorResponse {
  message: string;
  errors: TypstDiagnostic[];
  warnings: TypstDiagnostic[];
  duration_ms: number;
}

type DiagnosticsListener = (file: string) => void;

class TypstDiagnosticsRegistry {
  private store = new Map<string, TypstDiagnostic[]>();
  private listeners = new Set<DiagnosticsListener>();

  public set(file: string, diags: TypstDiagnostic[]): void {
    const normalized = this.normalize(file);
    this.store.set(normalized, diags);
    this.notify(normalized);
  }

  public get(file: string): TypstDiagnostic[] {
    return this.store.get(this.normalize(file)) ?? [];
  }

  public getAll(): TypstDiagnostic[] {
    const all: TypstDiagnostic[] = [];
    for (const diags of this.store.values()) {
      all.push(...diags);
    }
    return all;
  }

  public clear(file?: string): void {
    if (file) {
      const normalized = this.normalize(file);
      this.store.delete(normalized);
      this.notify(normalized);
    } else {
      this.store.clear();
      for (const listener of this.listeners) listener("*");
    }
  }

  public subscribe(listener: DiagnosticsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private normalize(file: string): string {
    return file.replace(/\\/g, "/").replace(/^\/+/, "");
  }

  private notify(file: string): void {
    for (const listener of this.listeners) listener(file);
  }
}

export const typstDiagnosticsRegistry = new TypstDiagnosticsRegistry();
export const setTypstDiagnostics = (file: string, diags: TypstDiagnostic[]) =>
  typstDiagnosticsRegistry.set(file, diags);
export const getTypstDiagnostics = (file: string) =>
  typstDiagnosticsRegistry.get(file);
export const getAllTypstDiagnostics = () => typstDiagnosticsRegistry.getAll();
export const clearTypstDiagnostics = (file?: string) =>
  typstDiagnosticsRegistry.clear(file);
