import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  source: string;
  message: string;
  data?: unknown;
}

const MAX_ENTRIES = 2000;
const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogStore {
  entries: LogEntry[];
  log: (level: LogLevel, source: string, message: string, data?: unknown) => void;
  getFilteredLogs: (opts?: {
    level?: LogLevel;
    source?: string;
    search?: string;
  }) => LogEntry[];
  exportLogs: () => string;
  clear: () => void;
}

export const useLogStore = create<LogStore>((set, get) => ({
  entries: [],

  log: (level, source, message, data) => {
    // Skip debug-level entries when debug mode is off
    if (level === "debug" && !localStorage.getItem("debug")) return;

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      source,
      message,
      data,
    };

    set((state) => {
      const next = [...state.entries, entry];
      if (next.length > MAX_ENTRIES) {
        next.splice(0, next.length - MAX_ENTRIES);
      }
      return { entries: next };
    });

    // Forward warn/error to Rust stderr via existing js_log command
    if (level === "warn" || level === "error") {
      const prefix = level === "error" ? "ERROR" : "WARN";
      const msg = `[${prefix}][${source}] ${message}${data ? " " + JSON.stringify(data) : ""}`;
      invoke("js_log", { msg }).catch(() => {});
    }
  },

  getFilteredLogs: (opts) => {
    const { entries } = get();
    if (!opts) return entries;

    const { level, source, search } = opts;
    const minLevel = level ? LOG_LEVEL_ORDER[level] : 0;
    const searchLower = search?.toLowerCase();

    return entries.filter((e) => {
      if (LOG_LEVEL_ORDER[e.level] < minLevel) return false;
      if (source && e.source !== source) return false;
      if (searchLower) {
        const haystack = `${e.source} ${e.message}`.toLowerCase();
        if (!haystack.includes(searchLower)) return false;
      }
      return true;
    });
  },

  exportLogs: () => {
    return JSON.stringify(get().entries, null, 2);
  },

  clear: () => set({ entries: [] }),
}));
