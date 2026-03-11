function resolveDefaultBackendEndpoint(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/api/rivet`;
  }
  return "http://127.0.0.1:7741/api/rivet";
}

type FrontendImportMetaEnv = ImportMetaEnv & {
  FOUNDRY_FRONTEND_CLIENT_MODE?: string;
};

const frontendEnv = import.meta.env as FrontendImportMetaEnv;

export const backendEndpoint = import.meta.env.VITE_HF_BACKEND_ENDPOINT?.trim() || resolveDefaultBackendEndpoint();

export const defaultWorkspaceId = import.meta.env.VITE_HF_WORKSPACE?.trim() || "default";

function resolveFrontendClientMode(): "mock" | "remote" {
  const raw = frontendEnv.FOUNDRY_FRONTEND_CLIENT_MODE?.trim().toLowerCase();
  if (raw === "mock") {
    return "mock";
  }
  if (raw === "remote" || raw === "" || raw === undefined) {
    return "remote";
  }
  throw new Error(`Unsupported FOUNDRY_FRONTEND_CLIENT_MODE value "${frontendEnv.FOUNDRY_FRONTEND_CLIENT_MODE}". Expected "mock" or "remote".`);
}

export const frontendClientMode = resolveFrontendClientMode();
export const isMockFrontendClient = frontendClientMode === "mock";
