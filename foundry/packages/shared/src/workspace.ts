import type { AppConfig } from "./config.js";

export function resolveWorkspaceId(flagWorkspace: string | undefined, config: AppConfig): string {
  if (flagWorkspace && flagWorkspace.trim().length > 0) {
    return flagWorkspace.trim();
  }

  if (config.workspace.default.trim().length > 0) {
    return config.workspace.default.trim();
  }

  return "default";
}
