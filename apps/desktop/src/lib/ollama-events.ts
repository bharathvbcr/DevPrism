export const OLLAMA_REFRESH_EVENT = "devprism:ollama-refresh";

export function requestOllamaRefresh(): void {
  window.dispatchEvent(new CustomEvent(OLLAMA_REFRESH_EVENT));
}
