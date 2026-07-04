export const COMPILE_REQUEST_EVENT = "devprism:compile-request";

/** Ask the active LaTeX editor to compile (source or rich view). */
export function requestCompile(): void {
  window.dispatchEvent(new CustomEvent(COMPILE_REQUEST_EVENT));
}
