import type { FrontendErrorContext } from "./types.js";

interface FrontendErrorCollectorGlobal {
  setContext: (context: FrontendErrorContext) => void;
}

declare global {
  interface Window {
    __FOUNDRY_FRONTEND_ERROR_COLLECTOR__?: FrontendErrorCollectorGlobal;
    __FOUNDRY_FRONTEND_ERROR_CONTEXT__?: FrontendErrorContext;
  }
}

export function setFrontendErrorContext(context: FrontendErrorContext): void {
  if (typeof window === "undefined") {
    return;
  }

  const nextContext = sanitizeContext(context);
  window.__FOUNDRY_FRONTEND_ERROR_CONTEXT__ = {
    ...(window.__FOUNDRY_FRONTEND_ERROR_CONTEXT__ ?? {}),
    ...nextContext,
  };
  window.__FOUNDRY_FRONTEND_ERROR_COLLECTOR__?.setContext(nextContext);
}

function sanitizeContext(input: FrontendErrorContext): FrontendErrorContext {
  const output: FrontendErrorContext = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    }
  }
  return output;
}
