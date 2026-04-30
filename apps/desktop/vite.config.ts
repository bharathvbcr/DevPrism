import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import topLevelAwait from "vite-plugin-top-level-await";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;
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
      "node:fs": path.resolve(__dirname, "src/lib/browser-node-shim.ts"),
      module: path.resolve(__dirname, "src/lib/browser-node-shim.ts"),
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
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
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
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("node_modules/react") ||
            id.includes("node_modules/react-dom")
          ) {
            return "react-vendor";
          }
          if (id.includes("node_modules/@codemirror")) {
            return "codemirror-vendor";
          }
          if (
            id.includes("node_modules/radix-ui") ||
            id.includes("node_modules/@radix-ui")
          ) {
            return "ui-vendor";
          }
          if (id.includes("node_modules/katex")) {
            return "katex-vendor";
          }
          if (id.includes("node_modules/mupdf")) {
            return "mupdf-vendor";
          }
        },
      },
    },
  },
});
