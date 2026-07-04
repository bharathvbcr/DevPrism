import { useEffect } from "react";
import { COMPILE_REQUEST_EVENT } from "@/lib/compile-events";
import { compileActiveProject } from "@/lib/project-compile";

/** Listen for global compile requests (rich editor, command palette, etc.). */
export function useCompileRequest() {
  useEffect(() => {
    const onCompile = () => void compileActiveProject(true);
    window.addEventListener(COMPILE_REQUEST_EVENT, onCompile);
    return () => window.removeEventListener(COMPILE_REQUEST_EVENT, onCompile);
  }, []);
}
