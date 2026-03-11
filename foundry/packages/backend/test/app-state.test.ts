import { describe, expect, it } from "vitest";
import { setupTest } from "rivetkit/test";
import { registry } from "../src/actors/index.js";
import { workspaceKey } from "../src/actors/keys.js";
import { APP_SHELL_WORKSPACE_ID } from "../src/actors/workspace/app-shell.js";
import { createTestRuntimeContext } from "./helpers/test-context.js";
import { createTestDriver } from "./helpers/test-driver.js";

function createGithubService(overrides?: Record<string, unknown>) {
  return {
    isAppConfigured: () => true,
    isWebhookConfigured: () => false,
    verifyWebhookEvent: () => {
      throw new Error("GitHub webhook not configured in test");
    },
    buildAuthorizeUrl: (state: string) => `https://github.example/login/oauth/authorize?state=${encodeURIComponent(state)}`,
    exchangeCode: async () => ({
      accessToken: "gho_live",
      scopes: ["read:user", "user:email", "read:org"],
    }),
    getViewer: async () => ({
      id: "1001",
      login: "nathan",
      name: "Nathan",
      email: "nathan@acme.dev",
    }),
    listOrganizations: async () => [
      {
        id: "2001",
        login: "acme",
        name: "Acme",
      },
    ],
    listInstallations: async () => [
      {
        id: 3001,
        accountLogin: "acme",
      },
    ],
    listUserRepositories: async () => [
      {
        fullName: "nathan/personal-site",
        cloneUrl: "https://github.com/nathan/personal-site.git",
        private: false,
      },
    ],
    listInstallationRepositories: async () => [
      {
        fullName: "acme/backend",
        cloneUrl: "https://github.com/acme/backend.git",
        private: true,
      },
      {
        fullName: "acme/frontend",
        cloneUrl: "https://github.com/acme/frontend.git",
        private: false,
      },
    ],
    buildInstallationUrl: async () => "https://github.example/apps/sandbox/installations/new",
    ...overrides,
  };
}

function createStripeService(overrides?: Record<string, unknown>) {
  return {
    isConfigured: () => false,
    createCustomer: async () => ({ id: "cus_test" }),
    createCheckoutSession: async () => ({ id: "cs_test", url: "https://billing.example/checkout/cs_test" }),
    retrieveCheckoutCompletion: async () => ({
      customerId: "cus_test",
      subscriptionId: "sub_test",
      planId: "team" as const,
      paymentMethodLabel: "Visa ending in 4242",
    }),
    retrieveSubscription: async () => ({
      id: "sub_test",
      customerId: "cus_test",
      priceId: "price_team",
      status: "active",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: 1741564800,
      trialEnd: null,
      defaultPaymentMethodLabel: "Visa ending in 4242",
    }),
    createPortalSession: async () => ({ url: "https://billing.example/portal" }),
    updateSubscriptionCancellation: async (_subscriptionId: string, cancelAtPeriodEnd: boolean) => ({
      id: "sub_test",
      customerId: "cus_test",
      priceId: "price_team",
      status: "active",
      cancelAtPeriodEnd,
      currentPeriodEnd: 1741564800,
      trialEnd: null,
      defaultPaymentMethodLabel: "Visa ending in 4242",
    }),
    verifyWebhookEvent: (payload: string) => JSON.parse(payload),
    planIdForPriceId: (priceId: string) => (priceId === "price_team" ? ("team" as const) : null),
    ...overrides,
  };
}

async function getAppWorkspace(client: any) {
  return await client.workspace.getOrCreate(workspaceKey(APP_SHELL_WORKSPACE_ID), {
    createWithInput: APP_SHELL_WORKSPACE_ID,
  });
}

describe("app shell actors", () => {
  it("restores a GitHub session and imports repos into actor-owned workspace state", async (t) => {
    createTestRuntimeContext(createTestDriver(), undefined, {
      appUrl: "http://localhost:4173",
      github: createGithubService(),
      stripe: createStripeService(),
    });

    const { client } = await setupTest(t, registry);
    const app = await getAppWorkspace(client);

    const { sessionId } = await app.ensureAppSession({});
    const authStart = await app.startAppGithubAuth({ sessionId });
    const state = new URL(authStart.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callback = await app.completeAppGithubAuth({
      code: "oauth-code",
      state,
    });
    expect(callback.redirectTo).toContain("foundrySession=");

    const snapshot = await app.selectAppOrganization({
      sessionId,
      organizationId: "acme",
    });

    expect(snapshot.auth.status).toBe("signed_in");
    expect(snapshot.activeOrganizationId).toBe("acme");
    expect(snapshot.users[0]?.githubLogin).toBe("nathan");
    expect(snapshot.organizations.map((organization: any) => organization.id)).toEqual(["personal-nathan", "acme"]);

    const acme = snapshot.organizations.find((organization: any) => organization.id === "acme");
    expect(acme.github.syncStatus).toBe("synced");
    expect(acme.github.installationStatus).toBe("connected");
    expect(acme.repoCatalog).toEqual(["acme/backend", "acme/frontend"]);

    const orgWorkspace = await client.workspace.getOrCreate(workspaceKey("acme"), {
      createWithInput: "acme",
    });
    const repos = await orgWorkspace.listRepos({ workspaceId: "acme" });
    expect(repos.map((repo: any) => repo.remoteUrl).sort()).toEqual(["https://github.com/acme/backend.git", "https://github.com/acme/frontend.git"]);
  });

  it("keeps install-required orgs in actor state when the GitHub App installation is missing", async (t) => {
    createTestRuntimeContext(createTestDriver(), undefined, {
      appUrl: "http://localhost:4173",
      github: createGithubService({
        listInstallations: async () => [],
      }),
      stripe: createStripeService(),
    });

    const { client } = await setupTest(t, registry);
    const app = await getAppWorkspace(client);

    const { sessionId } = await app.ensureAppSession({});
    const authStart = await app.startAppGithubAuth({ sessionId });
    const state = new URL(authStart.url).searchParams.get("state");
    await app.completeAppGithubAuth({
      code: "oauth-code",
      state,
    });

    const snapshot = await app.triggerAppRepoImport({
      sessionId,
      organizationId: "acme",
    });

    const acme = snapshot.organizations.find((organization: any) => organization.id === "acme");
    expect(acme.github.installationStatus).toBe("install_required");
    expect(acme.github.syncStatus).toBe("error");
    expect(acme.github.lastSyncLabel).toContain("installation required");
  });

  it("maps Stripe checkout and invoice events back into organization actors", async (t) => {
    createTestRuntimeContext(createTestDriver(), undefined, {
      appUrl: "http://localhost:4173",
      github: createGithubService({
        listInstallationRepositories: async () => [],
      }),
      stripe: createStripeService({
        isConfigured: () => true,
      }),
    });

    const { client } = await setupTest(t, registry);
    const app = await getAppWorkspace(client);

    const { sessionId } = await app.ensureAppSession({});
    const authStart = await app.startAppGithubAuth({ sessionId });
    const state = new URL(authStart.url).searchParams.get("state");
    await app.completeAppGithubAuth({
      code: "oauth-code",
      state,
    });

    const checkout = await app.createAppCheckoutSession({
      sessionId,
      organizationId: "acme",
      planId: "team",
    });
    expect(checkout.url).toBe("https://billing.example/checkout/cs_test");

    const completion = await app.finalizeAppCheckoutSession({
      sessionId,
      organizationId: "acme",
      checkoutSessionId: "cs_test",
    });
    expect(completion.redirectTo).toContain("/organizations/acme/billing");

    await app.handleAppStripeWebhook({
      payload: JSON.stringify({
        id: "evt_1",
        type: "invoice.paid",
        data: {
          object: {
            id: "in_1",
            customer: "cus_test",
            number: "0001",
            amount_paid: 24000,
            created: 1741564800,
          },
        },
      }),
      signatureHeader: "sig",
    });

    const snapshot = await app.getAppSnapshot({ sessionId });
    const acme = snapshot.organizations.find((organization: any) => organization.id === "acme");
    expect(acme.billing.planId).toBe("team");
    expect(acme.billing.status).toBe("active");
    expect(acme.billing.paymentMethodLabel).toBe("Visa ending in 4242");
    expect(acme.billing.invoices[0]).toMatchObject({
      id: "in_1",
      amountUsd: 240,
      status: "paid",
    });
  });
});
