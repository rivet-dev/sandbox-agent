import type { AppConfig } from "@sandbox-agent/foundry-shared";

export function defaultWorkspace(config: AppConfig): string {
  const ws = config.workspace.default.trim();
  return ws.length > 0 ? ws : "default";
}

export function resolveWorkspace(flagWorkspace: string | undefined, config: AppConfig): string {
  if (flagWorkspace && flagWorkspace.trim().length > 0) {
    return flagWorkspace.trim();
  }
  return defaultWorkspace(config);
}
