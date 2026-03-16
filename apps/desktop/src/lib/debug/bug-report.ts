import { invoke } from "@tauri-apps/api/core";
import { useLogStore } from "./log-store";

interface SystemInfo {
  os: string;
  os_version: string;
  arch: string;
  app_version: string;
}

function getGpuRenderer(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (gl && gl instanceof WebGLRenderingContext) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) {
        return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
      }
    }
  } catch {
    // ignore
  }
  return "Unknown";
}

/**
 * Generate a JSON bug report containing logs, system info, and render state.
 * Returns a formatted JSON string suitable for clipboard or file export.
 */
export async function generateBugReport(): Promise<string> {
  let systemInfo: SystemInfo | null = null;
  try {
    systemInfo = await invoke<SystemInfo>("get_system_info");
  } catch {
    // Tauri command may not be available in all contexts
  }

  const logEntries = useLogStore.getState().entries;

  // Collect recent visibility events
  const visibilityEvents = logEntries
    .filter((e) => e.source === "app" && e.message.includes("Visibility"))
    .slice(-10);

  const report = {
    generated_at: new Date().toISOString(),
    system: {
      ...systemInfo,
      user_agent: navigator.userAgent,
      device_pixel_ratio: window.devicePixelRatio,
      gpu_renderer: getGpuRenderer(),
      screen: {
        width: screen.width,
        height: screen.height,
        color_depth: screen.colorDepth,
      },
      visibility_state: document.visibilityState,
      window_focused: document.hasFocus(),
    },
    visibility_events: visibilityEvents.map((e) => ({
      timestamp: new Date(e.timestamp).toISOString(),
      message: e.message,
    })),
    logs: logEntries.slice(-500).map((e) => ({
      time: new Date(e.timestamp).toISOString(),
      level: e.level,
      source: e.source,
      message: e.message,
      ...(e.data !== undefined ? { data: e.data } : {}),
    })),
    total_log_entries: logEntries.length,
  };

  return JSON.stringify(report, null, 2);
}
