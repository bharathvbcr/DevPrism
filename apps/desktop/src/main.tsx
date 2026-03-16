import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { createLogger } from "./lib/debug/logger";
import "./styles/globals.css";

const log = createLogger("app");

// Catch unhandled promise rejections to prevent silent failures
window.addEventListener("unhandledrejection", (event) => {
  log.error("Unhandled promise rejection", { reason: String(event.reason) });
});

// Dispatch app-visibility-restored when returning from background / app switch.
// This triggers canvas re-rendering and IntersectionObserver reconnection.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    log.info("Visibility restored (visibilitychange)");
    window.dispatchEvent(new CustomEvent("app-visibility-restored"));
  }
});

// Also listen for the Tauri-native focus event (more reliable than visibilitychange
// on macOS, fires even when the webview doesn't properly emit visibilitychange).
listen("window-focus-restored", () => {
  log.info("Visibility restored (window-focus-restored)");
  window.dispatchEvent(new CustomEvent("app-visibility-restored"));
});

// Platform-specific titlebar height adjustments
if (navigator.userAgent.includes("Windows")) {
  // Windows overlay titlebar is ~12px (title + window controls)
  document.documentElement.style.setProperty("--titlebar-height", "12px");
  document.documentElement.style.setProperty("--traffic-light-width", "0px");
} else if (!navigator.userAgent.includes("Macintosh")) {
  // Linux and others: no overlay titlebar
  document.documentElement.style.setProperty("--titlebar-height", "0px");
  document.documentElement.style.setProperty("--traffic-light-width", "0px");
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App
      onReady={() => {
        // Hide loading screen
        const loading = document.getElementById("loading-screen");
        if (loading) {
          loading.style.opacity = "0";
          setTimeout(() => loading.remove(), 300);
        }
        // Show the Tauri window
        getCurrentWindow().show();
      }}
    />
  </React.StrictMode>,
);
