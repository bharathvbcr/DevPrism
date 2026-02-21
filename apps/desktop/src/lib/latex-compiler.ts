export interface CompileResource {
  path: string;
  content?: string;
  file?: string;
  main?: boolean;
  encoding?: string;
}

const SIDECAR_URL = "http://localhost:3001";

export async function compileLatex(
  projectDir: string,
  mainFile: string = "document.tex",
): Promise<Uint8Array> {
  const response = await fetch(`${SIDECAR_URL}/builds/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ projectDir, mainFile }),
  });

  if (!response.ok) {
    const data = await response.json();
    const message = data.details
      ? `${data.error}\n\n${data.details}`
      : data.error || "Compilation failed";
    throw new Error(message);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

export interface SynctexResult {
  file: string;
  line: number;
  column: number;
}

export async function synctexEdit(
  projectDir: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexResult | null> {
  try {
    const response = await fetch(`${SIDECAR_URL}/synctex/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectDir, page, x, y }),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export async function compileLatexWithResources(
  resources: CompileResource[],
): Promise<Uint8Array> {
  const response = await fetch(`${SIDECAR_URL}/builds/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ compiler: "pdflatex", resources }),
  });

  if (!response.ok) {
    const data = await response.json();
    const message = data.details
      ? `${data.error}\n\n${data.details}`
      : data.error || "Compilation failed";
    throw new Error(message);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
