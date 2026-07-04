/** True when the UI runs inside a Tauri webview (not Vite preview / browser). */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}
