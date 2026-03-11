import { useSyncExternalStore } from "react";
import {
  createFoundryAppClient,
  currentFoundryOrganization,
  currentFoundryUser,
  eligibleFoundryOrganizations,
  type FoundryAppClient,
} from "@sandbox-agent/foundry-client";
import type { FoundryAppSnapshot, FoundryOrganization } from "@sandbox-agent/foundry-shared";
import { backendClient } from "./backend";
import { frontendClientMode } from "./env";

const REMOTE_APP_SESSION_STORAGE_KEY = "sandbox-agent-foundry:remote-app-session";

const appClient: FoundryAppClient = createFoundryAppClient({
  mode: frontendClientMode,
  backend: frontendClientMode === "remote" ? backendClient : undefined,
});

export function useMockAppSnapshot(): FoundryAppSnapshot {
  return useSyncExternalStore(appClient.subscribe.bind(appClient), appClient.getSnapshot.bind(appClient), appClient.getSnapshot.bind(appClient));
}

export function useMockAppClient(): FoundryAppClient {
  return appClient;
}

export const activeMockUser = currentFoundryUser;
export const activeMockOrganization = currentFoundryOrganization;
export const eligibleOrganizations = eligibleFoundryOrganizations;

// Track whether the remote client has delivered its first real snapshot.
// Before the first fetch completes the snapshot is the default empty signed_out state,
// so we show a loading screen.  Once the fetch returns we know the truth.
let firstSnapshotDelivered = false;

// The remote client notifies listeners after refresh(), which sets `firstSnapshotDelivered`.
const origSubscribe = appClient.subscribe.bind(appClient);
appClient.subscribe = (listener: () => void): (() => void) => {
  const wrappedListener = () => {
    firstSnapshotDelivered = true;
    listener();
  };
  return origSubscribe(wrappedListener);
};

export function isAppSnapshotBootstrapping(snapshot: FoundryAppSnapshot): boolean {
  if (frontendClientMode !== "remote" || typeof window === "undefined") {
    return false;
  }

  const hasStoredSession = window.localStorage.getItem(REMOTE_APP_SESSION_STORAGE_KEY)?.trim().length;
  if (!hasStoredSession) {
    return false;
  }

  // If the backend has already responded and we're still signed_out, the session is stale.
  if (firstSnapshotDelivered) {
    return false;
  }

  // Still waiting for the initial fetch — show the loading screen.
  return snapshot.auth.status === "signed_out" && snapshot.users.length === 0 && snapshot.organizations.length === 0;
}

export function getMockOrganizationById(snapshot: FoundryAppSnapshot, organizationId: string): FoundryOrganization | null {
  return snapshot.organizations.find((organization) => organization.id === organizationId) ?? null;
}
