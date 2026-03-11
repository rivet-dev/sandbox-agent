import type { ProviderId } from "@sandbox-agent/foundry-shared";
import type { AppConfig } from "@sandbox-agent/foundry-shared";
import type { BackendDriver } from "../driver.js";
import { DaytonaProvider } from "./daytona/index.js";
import { LocalProvider } from "./local/index.js";
import type { SandboxProvider } from "./provider-api/index.js";

export interface ProviderRegistry {
  get(providerId: ProviderId): SandboxProvider;
  availableProviderIds(): ProviderId[];
  defaultProviderId(): ProviderId;
}

export function createProviderRegistry(config: AppConfig, driver?: BackendDriver): ProviderRegistry {
  const gitDriver = driver?.git ?? {
    validateRemote: async () => {
      throw new Error("local provider requires backend git driver");
    },
    ensureCloned: async () => {
      throw new Error("local provider requires backend git driver");
    },
    fetch: async () => {
      throw new Error("local provider requires backend git driver");
    },
    listRemoteBranches: async () => {
      throw new Error("local provider requires backend git driver");
    },
    remoteDefaultBaseRef: async () => {
      throw new Error("local provider requires backend git driver");
    },
    revParse: async () => {
      throw new Error("local provider requires backend git driver");
    },
    ensureRemoteBranch: async () => {
      throw new Error("local provider requires backend git driver");
    },
    diffStatForBranch: async () => {
      throw new Error("local provider requires backend git driver");
    },
    conflictsWithMain: async () => {
      throw new Error("local provider requires backend git driver");
    },
  };

  const local = new LocalProvider(
    {
      rootDir: config.providers.local.rootDir,
      sandboxAgentPort: config.providers.local.sandboxAgentPort,
    },
    gitDriver,
  );
  const daytona = new DaytonaProvider(
    {
      endpoint: config.providers.daytona.endpoint,
      apiKey: config.providers.daytona.apiKey,
      image: config.providers.daytona.image,
    },
    driver?.daytona,
  );

  const map: Record<ProviderId, SandboxProvider> = {
    local,
    daytona,
  };

  return {
    get(providerId: ProviderId): SandboxProvider {
      return map[providerId];
    },
    availableProviderIds(): ProviderId[] {
      return Object.keys(map) as ProviderId[];
    },
    defaultProviderId(): ProviderId {
      return config.providers.daytona.apiKey ? "daytona" : "local";
    },
  };
}
