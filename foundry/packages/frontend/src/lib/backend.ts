import { createBackendClient } from "@sandbox-agent/foundry-client/backend";
import { backendEndpoint, defaultWorkspaceId } from "./env";

export const backendClient = createBackendClient({
  endpoint: backendEndpoint,
  defaultWorkspaceId,
});
