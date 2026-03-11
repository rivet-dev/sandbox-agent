import { createBackendClient } from "@sandbox-agent/foundry-client";
import { backendEndpoint, defaultWorkspaceId, frontendClientMode } from "./env";

export const backendClient = createBackendClient({
  endpoint: backendEndpoint,
  defaultWorkspaceId,
  mode: frontendClientMode,
});
