import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import topLevelAwait from "vite-plugin-top-level-await";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;
const isTauriDev = Boolean(process.env.TAURI_ENV_PLATFORM);
const devPort = process.env.PORT ? Number(process.env.PORT) : 1420;
const strictPort = isTauriDev || Boolean(process.env.PORT);
const mupdfWasmFile = path.resolve(
  __dirname,
  "..",
  "..",
  "node_modules",
  "mupdf",
  "dist",
  "mupdf-wasm.wasm",
);

export default defineConfig({
  plugins: [react(), topLevelAwait()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  define: {
    __MUPDF_WASM_FS_PATH__: JSON.stringify(mupdfWasmFile.replace(/\\/g, "/")),
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["mupdf"],
  },
  clearScreen: false,
  server: {
    port: devPort,
    strictPort,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: devPort + 1,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      output: {
        // Split heavyweight vendor families into their own cacheable chunks.
        // Whole families stay together (never split within a family) to
        // avoid cross-chunk circular-initialization issues.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/mupdf/")) return "mupdf";
          if (
            id.includes("@codemirror") ||
            id.includes("@lezer") ||
            id.includes("@replit/codemirror-vim") ||
            id.includes("codemirror-lang-latex")
          ) {
            return "codemirror";
          }
          if (id.includes("@tiptap") || id.includes("prosemirror-")) {
            return "tiptap";
          }
          if (id.includes("/katex/")) return "katex";
          if (
            id.includes("react-markdown") ||
            id.includes("remark-") ||
            id.includes("rehype-") ||
            id.includes("micromark") ||
            id.includes("mdast-") ||
            id.includes("hast-") ||
            id.includes("/unified/") ||
            id.includes("unist-") ||
            id.includes("vfile")
          ) {
            return "markdown";
          }
          return undefined;
        },
      },
    },
  },
});
