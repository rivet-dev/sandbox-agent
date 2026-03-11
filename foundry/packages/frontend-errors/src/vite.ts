import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import type { Plugin } from "vite";
import { createFrontendErrorCollectorRouter, defaultFrontendErrorLogPath } from "./router.js";
import { createFrontendErrorCollectorScript } from "./script.js";

const DEFAULT_MOUNT_PATH = "/__foundry/frontend-errors";
const DEFAULT_EVENT_PATH = "/events";

export interface FrontendErrorCollectorVitePluginOptions {
  mountPath?: string;
  logFilePath?: string;
  reporter?: string;
  includeConsoleErrors?: boolean;
  includeFetchErrors?: boolean;
}

export function frontendErrorCollectorVitePlugin(options: FrontendErrorCollectorVitePluginOptions = {}): Plugin {
  const mountPath = normalizePath(options.mountPath ?? DEFAULT_MOUNT_PATH);
  const logFilePath = options.logFilePath ?? defaultFrontendErrorLogPath(process.cwd());
  const reporter = options.reporter ?? "foundry-vite";
  const endpoint = `${mountPath}${DEFAULT_EVENT_PATH}`;

  const router = createFrontendErrorCollectorRouter({
    logFilePath,
    reporter,
  });
  const mountApp = new Hono().route(mountPath, router);
  const listener = getRequestListener(mountApp.fetch);

  return {
    name: "foundry:frontend-error-collector",
    apply: "serve",
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: { type: "module" },
            children: createFrontendErrorCollectorScript({
              endpoint,
              reporter,
              includeConsoleErrors: options.includeConsoleErrors,
              includeFetchErrors: options.includeFetchErrors,
            }),
            injectTo: "head-prepend",
          },
        ],
      };
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(mountPath)) {
          return next();
        }
        void listener(req, res).catch((error) => next(error));
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(mountPath)) {
          return next();
        }
        void listener(req, res).catch((error) => next(error));
      });
    },
  };
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    return `/${path}`;
  }
  return path.replace(/\/+$/, "");
}
