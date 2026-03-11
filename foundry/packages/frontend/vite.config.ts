import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import { frontendErrorCollectorVitePlugin } from "@sandbox-agent/foundry-frontend-errors/vite";

const backendProxyTarget = process.env.HF_BACKEND_HTTP?.trim() || "http://127.0.0.1:7741";
const cacheDir = process.env.HF_VITE_CACHE_DIR?.trim() || undefined;
const frontendClientMode = process.env.FOUNDRY_FRONTEND_CLIENT_MODE?.trim() || "remote";
const rivetkitClientEntry = realpathSync(fileURLToPath(new URL("../client/node_modules/rivetkit/dist/browser/client.js", import.meta.url)));
const rivetkitPackageRoot = dirname(dirname(dirname(rivetkitClientEntry)));
export default defineConfig({
  define: {
    "import.meta.env.FOUNDRY_FRONTEND_CLIENT_MODE": JSON.stringify(frontendClientMode),
  },
  plugins: [react(), frontendErrorCollectorVitePlugin()],
  cacheDir,
  resolve: {
    alias: {
      "rivetkit/client": rivetkitClientEntry,
      "@workbench-runtime": fileURLToPath(
        new URL(frontendClientMode === "mock" ? "./src/lib/workbench-runtime.mock.ts" : "./src/lib/workbench-runtime.remote.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 4173,
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), rivetkitPackageRoot],
    },
    proxy: {
      "/api/rivet": {
        target: backendProxyTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
});
