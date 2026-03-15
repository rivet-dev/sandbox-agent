import { and, asc, count as sqlCount, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, notInArray, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  FoundryAppSnapshot,
  FoundryBillingPlanId,
  FoundryBillingState,
  FoundryOrganization,
  FoundryOrganizationMember,
  FoundryUser,
  UpdateFoundryOrganizationProfileInput,
} from "@sandbox-agent/foundry-shared";
import { getActorRuntimeContext } from "../context.js";
import { getOrCreateGithubData, getOrCreateOrganization, selfOrganization } from "../handles.js";
import { GitHubAppError } from "../../services/app-github.js";
import { getBetterAuthService } from "../../services/better-auth.js";
import { repoIdFromRemote, repoLabelFromRemote } from "../../services/repo.js";
import { logger } from "../../logging.js";
import {
  authAccountIndex,
  authEmailIndex,
  authSessionIndex,
  authVerification,
  invoices,
  organizationMembers,
  organizationProfile,
  repos,
  seatAssignments,
  stripeLookup,
} from "./db/schema.js";

export const APP_SHELL_ORGANIZATION_ID = "app";

// ── Better Auth adapter where-clause helpers ──
// These convert the adapter's `{ field, value, operator }` clause arrays into
// Drizzle predicates for organization-level auth index / verification tables.

function organizationAuthColumn(table: any, field: string): any {
  const column = table[field];
  if (!column) {
    throw new Error(`Unknown auth table field: ${field}`);
  }
  return column;
}

function normalizeAuthValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeAuthValue(entry));
  }
  return value;
}

function organizationAuthClause(table: any, clause: { field: string; value: unknown; operator?: string }): any {
  const column = organizationAuthColumn(table, clause.field);
  const value = normalizeAuthValue(clause.value);
  switch (clause.operator) {
    case "ne":
      return value === null ? isNotNull(column) : ne(column, value as any);
    case "lt":
      return lt(column, value as any);
    case "lte":
      return lte(column, value as any);
    case "gt":
      return gt(column, value as any);
    case "gte":
      return gte(column, value as any);
    case "in":
      return inArray(column, Array.isArray(value) ? (value as any[]) : [value as any]);
    case "not_in":
      return notInArray(column, Array.isArray(value) ? (value as any[]) : [value as any]);
    case "contains":
      return like(column, `%${String(value ?? "")}%`);
    case "starts_with":
      return like(column, `${String(value ?? "")}%`);
    case "ends_with":
      return like(column, `%${String(value ?? "")}`);
    case "eq":
    default:
      return value === null ? isNull(column) : eq(column, value as any);
  }
}

function organizationAuthWhere(table: any, clauses: any[] | undefined): any {
  if (!clauses || clauses.length === 0) {
    return undefined;
  }
  let expr = organizationAuthClause(table, clauses[0]);
  for (const clause of clauses.slice(1)) {
    const next = organizationAuthClause(table, clause);
    expr = clause.connector === "OR" ? or(expr, next) : and(expr, next);
  }
  return expr;
}

const githubWebhookLogger = logger.child({
  scope: "github-webhook",
});

const PROFILE_ROW_ID = "profile";

function roundDurationMs(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100;
}

function assertAppOrganization(c: any): void {
  if (c.state.organizationId !== APP_SHELL_ORGANIZATION_ID) {
    throw new Error(`App shell action requires organization ${APP_SHELL_ORGANIZATION_ID}, got ${c.state.organizationId}`);
  }
}

function assertOrganizationShell(c: any): void {
  if (c.state.organizationId === APP_SHELL_ORGANIZATION_ID) {
    throw new Error("Organization action cannot run on the reserved app organization");
  }
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function personalOrganizationId(login: string): string {
  return `personal-${slugify(login)}`;
}

function organizationOrganizationId(kind: FoundryOrganization["kind"], login: string): string {
  return kind === "personal" ? personalOrganizationId(login) : slugify(login);
}

function hasRepoScope(scopes: string[]): boolean {
  return scopes.some((scope) => scope === "repo" || scope.startsWith("repo:"));
}

function parseEligibleOrganizationIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

function encodeEligibleOrganizationIds(value: string[]): string {
  return JSON.stringify([...new Set(value)]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seatsIncludedForPlan(planId: FoundryBillingPlanId): number {
  switch (planId) {
    case "free":
      return 1;
    case "team":
      return 5;
  }
}

function stripeStatusToBillingStatus(stripeStatus: string, cancelAtPeriodEnd: boolean): FoundryBillingState["status"] {
  if (cancelAtPeriodEnd) {
    return "scheduled_cancel";
  }
  if (stripeStatus === "trialing") {
    return "trialing";
  }
  if (stripeStatus === "past_due" || stripeStatus === "unpaid" || stripeStatus === "incomplete") {
    return "past_due";
  }
  return "active";
}

function formatUnixDate(value: number): string {
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function legacyRepoImportStatusToGithubSyncStatus(value: string | null | undefined): FoundryOrganization["github"]["syncStatus"] {
  switch (value) {
    case "ready":
      return "synced";
    case "importing":
      return "syncing";
    default:
      return "pending";
  }
}

function stringFromMetadata(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stripeWebhookSubscription(event: any) {
  const object = event.data.object as Record<string, unknown>;
  const items = (object.items as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
  const price = items[0]?.price as Record<string, unknown> | undefined;
  return {
    id: typeof object.id === "string" ? object.id : "",
    customerId: typeof object.customer === "string" ? object.customer : "",
    priceId: typeof price?.id === "string" ? price.id : null,
    status: typeof object.status === "string" ? object.status : "active",
    cancelAtPeriodEnd: object.cancel_at_period_end === true,
    currentPeriodEnd: typeof object.current_period_end === "number" ? object.current_period_end : null,
    trialEnd: typeof object.trial_end === "number" ? object.trial_end : null,
    defaultPaymentMethodLabel: "Payment method on file",
  };
}

async function getOrganizationState(organization: any) {
  return await organization.getOrganizationShellState({});
}

async function getOrganizationStateIfInitialized(organization: any) {
  return await organization.getOrganizationShellStateIfInitialized({});
}

async function listSnapshotOrganizations(c: any, sessionId: string, organizationIds: string[]) {
  const results = await Promise.all(
    organizationIds.map(async (organizationId) => {
      const organizationStartedAt = performance.now();
      try {
        const organization = await getOrCreateOrganization(c, organizationId);
        const organizationState = await getOrganizationStateIfInitialized(organization);
        if (!organizationState) {
          logger.warn(
            {
              sessionId,
              actorOrganizationId: c.state.organizationId,
              organizationId,
              durationMs: roundDurationMs(organizationStartedAt),
            },
            "build_app_snapshot_organization_uninitialized",
          );
          return { organizationId, snapshot: null, status: "uninitialized" as const };
        }
        logger.info(
          {
            sessionId,
            actorOrganizationId: c.state.organizationId,
            organizationId,
            durationMs: roundDurationMs(organizationStartedAt),
          },
          "build_app_snapshot_organization_completed",
        );
        return { organizationId, snapshot: organizationState.snapshot, status: "ok" as const };
      } catch (error) {
        const message = errorMessage(error);
        if (!message.includes("Actor not found")) {
          logger.error(
            {
              sessionId,
              actorOrganizationId: c.state.organizationId,
              organizationId,
              durationMs: roundDurationMs(organizationStartedAt),
              errorMessage: message,
              errorStack: error instanceof Error ? error.stack : undefined,
            },
            "build_app_snapshot_organization_failed",
          );
          throw error;
        }
        logger.info(
          {
            sessionId,
            actorOrganizationId: c.state.organizationId,
            organizationId,
            durationMs: roundDurationMs(organizationStartedAt),
          },
          "build_app_snapshot_organization_missing",
        );
        return { organizationId, snapshot: null, status: "missing" as const };
      }
    }),
  );

  return {
    organizations: results.map((result) => result.snapshot).filter((organization): organization is FoundryOrganization => organization !== null),
    uninitializedOrganizationIds: results.filter((result) => result.status === "uninitialized").map((result) => result.organizationId),
  };
}

async function buildAppSnapshot(c: any, sessionId: string, allowOrganizationRepair = true): Promise<FoundryAppSnapshot> {
  assertAppOrganization(c);
  const startedAt = performance.now();
  const auth = getBetterAuthService();
  let authState = await auth.getAuthState(sessionId);
  // Inline fallback: if the user is signed in but has no eligible organizations yet
  // (e.g. first load after OAuth callback), sync GitHub orgs before building the snapshot.
  if (authState?.user && parseEligibleOrganizationIds(authState.profile?.eligibleOrganizationIdsJson ?? "[]").length === 0) {
    const token = await auth.getAccessTokenForSession(sessionId);
    if (token?.accessToken) {
      logger.info({ sessionId }, "build_app_snapshot_sync_orgs");
      await syncGithubOrganizations(c, { sessionId, accessToken: token.accessToken });
      authState = await auth.getAuthState(sessionId);
    } else {
      logger.warn({ sessionId }, "build_app_snapshot_no_access_token");
    }
  }

  const session = authState?.session ?? null;
  const user = authState?.user ?? null;
  const profile = authState?.profile ?? null;
  const currentSessionState = authState?.sessionState ?? null;
  const githubAccount = authState?.accounts?.find((account: any) => account.providerId === "github") ?? null;
  const eligibleOrganizationIds = parseEligibleOrganizationIds(profile?.eligibleOrganizationIdsJson ?? "[]");

  logger.info(
    {
      sessionId,
      organizationId: c.state.organizationId,
      eligibleOrganizationCount: eligibleOrganizationIds.length,
      eligibleOrganizationIds,
    },
    "build_app_snapshot_started",
  );

  let { organizations, uninitializedOrganizationIds } = await listSnapshotOrganizations(c, sessionId, eligibleOrganizationIds);

  if (allowOrganizationRepair && uninitializedOrganizationIds.length > 0) {
    const token = await auth.getAccessTokenForSession(sessionId);
    if (token?.accessToken) {
      logger.info(
        {
          sessionId,
          organizationId: c.state.organizationId,
          organizationIds: uninitializedOrganizationIds,
        },
        "build_app_snapshot_repairing_organizations",
      );
      await syncGithubOrganizationsInternal(c, { sessionId, accessToken: token.accessToken }, { broadcast: false });
      return await buildAppSnapshot(c, sessionId, false);
    }
    logger.warn(
      {
        sessionId,
        organizationId: c.state.organizationId,
        organizationIds: uninitializedOrganizationIds,
      },
      "build_app_snapshot_repair_skipped_no_access_token",
    );
  }

  const currentUser: FoundryUser | null = user
    ? {
        id: profile?.githubAccountId ?? githubAccount?.accountId ?? user.id,
        name: user.name,
        email: user.email,
        githubLogin: profile?.githubLogin ?? "",
        roleLabel: profile?.roleLabel ?? "GitHub user",
        eligibleOrganizationIds,
      }
    : null;

  const activeOrganizationId =
    currentUser &&
    currentSessionState?.activeOrganizationId &&
    organizations.some((organization) => organization.id === currentSessionState.activeOrganizationId)
      ? currentSessionState.activeOrganizationId
      : currentUser && organizations.length === 1
        ? (organizations[0]?.id ?? null)
        : null;

  const snapshot: FoundryAppSnapshot = {
    auth: {
      status: currentUser ? "signed_in" : "signed_out",
      currentUserId: currentUser?.id ?? null,
    },
    activeOrganizationId,
    onboarding: {
      starterRepo: {
        repoFullName: "rivet-dev/sandbox-agent",
        repoUrl: "https://github.com/rivet-dev/sandbox-agent",
        status: profile?.starterRepoStatus ?? "pending",
        starredAt: profile?.starterRepoStarredAt ?? null,
        skippedAt: profile?.starterRepoSkippedAt ?? null,
      },
    },
    users: currentUser ? [currentUser] : [],
    organizations,
  };

  logger.info(
    {
      sessionId,
      organizationId: c.state.organizationId,
      eligibleOrganizationCount: eligibleOrganizationIds.length,
      organizationCount: organizations.length,
      durationMs: roundDurationMs(startedAt),
    },
    "build_app_snapshot_completed",
  );

  return snapshot;
}

async function requireSignedInSession(c: any, sessionId: string) {
  const auth = getBetterAuthService();
  const authState = await auth.getAuthState(sessionId);
  const user = authState?.user ?? null;
  const profile = authState?.profile ?? null;
  const githubAccount = authState?.accounts?.find((account: any) => account.providerId === "github") ?? null;
  if (!authState?.session || !user?.email) {
    throw new Error("User must be signed in");
  }
  const token = await auth.getAccessTokenForSession(sessionId);
  return {
    ...authState.session,
    authUserId: user.id,
    currentUserId: profile?.githubAccountId ?? githubAccount?.accountId ?? user.id,
    currentUserName: user.name,
    currentUserEmail: user.email,
    currentUserGithubLogin: profile?.githubLogin ?? "",
    currentUserRoleLabel: profile?.roleLabel ?? "GitHub user",
    eligibleOrganizationIdsJson: profile?.eligibleOrganizationIdsJson ?? "[]",
    githubAccessToken: token?.accessToken ?? null,
    githubScope: (token?.scopes ?? []).join(","),
    starterRepoStatus: profile?.starterRepoStatus ?? "pending",
    starterRepoStarredAt: profile?.starterRepoStarredAt ?? null,
    starterRepoSkippedAt: profile?.starterRepoSkippedAt ?? null,
  };
}

function requireEligibleOrganization(session: any, organizationId: string): void {
  const eligibleOrganizationIds = parseEligibleOrganizationIds(session.eligibleOrganizationIdsJson);
  if (!eligibleOrganizationIds.includes(organizationId)) {
    throw new Error(`Organization ${organizationId} is not available in this app session`);
  }
}

async function upsertStripeLookupEntries(c: any, organizationId: string, customerId: string | null, subscriptionId: string | null): Promise<void> {
  assertAppOrganization(c);
  const now = Date.now();
  for (const lookupKey of [customerId ? `customer:${customerId}` : null, subscriptionId ? `subscription:${subscriptionId}` : null]) {
    if (!lookupKey) {
      continue;
    }
    await c.db
      .insert(stripeLookup)
      .values({
        lookupKey,
        organizationId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: stripeLookup.lookupKey,
        set: {
          organizationId,
          updatedAt: now,
        },
      })
      .run();
  }
}

async function findOrganizationIdForStripeEvent(c: any, customerId: string | null, subscriptionId: string | null): Promise<string | null> {
  assertAppOrganization(c);
  const customerLookup = customerId
    ? await c.db
        .select({ organizationId: stripeLookup.organizationId })
        .from(stripeLookup)
        .where(eq(stripeLookup.lookupKey, `customer:${customerId}`))
        .get()
    : null;
  if (customerLookup?.organizationId) {
    return customerLookup.organizationId;
  }

  const subscriptionLookup = subscriptionId
    ? await c.db
        .select({ organizationId: stripeLookup.organizationId })
        .from(stripeLookup)
        .where(eq(stripeLookup.lookupKey, `subscription:${subscriptionId}`))
        .get()
    : null;
  return subscriptionLookup?.organizationId ?? null;
}

async function safeListOrganizations(accessToken: string): Promise<any[]> {
  const { appShell } = getActorRuntimeContext();
  try {
    return await appShell.github.listOrganizations(accessToken);
  } catch (error) {
    if (error instanceof GitHubAppError && error.status === 403) {
      return [];
    }
    throw error;
  }
}

async function safeListInstallations(accessToken: string): Promise<any[]> {
  const { appShell } = getActorRuntimeContext();
  try {
    return await appShell.github.listInstallations(accessToken);
  } catch (error) {
    if (error instanceof GitHubAppError && (error.status === 403 || error.status === 404)) {
      return [];
    }
    throw error;
  }
}

/**
 * Slow path: list GitHub orgs + installations, sync each org organization,
 * and update the session's eligible organization list. Called from the
 * workflow queue so it runs in the background after the callback has
 * already returned a redirect to the browser.
 */
export async function syncGithubOrganizations(c: any, input: { sessionId: string; accessToken: string }): Promise<void> {
  await syncGithubOrganizationsInternal(c, input, { broadcast: true });
}

async function syncGithubOrganizationsInternal(c: any, input: { sessionId: string; accessToken: string }, options: { broadcast: boolean }): Promise<void> {
  assertAppOrganization(c);
  const auth = getBetterAuthService();
  const { appShell } = getActorRuntimeContext();
  const { sessionId, accessToken } = input;
  const authState = await auth.getAuthState(sessionId);
  if (!authState?.user) {
    throw new Error("User must be signed in");
  }
  const viewer = await appShell.github.getViewer(accessToken);
  const organizations = await safeListOrganizations(accessToken);
  const installations = await safeListInstallations(accessToken);
  const authUserId = authState.user.id;
  const githubUserId = String(viewer.id);

  const linkedOrganizationIds: string[] = [];
  const accounts = [
    {
      githubAccountId: viewer.id,
      githubLogin: viewer.login,
      githubAccountType: "User",
      kind: "personal" as const,
      displayName: viewer.name || viewer.login,
    },
    ...organizations.map((organization) => ({
      githubAccountId: organization.id,
      githubLogin: organization.login,
      githubAccountType: "Organization",
      kind: "organization" as const,
      displayName: organization.name || organization.login,
    })),
  ];

  for (const account of accounts) {
    const organizationId = organizationOrganizationId(account.kind, account.githubLogin);
    const installation = installations.find((candidate) => candidate.accountLogin === account.githubLogin) ?? null;
    const organization = await getOrCreateOrganization(c, organizationId);
    await organization.syncOrganizationShellFromGithub({
      userId: githubUserId,
      userName: viewer.name || viewer.login,
      userEmail: viewer.email ?? `${viewer.login}@users.noreply.github.com`,
      githubUserLogin: viewer.login,
      githubAccountId: account.githubAccountId,
      githubLogin: account.githubLogin,
      githubAccountType: account.githubAccountType,
      kind: account.kind,
      displayName: account.displayName,
      installationId: installation?.id ?? null,
      appConfigured: appShell.github.isAppConfigured(),
    });
    linkedOrganizationIds.push(organizationId);
  }

  const activeOrganizationId =
    authState.sessionState?.activeOrganizationId && linkedOrganizationIds.includes(authState.sessionState.activeOrganizationId)
      ? authState.sessionState.activeOrganizationId
      : linkedOrganizationIds.length === 1
        ? (linkedOrganizationIds[0] ?? null)
        : null;

  await auth.setActiveOrganization(sessionId, activeOrganizationId);
  await auth.upsertUserProfile(authUserId, {
    githubAccountId: String(viewer.id),
    githubLogin: viewer.login,
    roleLabel: "GitHub user",
    eligibleOrganizationIdsJson: encodeEligibleOrganizationIds(linkedOrganizationIds),
  });
  if (!options.broadcast) {
    return;
  }
  c.broadcast("appUpdated", {
    type: "appUpdated",
    snapshot: await buildAppSnapshot(c, sessionId),
  });
}

async function readOrganizationProfileRow(c: any) {
  assertOrganizationShell(c);
  return await c.db.select().from(organizationProfile).where(eq(organizationProfile.id, PROFILE_ROW_ID)).get();
}

async function requireOrganizationProfileRow(c: any) {
  const row = await readOrganizationProfileRow(c);
  if (!row) {
    throw new Error(`Organization profile is not initialized for organization ${c.state.organizationId}`);
  }
  return row;
}

async function listOrganizationMembers(c: any): Promise<FoundryOrganizationMember[]> {
  assertOrganizationShell(c);
  const rows = await c.db.select().from(organizationMembers).orderBy(organizationMembers.role, organizationMembers.name).all();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    state: row.state,
  }));
}

async function listOrganizationSeatAssignments(c: any): Promise<string[]> {
  assertOrganizationShell(c);
  const rows = await c.db.select({ email: seatAssignments.email }).from(seatAssignments).orderBy(seatAssignments.email).all();
  return rows.map((row) => row.email);
}

async function listOrganizationInvoices(c: any): Promise<FoundryBillingState["invoices"]> {
  assertOrganizationShell(c);
  const rows = await c.db.select().from(invoices).orderBy(desc(invoices.issuedAt), desc(invoices.createdAt)).all();
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    issuedAt: row.issuedAt,
    amountUsd: row.amountUsd,
    status: row.status,
  }));
}

async function listOrganizationRepoCatalog(c: any): Promise<string[]> {
  assertOrganizationShell(c);
  const rows = await c.db.select({ remoteUrl: repos.remoteUrl }).from(repos).orderBy(desc(repos.updatedAt)).all();
  return rows.map((row) => repoLabelFromRemote(row.remoteUrl)).sort((left, right) => left.localeCompare(right));
}

async function buildOrganizationState(c: any) {
  const startedAt = performance.now();
  const row = await requireOrganizationProfileRow(c);
  return await buildOrganizationStateFromRow(c, row, startedAt);
}

async function buildOrganizationStateIfInitialized(c: any) {
  const startedAt = performance.now();
  const row = await readOrganizationProfileRow(c);
  if (!row) {
    return null;
  }
  return await buildOrganizationStateFromRow(c, row, startedAt);
}

async function buildOrganizationStateFromRow(c: any, row: any, startedAt: number) {
  const repoCatalog = await listOrganizationRepoCatalog(c);
  const members = await listOrganizationMembers(c);
  const seatAssignmentEmails = await listOrganizationSeatAssignments(c);
  const invoiceRows = await listOrganizationInvoices(c);

  const state = {
    id: c.state.organizationId,
    organizationId: c.state.organizationId,
    kind: row.kind,
    githubLogin: row.githubLogin,
    githubInstallationId: row.githubInstallationId ?? null,
    stripeCustomerId: row.stripeCustomerId ?? null,
    stripeSubscriptionId: row.stripeSubscriptionId ?? null,
    stripePriceId: row.stripePriceId ?? null,
    billingPlanId: row.billingPlanId,
    snapshot: {
      id: c.state.organizationId,
      organizationId: c.state.organizationId,
      kind: row.kind,
      settings: {
        displayName: row.displayName,
        slug: row.slug,
        primaryDomain: row.primaryDomain,
        seatAccrualMode: "first_prompt",
        defaultModel: row.defaultModel,
        autoImportRepos: row.autoImportRepos === 1,
      },
      github: {
        connectedAccount: row.githubConnectedAccount,
        installationStatus: row.githubInstallationStatus,
        syncStatus: row.githubSyncStatus ?? legacyRepoImportStatusToGithubSyncStatus(row.repoImportStatus),
        importedRepoCount: repoCatalog.length,
        lastSyncLabel: row.githubLastSyncLabel,
        lastSyncAt: row.githubLastSyncAt ?? null,
        lastWebhookAt: row.githubLastWebhookAt ?? null,
        lastWebhookEvent: row.githubLastWebhookEvent ?? "",
      },
      billing: {
        planId: row.billingPlanId,
        status: row.billingStatus,
        seatsIncluded: row.billingSeatsIncluded,
        trialEndsAt: row.billingTrialEndsAt,
        renewalAt: row.billingRenewalAt,
        stripeCustomerId: row.stripeCustomerId ?? "",
        paymentMethodLabel: row.billingPaymentMethodLabel,
        invoices: invoiceRows,
      },
      members,
      seatAssignments: seatAssignmentEmails,
      repoCatalog,
    },
  };

  logger.info(
    {
      organizationId: c.state.organizationId,
      githubLogin: row.githubLogin,
      repoCount: repoCatalog.length,
      memberCount: members.length,
      seatAssignmentCount: seatAssignmentEmails.length,
      invoiceCount: invoiceRows.length,
      durationMs: roundDurationMs(startedAt),
    },
    "build_organization_state_completed",
  );

  return state;
}

async function applySubscriptionState(
  organization: any,
  subscription: {
    id: string;
    customerId: string;
    priceId: string | null;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: number | null;
    trialEnd: number | null;
    defaultPaymentMethodLabel: string;
  },
  fallbackPlanId: FoundryBillingPlanId,
): Promise<void> {
  await organization.applyOrganizationStripeSubscription({
    subscription,
    fallbackPlanId,
  });
}

export const organizationAppActions = {
  async authFindSessionIndex(c: any, input: { sessionId?: string; sessionToken?: string }) {
    assertAppOrganization(c);

    const clauses = [
      ...(input.sessionId ? [{ field: "sessionId", value: input.sessionId }] : []),
      ...(input.sessionToken ? [{ field: "sessionToken", value: input.sessionToken }] : []),
    ];
    if (clauses.length === 0) {
      return null;
    }
    const predicate = organizationAuthWhere(authSessionIndex, clauses);
    return await c.db.select().from(authSessionIndex).where(predicate!).get();
  },

  async authUpsertSessionIndex(c: any, input: { sessionId: string; sessionToken: string; userId: string }) {
    assertAppOrganization(c);

    const now = Date.now();
    await c.db
      .insert(authSessionIndex)
      .values({
        sessionId: input.sessionId,
        sessionToken: input.sessionToken,
        userId: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: authSessionIndex.sessionId,
        set: {
          sessionToken: input.sessionToken,
          userId: input.userId,
          updatedAt: now,
        },
      })
      .run();
    return await c.db.select().from(authSessionIndex).where(eq(authSessionIndex.sessionId, input.sessionId)).get();
  },

  async authDeleteSessionIndex(c: any, input: { sessionId?: string; sessionToken?: string }) {
    assertAppOrganization(c);

    const clauses = [
      ...(input.sessionId ? [{ field: "sessionId", value: input.sessionId }] : []),
      ...(input.sessionToken ? [{ field: "sessionToken", value: input.sessionToken }] : []),
    ];
    if (clauses.length === 0) {
      return;
    }
    const predicate = organizationAuthWhere(authSessionIndex, clauses);
    await c.db.delete(authSessionIndex).where(predicate!).run();
  },

  async authFindEmailIndex(c: any, input: { email: string }) {
    assertAppOrganization(c);

    return await c.db.select().from(authEmailIndex).where(eq(authEmailIndex.email, input.email)).get();
  },

  async authUpsertEmailIndex(c: any, input: { email: string; userId: string }) {
    assertAppOrganization(c);

    const now = Date.now();
    await c.db
      .insert(authEmailIndex)
      .values({
        email: input.email,
        userId: input.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: authEmailIndex.email,
        set: {
          userId: input.userId,
          updatedAt: now,
        },
      })
      .run();
    return await c.db.select().from(authEmailIndex).where(eq(authEmailIndex.email, input.email)).get();
  },

  async authDeleteEmailIndex(c: any, input: { email: string }) {
    assertAppOrganization(c);

    await c.db.delete(authEmailIndex).where(eq(authEmailIndex.email, input.email)).run();
  },

  async authFindAccountIndex(c: any, input: { id?: string; providerId?: string; accountId?: string }) {
    assertAppOrganization(c);

    if (input.id) {
      return await c.db.select().from(authAccountIndex).where(eq(authAccountIndex.id, input.id)).get();
    }
    if (!input.providerId || !input.accountId) {
      return null;
    }
    return await c.db
      .select()
      .from(authAccountIndex)
      .where(and(eq(authAccountIndex.providerId, input.providerId), eq(authAccountIndex.accountId, input.accountId)))
      .get();
  },

  async authUpsertAccountIndex(c: any, input: { id: string; providerId: string; accountId: string; userId: string }) {
    assertAppOrganization(c);

    const now = Date.now();
    await c.db
      .insert(authAccountIndex)
      .values({
        id: input.id,
        providerId: input.providerId,
        accountId: input.accountId,
        userId: input.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: authAccountIndex.id,
        set: {
          providerId: input.providerId,
          accountId: input.accountId,
          userId: input.userId,
          updatedAt: now,
        },
      })
      .run();
    return await c.db.select().from(authAccountIndex).where(eq(authAccountIndex.id, input.id)).get();
  },

  async authDeleteAccountIndex(c: any, input: { id?: string; providerId?: string; accountId?: string }) {
    assertAppOrganization(c);

    if (input.id) {
      await c.db.delete(authAccountIndex).where(eq(authAccountIndex.id, input.id)).run();
      return;
    }
    if (input.providerId && input.accountId) {
      await c.db
        .delete(authAccountIndex)
        .where(and(eq(authAccountIndex.providerId, input.providerId), eq(authAccountIndex.accountId, input.accountId)))
        .run();
    }
  },

  async authCreateVerification(c: any, input: { data: Record<string, unknown> }) {
    assertAppOrganization(c);

    await c.db
      .insert(authVerification)
      .values(input.data as any)
      .run();
    return await c.db
      .select()
      .from(authVerification)
      .where(eq(authVerification.id, input.data.id as string))
      .get();
  },

  async authFindOneVerification(c: any, input: { where: any[] }) {
    assertAppOrganization(c);

    const predicate = organizationAuthWhere(authVerification, input.where);
    return predicate ? await c.db.select().from(authVerification).where(predicate).get() : null;
  },

  async authFindManyVerification(c: any, input: { where?: any[]; limit?: number; sortBy?: any; offset?: number }) {
    assertAppOrganization(c);

    const predicate = organizationAuthWhere(authVerification, input.where);
    let query = c.db.select().from(authVerification);
    if (predicate) {
      query = query.where(predicate);
    }
    if (input.sortBy?.field) {
      const column = organizationAuthColumn(authVerification, input.sortBy.field);
      query = query.orderBy(input.sortBy.direction === "asc" ? asc(column) : desc(column));
    }
    if (typeof input.limit === "number") {
      query = query.limit(input.limit);
    }
    if (typeof input.offset === "number") {
      query = query.offset(input.offset);
    }
    return await query.all();
  },

  async authUpdateVerification(c: any, input: { where: any[]; update: Record<string, unknown> }) {
    assertAppOrganization(c);

    const predicate = organizationAuthWhere(authVerification, input.where);
    if (!predicate) {
      return null;
    }
    await c.db
      .update(authVerification)
      .set(input.update as any)
      .where(predicate)
      .run();
    return await c.db.select().from(authVerification).where(predicate).get();
  },

  async authUpdateManyVerification(c: any, input: { where: any[]; update: Record<string, unknown> }) {
    assertAppOrganization(c);

    const predicate = organizationAuthWhere(authVerification, input.where);
    if (!predicate) {
      return 0;
    }
    await c.db
      .update(authVerification)
      .set(input.update as any)
      .where(predicate)
      .run();
    const row = await c.db.select({ value: sqlCount() }).from(authVerification).where(predicate).get();
    return row?.value ?? 0;
  },

  async authDeleteVerification(c: any, input: { where: any[] }) {
    assertAppOrganization(c);

    const predicate = organizationAuthWhere(authVerification, input.where);
    if (!predicate) {
      return;
    }
    await c.db.delete(authVerification).where(predicate).run();
  },

  async authDeleteManyVerification(c: any, input: { where: any[] }) {
    assertAppOrganization(c);

    const predicate = organizationAuthWhere(authVerification, input.where);
    if (!predicate) {
      return 0;
    }
    const rows = await c.db.select().from(authVerification).where(predicate).all();
    await c.db.delete(authVerification).where(predicate).run();
    return rows.length;
  },

  async authCountVerification(c: any, input: { where?: any[] }) {
    assertAppOrganization(c);

    const predicate = organizationAuthWhere(authVerification, input.where);
    const row = predicate
      ? await c.db.select({ value: sqlCount() }).from(authVerification).where(predicate).get()
      : await c.db.select({ value: sqlCount() }).from(authVerification).get();
    return row?.value ?? 0;
  },

  async getAppSnapshot(c: any, input: { sessionId: string }): Promise<FoundryAppSnapshot> {
    return await buildAppSnapshot(c, input.sessionId);
  },

  async resolveAppGithubToken(
    c: any,
    input: { organizationId: string; requireRepoScope?: boolean },
  ): Promise<{ accessToken: string; scopes: string[] } | null> {
    assertAppOrganization(c);
    const auth = getBetterAuthService();
    const rows = await c.db.select().from(authSessionIndex).orderBy(desc(authSessionIndex.updatedAt)).all();

    for (const row of rows) {
      const authState = await auth.getAuthState(row.sessionId);
      if (authState?.sessionState?.activeOrganizationId !== input.organizationId) {
        continue;
      }

      const token = await auth.getAccessTokenForSession(row.sessionId);
      if (!token?.accessToken) {
        continue;
      }

      const scopes = token.scopes;
      if (input.requireRepoScope !== false && scopes.length > 0 && !hasRepoScope(scopes)) {
        continue;
      }

      return {
        accessToken: token.accessToken,
        scopes,
      };
    }

    return null;
  },

  async skipAppStarterRepo(c: any, input: { sessionId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    await getBetterAuthService().upsertUserProfile(session.authUserId, {
      starterRepoStatus: "skipped",
      starterRepoSkippedAt: Date.now(),
      starterRepoStarredAt: null,
    });
    return await buildAppSnapshot(c, input.sessionId);
  },

  async starAppStarterRepo(c: any, input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const organization = await getOrCreateOrganization(c, input.organizationId);
    await organization.starSandboxAgentRepo({
      organizationId: input.organizationId,
    });
    await getBetterAuthService().upsertUserProfile(session.authUserId, {
      starterRepoStatus: "starred",
      starterRepoStarredAt: Date.now(),
      starterRepoSkippedAt: null,
    });
    return await buildAppSnapshot(c, input.sessionId);
  },

  async selectAppOrganization(c: any, input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    await getBetterAuthService().setActiveOrganization(input.sessionId, input.organizationId);

    // Ensure the GitHub data actor exists. If it's newly created, its own
    // workflow will detect the pending sync status and run the initial
    // full sync automatically — no orchestration needed here.
    await getOrCreateGithubData(c, input.organizationId);

    return await buildAppSnapshot(c, input.sessionId);
  },

  async updateAppOrganizationProfile(
    c: any,
    input: { sessionId: string; organizationId: string } & UpdateFoundryOrganizationProfileInput,
  ): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const organization = await getOrCreateOrganization(c, input.organizationId);
    await organization.updateOrganizationShellProfile({
      displayName: input.displayName,
      slug: input.slug,
      primaryDomain: input.primaryDomain,
    });
    return await buildAppSnapshot(c, input.sessionId);
  },

  async triggerAppRepoImport(c: any, input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);

    const githubData = await getOrCreateGithubData(c, input.organizationId);
    const summary = await githubData.getSummary({});
    if (summary.syncStatus === "syncing") {
      return await buildAppSnapshot(c, input.sessionId);
    }

    // Mark sync started on the organization, then send directly to the
    // GitHub data actor's own workflow queue.
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    await organizationHandle.markOrganizationSyncStarted({
      label: "Importing repository catalog...",
    });

    await githubData.send("githubData.command.syncRepos", { label: "Importing repository catalog..." }, { wait: false });

    return await buildAppSnapshot(c, input.sessionId);
  },

  async beginAppGithubInstall(c: any, input: { sessionId: string; organizationId: string }): Promise<{ url: string }> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const { appShell } = getActorRuntimeContext();
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    const organizationState = await getOrganizationState(organizationHandle);
    if (organizationState.snapshot.kind !== "organization") {
      return {
        url: `${appShell.appUrl}/organizations/${input.organizationId}`,
      };
    }
    return {
      url: await appShell.github.buildInstallationUrl(organizationState.githubLogin, randomUUID()),
    };
  },

  async createAppCheckoutSession(c: any, input: { sessionId: string; organizationId: string; planId: FoundryBillingPlanId }): Promise<{ url: string }> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const { appShell } = getActorRuntimeContext();
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    const organizationState = await getOrganizationState(organizationHandle);

    if (input.planId === "free") {
      await organizationHandle.applyOrganizationFreePlan({ clearSubscription: false });
      return {
        url: `${appShell.appUrl}/organizations/${input.organizationId}/billing`,
      };
    }

    if (!appShell.stripe.isConfigured()) {
      throw new Error("Stripe is not configured");
    }

    let customerId = organizationState.stripeCustomerId;
    if (!customerId) {
      customerId = (
        await appShell.stripe.createCustomer({
          organizationId: input.organizationId,
          displayName: organizationState.snapshot.settings.displayName,
          email: session.currentUserEmail,
        })
      ).id;
      await organizationHandle.applyOrganizationStripeCustomer({ customerId });
      await upsertStripeLookupEntries(c, input.organizationId, customerId, null);
    }

    return {
      url: await appShell.stripe
        .createCheckoutSession({
          organizationId: input.organizationId,
          customerId,
          customerEmail: session.currentUserEmail,
          planId: input.planId,
          successUrl: `${appShell.apiUrl}/v1/billing/checkout/complete?organizationId=${encodeURIComponent(
            input.organizationId,
          )}&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${appShell.appUrl}/organizations/${input.organizationId}/billing`,
        })
        .then((checkout) => checkout.url),
    };
  },

  async finalizeAppCheckoutSession(c: any, input: { sessionId: string; organizationId: string; checkoutSessionId: string }): Promise<{ redirectTo: string }> {
    assertAppOrganization(c);
    const { appShell } = getActorRuntimeContext();
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    const organizationState = await getOrganizationState(organizationHandle);
    const completion = await appShell.stripe.retrieveCheckoutCompletion(input.checkoutSessionId);

    if (completion.customerId) {
      await organizationHandle.applyOrganizationStripeCustomer({ customerId: completion.customerId });
    }
    await upsertStripeLookupEntries(c, input.organizationId, completion.customerId, completion.subscriptionId);

    if (completion.subscriptionId) {
      const subscription = await appShell.stripe.retrieveSubscription(completion.subscriptionId);
      await applySubscriptionState(organizationHandle, subscription, completion.planId ?? organizationState.billingPlanId);
    }

    if (completion.paymentMethodLabel) {
      await organizationHandle.setOrganizationBillingPaymentMethod({
        label: completion.paymentMethodLabel,
      });
    }

    return {
      redirectTo: `${appShell.appUrl}/organizations/${input.organizationId}/billing`,
    };
  },

  async createAppBillingPortalSession(c: any, input: { sessionId: string; organizationId: string }): Promise<{ url: string }> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const { appShell } = getActorRuntimeContext();
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    const organizationState = await getOrganizationState(organizationHandle);
    if (!organizationState.stripeCustomerId) {
      throw new Error("Stripe customer is not available for this organization");
    }
    const portal = await appShell.stripe.createPortalSession({
      customerId: organizationState.stripeCustomerId,
      returnUrl: `${appShell.appUrl}/organizations/${input.organizationId}/billing`,
    });
    return { url: portal.url };
  },

  async cancelAppScheduledRenewal(c: any, input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const { appShell } = getActorRuntimeContext();
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    const organizationState = await getOrganizationState(organizationHandle);

    if (organizationState.stripeSubscriptionId && appShell.stripe.isConfigured()) {
      const subscription = await appShell.stripe.updateSubscriptionCancellation(organizationState.stripeSubscriptionId, true);
      await applySubscriptionState(organizationHandle, subscription, organizationState.billingPlanId);
      await upsertStripeLookupEntries(c, input.organizationId, subscription.customerId ?? organizationState.stripeCustomerId, subscription.id);
    } else {
      await organizationHandle.setOrganizationBillingStatus({ status: "scheduled_cancel" });
    }

    return await buildAppSnapshot(c, input.sessionId);
  },

  async resumeAppSubscription(c: any, input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const { appShell } = getActorRuntimeContext();
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    const organizationState = await getOrganizationState(organizationHandle);

    if (organizationState.stripeSubscriptionId && appShell.stripe.isConfigured()) {
      const subscription = await appShell.stripe.updateSubscriptionCancellation(organizationState.stripeSubscriptionId, false);
      await applySubscriptionState(organizationHandle, subscription, organizationState.billingPlanId);
      await upsertStripeLookupEntries(c, input.organizationId, subscription.customerId ?? organizationState.stripeCustomerId, subscription.id);
    } else {
      await organizationHandle.setOrganizationBillingStatus({ status: "active" });
    }

    return await buildAppSnapshot(c, input.sessionId);
  },

  async recordAppSeatUsage(c: any, input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const organization = await getOrCreateOrganization(c, input.organizationId);
    await organization.recordOrganizationSeatUsage({
      email: session.currentUserEmail,
    });
    return await buildAppSnapshot(c, input.sessionId);
  },

  async handleAppStripeWebhook(c: any, input: { payload: string; signatureHeader: string | null }): Promise<{ ok: true }> {
    assertAppOrganization(c);
    const { appShell } = getActorRuntimeContext();
    const event = appShell.stripe.verifyWebhookEvent(input.payload, input.signatureHeader);

    if (event.type === "checkout.session.completed") {
      const object = event.data.object as Record<string, unknown>;
      const organizationId =
        stringFromMetadata(object.metadata, "organizationId") ??
        (await findOrganizationIdForStripeEvent(
          c,
          typeof object.customer === "string" ? object.customer : null,
          typeof object.subscription === "string" ? object.subscription : null,
        ));
      if (organizationId) {
        const organization = await getOrCreateOrganization(c, organizationId);
        if (typeof object.customer === "string") {
          await organization.applyOrganizationStripeCustomer({ customerId: object.customer });
        }
        await upsertStripeLookupEntries(
          c,
          organizationId,
          typeof object.customer === "string" ? object.customer : null,
          typeof object.subscription === "string" ? object.subscription : null,
        );
      }
      return { ok: true };
    }

    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
      const subscription = stripeWebhookSubscription(event);
      const organizationId = await findOrganizationIdForStripeEvent(c, subscription.customerId, subscription.id);
      if (organizationId) {
        const organizationHandle = await getOrCreateOrganization(c, organizationId);
        const organizationState = await getOrganizationState(organizationHandle);
        await applySubscriptionState(
          organizationHandle,
          subscription,
          appShell.stripe.planIdForPriceId(subscription.priceId ?? "") ?? organizationState.billingPlanId,
        );
        await upsertStripeLookupEntries(c, organizationId, subscription.customerId, subscription.id);
      }
      return { ok: true };
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = stripeWebhookSubscription(event);
      const organizationId = await findOrganizationIdForStripeEvent(c, subscription.customerId, subscription.id);
      if (organizationId) {
        const organization = await getOrCreateOrganization(c, organizationId);
        await organization.applyOrganizationFreePlan({ clearSubscription: true });
      }
      return { ok: true };
    }

    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Record<string, unknown>;
      const organizationId = await findOrganizationIdForStripeEvent(c, typeof invoice.customer === "string" ? invoice.customer : null, null);
      if (organizationId) {
        const organization = await getOrCreateOrganization(c, organizationId);
        const rawAmount = typeof invoice.amount_paid === "number" ? invoice.amount_paid : invoice.amount_due;
        const amountUsd = Math.round((typeof rawAmount === "number" ? rawAmount : 0) / 100);
        await organization.upsertOrganizationInvoice({
          id: String(invoice.id),
          label: typeof invoice.number === "string" ? `Invoice ${invoice.number}` : "Stripe invoice",
          issuedAt: formatUnixDate(typeof invoice.created === "number" ? invoice.created : Math.floor(Date.now() / 1000)),
          amountUsd: Number.isFinite(amountUsd) ? amountUsd : 0,
          status: event.type === "invoice.paid" ? "paid" : "open",
        });
      }
    }

    return { ok: true };
  },

  async handleAppGithubWebhook(c: any, input: { payload: string; signatureHeader: string | null; eventHeader: string | null }): Promise<{ ok: true }> {
    assertAppOrganization(c);
    const { appShell } = getActorRuntimeContext();
    const { event, body } = appShell.github.verifyWebhookEvent(input.payload, input.signatureHeader, input.eventHeader);

    const accountLogin = body.installation?.account?.login ?? body.repository?.owner?.login ?? body.organization?.login ?? null;
    const accountType = body.installation?.account?.type ?? (body.organization?.login ? "Organization" : null);
    if (!accountLogin) {
      githubWebhookLogger.info(
        {
          event,
          action: body.action ?? null,
          reason: "missing_installation_account",
        },
        "ignored",
      );
      return { ok: true };
    }

    const kind: FoundryOrganization["kind"] = accountType === "User" ? "personal" : "organization";
    const organizationId = organizationOrganizationId(kind, accountLogin);
    const receivedAt = Date.now();
    const organization = await getOrCreateOrganization(c, organizationId);
    await organization.recordGithubWebhookReceipt({
      organizationId: organizationId,
      event,
      action: body.action ?? null,
      receivedAt,
    });
    const githubData = await getOrCreateGithubData(c, organizationId);

    if (event === "installation" && (body.action === "created" || body.action === "deleted" || body.action === "suspend" || body.action === "unsuspend")) {
      githubWebhookLogger.info(
        {
          event,
          action: body.action,
          accountLogin,
          organizationId,
        },
        "installation_event",
      );
      if (body.action === "deleted") {
        await githubData.clearState({
          connectedAccount: accountLogin,
          installationStatus: "install_required",
          installationId: null,
          label: "GitHub App installation removed",
        });
      } else if (body.action === "created") {
        await githubData.fullSync({
          connectedAccount: accountLogin,
          installationStatus: "connected",
          installationId: body.installation?.id ?? null,
          githubLogin: accountLogin,
          kind,
          label: "Syncing GitHub data from installation webhook...",
        });
      } else if (body.action === "suspend") {
        await githubData.clearState({
          connectedAccount: accountLogin,
          installationStatus: "reconnect_required",
          installationId: body.installation?.id ?? null,
          label: "GitHub App installation suspended",
        });
      } else if (body.action === "unsuspend") {
        await githubData.fullSync({
          connectedAccount: accountLogin,
          installationStatus: "connected",
          installationId: body.installation?.id ?? null,
          githubLogin: accountLogin,
          kind,
          label: "Resyncing GitHub data after unsuspend...",
        });
      }
      return { ok: true };
    }

    if (event === "installation_repositories") {
      githubWebhookLogger.info(
        {
          event,
          action: body.action ?? null,
          accountLogin,
          organizationId,
          repositoriesAdded: body.repositories_added?.length ?? 0,
          repositoriesRemoved: body.repositories_removed?.length ?? 0,
        },
        "repository_membership_changed",
      );
      await githubData.fullSync({
        connectedAccount: accountLogin,
        installationStatus: "connected",
        installationId: body.installation?.id ?? null,
        githubLogin: accountLogin,
        kind,
        label: "Resyncing GitHub data after repository access change...",
      });
      return { ok: true };
    }

    if (
      event === "push" ||
      event === "pull_request" ||
      event === "pull_request_review" ||
      event === "pull_request_review_comment" ||
      event === "check_run" ||
      event === "check_suite" ||
      event === "status" ||
      event === "create" ||
      event === "delete"
    ) {
      const repoFullName = body.repository?.full_name;
      if (repoFullName) {
        githubWebhookLogger.info(
          {
            event,
            action: body.action ?? null,
            accountLogin,
            organizationId,
            repoFullName,
          },
          "repository_event",
        );
        if (event === "pull_request" && body.repository?.clone_url && body.pull_request) {
          await githubData.handlePullRequestWebhook({
            connectedAccount: accountLogin,
            installationStatus: "connected",
            installationId: body.installation?.id ?? null,
            repository: {
              fullName: body.repository.full_name,
              cloneUrl: body.repository.clone_url,
              private: Boolean(body.repository.private),
            },
            pullRequest: {
              number: body.pull_request.number,
              title: body.pull_request.title ?? "",
              body: body.pull_request.body ?? null,
              state: body.pull_request.state ?? "open",
              url: body.pull_request.html_url ?? `https://github.com/${body.repository.full_name}/pull/${body.pull_request.number}`,
              headRefName: body.pull_request.head?.ref ?? "",
              baseRefName: body.pull_request.base?.ref ?? "",
              authorLogin: body.pull_request.user?.login ?? null,
              isDraft: Boolean(body.pull_request.draft),
              merged: Boolean(body.pull_request.merged),
            },
          });
        }
        if ((event === "push" || event === "create" || event === "delete") && body.repository?.clone_url) {
          const repoId = repoIdFromRemote(body.repository.clone_url);
          const knownRepository = await githubData.getRepository({ repoId });
          if (knownRepository) {
            await githubData.reloadRepository({ repoId });
          }
        }
      }
      return { ok: true };
    }

    githubWebhookLogger.info(
      {
        event,
        action: body.action ?? null,
        accountLogin,
        organizationId,
      },
      "unhandled_event",
    );
    return { ok: true };
  },

  async syncOrganizationShellFromGithub(
    c: any,
    input: {
      userId: string;
      userName: string;
      userEmail: string;
      githubUserLogin: string;
      githubAccountId: string;
      githubLogin: string;
      githubAccountType: string;
      kind: FoundryOrganization["kind"];
      displayName: string;
      installationId: number | null;
      appConfigured: boolean;
    },
  ): Promise<{ organizationId: string }> {
    assertOrganizationShell(c);
    const now = Date.now();
    const existing = await readOrganizationProfileRow(c);
    const slug = existing?.slug ?? slugify(input.githubLogin);
    const organizationId = organizationOrganizationId(input.kind, input.githubLogin);
    if (organizationId !== c.state.organizationId) {
      throw new Error(`Organization actor mismatch: actor=${c.state.organizationId} github=${organizationId}`);
    }

    const installationStatus =
      input.kind === "personal" ? "connected" : input.installationId ? "connected" : input.appConfigured ? "install_required" : "reconnect_required";
    const syncStatus = existing?.githubSyncStatus ?? legacyRepoImportStatusToGithubSyncStatus(existing?.repoImportStatus);
    const lastSyncLabel =
      syncStatus === "synced"
        ? existing.githubLastSyncLabel
        : installationStatus === "connected"
          ? "Waiting for first import"
          : installationStatus === "install_required"
            ? "GitHub App installation required"
            : "GitHub App configuration incomplete";
    const hasStripeBillingState = Boolean(existing?.stripeCustomerId || existing?.stripeSubscriptionId || existing?.stripePriceId);
    const defaultBillingPlanId = input.kind === "personal" || !hasStripeBillingState ? "free" : (existing?.billingPlanId ?? "team");
    const defaultSeatsIncluded = input.kind === "personal" || !hasStripeBillingState ? 1 : (existing?.billingSeatsIncluded ?? 5);
    const defaultPaymentMethodLabel =
      input.kind === "personal"
        ? "No card required"
        : hasStripeBillingState
          ? (existing?.billingPaymentMethodLabel ?? "Payment method on file")
          : "No payment method on file";

    await c.db
      .insert(organizationProfile)
      .values({
        id: PROFILE_ROW_ID,
        kind: input.kind,
        githubAccountId: input.githubAccountId,
        githubLogin: input.githubLogin,
        githubAccountType: input.githubAccountType,
        displayName: input.displayName,
        slug,
        primaryDomain: existing?.primaryDomain ?? (input.kind === "personal" ? "personal" : `${slug}.github`),
        defaultModel: existing?.defaultModel ?? "claude-sonnet-4",
        autoImportRepos: existing?.autoImportRepos ?? 1,
        repoImportStatus: existing?.repoImportStatus ?? "not_started",
        githubConnectedAccount: input.githubLogin,
        githubInstallationStatus: installationStatus,
        githubSyncStatus: syncStatus,
        githubInstallationId: input.installationId,
        githubLastSyncLabel: lastSyncLabel,
        githubLastSyncAt: existing?.githubLastSyncAt ?? null,
        stripeCustomerId: existing?.stripeCustomerId ?? null,
        stripeSubscriptionId: existing?.stripeSubscriptionId ?? null,
        stripePriceId: existing?.stripePriceId ?? null,
        billingPlanId: defaultBillingPlanId,
        billingStatus: existing?.billingStatus ?? "active",
        billingSeatsIncluded: defaultSeatsIncluded,
        billingTrialEndsAt: existing?.billingTrialEndsAt ?? null,
        billingRenewalAt: existing?.billingRenewalAt ?? null,
        billingPaymentMethodLabel: defaultPaymentMethodLabel,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: organizationProfile.id,
        set: {
          kind: input.kind,
          githubAccountId: input.githubAccountId,
          githubLogin: input.githubLogin,
          githubAccountType: input.githubAccountType,
          displayName: input.displayName,
          githubConnectedAccount: input.githubLogin,
          githubInstallationStatus: installationStatus,
          githubSyncStatus: syncStatus,
          githubInstallationId: input.installationId,
          githubLastSyncLabel: lastSyncLabel,
          githubLastSyncAt: existing?.githubLastSyncAt ?? null,
          billingPlanId: defaultBillingPlanId,
          billingSeatsIncluded: defaultSeatsIncluded,
          billingPaymentMethodLabel: defaultPaymentMethodLabel,
          updatedAt: now,
        },
      })
      .run();

    await c.db
      .insert(organizationMembers)
      .values({
        id: input.userId,
        name: input.userName,
        email: input.userEmail,
        role: input.kind === "personal" ? "owner" : "admin",
        state: "active",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: organizationMembers.id,
        set: {
          name: input.userName,
          email: input.userEmail,
          role: input.kind === "personal" ? "owner" : "admin",
          state: "active",
          updatedAt: now,
        },
      })
      .run();

    return { organizationId };
  },

  async getOrganizationShellState(c: any): Promise<any> {
    assertOrganizationShell(c);
    return await buildOrganizationState(c);
  },

  async getOrganizationShellStateIfInitialized(c: any): Promise<any | null> {
    assertOrganizationShell(c);
    return await buildOrganizationStateIfInitialized(c);
  },

  async updateOrganizationShellProfile(c: any, input: Pick<UpdateFoundryOrganizationProfileInput, "displayName" | "slug" | "primaryDomain">): Promise<void> {
    assertOrganizationShell(c);
    const existing = await requireOrganizationProfileRow(c);
    await c.db
      .update(organizationProfile)
      .set({
        displayName: input.displayName.trim() || existing.displayName,
        slug: input.slug.trim() || existing.slug,
        primaryDomain: input.primaryDomain.trim() || existing.primaryDomain,
        updatedAt: Date.now(),
      })
      .where(eq(organizationProfile.id, PROFILE_ROW_ID))
      .run();
  },

  async markOrganizationSyncStarted(c: any, input: { label: string }): Promise<void> {
    assertOrganizationShell(c);
    await c.db
      .update(organizationProfile)
      .set({
        githubSyncStatus: "syncing",
        githubLastSyncLabel: input.label,
        updatedAt: Date.now(),
      })
      .where(eq(organizationProfile.id, PROFILE_ROW_ID))
      .run();
  },

  async applyOrganizationSyncCompleted(
    c: any,
    input: {
      repositories: Array<{ fullName: string; cloneUrl: string; private: boolean }>;
      installationStatus: FoundryOrganization["github"]["installationStatus"];
      lastSyncLabel: string;
    },
  ): Promise<void> {
    assertOrganizationShell(c);
    const now = Date.now();
    for (const repository of input.repositories) {
      const remoteUrl = repository.cloneUrl;
      await c.db
        .insert(repos)
        .values({
          repoId: repoIdFromRemote(remoteUrl),
          remoteUrl,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: repos.repoId,
          set: {
            remoteUrl,
            updatedAt: now,
          },
        })
        .run();
    }
    await c.db
      .update(organizationProfile)
      .set({
        githubInstallationStatus: input.installationStatus,
        githubSyncStatus: "synced",
        githubLastSyncLabel: input.lastSyncLabel,
        githubLastSyncAt: now,
        updatedAt: now,
      })
      .where(eq(organizationProfile.id, PROFILE_ROW_ID))
      .run();
  },

  async markOrganizationSyncFailed(c: any, input: { message: string; installationStatus: FoundryOrganization["github"]["installationStatus"] }): Promise<void> {
    assertOrganizationShell(c);
    await c.db
      .update(organizationProfile)
      .set({
        githubInstallationStatus: input.installationStatus,
        githubSyncStatus: "error",
        githubLastSyncLabel: input.message,
        updatedAt: Date.now(),
      })
      .where(eq(organizationProfile.id, PROFILE_ROW_ID))
      .run();
  },

  async applyOrganizationStripeCustomer(c: any, input: { customerId: string }): Promise<void> {
    assertOrganizationShell(c);
    await c.db
      .update(organizationProfile)
      .set({
        stripeCustomerId: input.customerId,
        updatedAt: Date.now(),
      })
      .where(eq(organizationProfile.id, PROFILE_ROW_ID))
      .run();
  },

  async applyOrganizationStripeSubscription(
    c: any,
    input: {
      subscription: {
        id: string;
        customerId: string;
        priceId: string | null;
        status: string;
        cancelAtPeriodEnd: boolean;
        currentPeriodEnd: number | null;
        trialEnd: number | null;
        defaultPaymentMethodLabel: string;
      };
      fallbackPlanId: FoundryBillingPlanId;
    },
  ): Promise<void> {
    assertOrganizationShell(c);
    const { appShell } = getActorRuntimeContext();
    const planId = appShell.stripe.planIdForPriceId(input.subscription.priceId ?? "") ?? input.fallbackPlanId;
    await c.db
      .update(organizationProfile)
      .set({
        stripeCustomerId: input.subscription.customerId || null,
        stripeSubscriptionId: input.subscription.id || null,
        stripePriceId: input.subscription.priceId,
        billingPlanId: planId,
        billingStatus: stripeStatusToBillingStatus(input.subscription.status, input.subscription.cancelAtPeriodEnd),
        billingSeatsIncluded: seatsIncludedForPlan(planId),
        billingTrialEndsAt: input.subscription.trialEnd ? new Date(input.subscription.trialEnd * 1000).toISOString() : null,
        billingRenewalAt: input.subscription.currentPeriodEnd ? new Date(input.subscription.currentPeriodEnd * 1000).toISOString() : null,
        billingPaymentMethodLabel: input.subscription.defaultPaymentMethodLabel || "Payment method on file",
        updatedAt: Date.now(),
      })
      .where(eq(organizationProfile.id, PROFILE_ROW_ID))
      .run();
  },

  async applyOrganizationFreePlan(c: any, input: { clearSubscription: boolean }): Promise<void> {
    assertOrganizationShell(c);
    const patch: Record<string, unknown> = {
      billingPlanId: "free",
      billingStatus: "active",
      billingSeatsIncluded: 1,
      billingTrialEndsAt: null,
      billingRenewalAt: null,
      billingPaymentMethodLabel: "No card required",
      updatedAt: Date.now(),
    };
    if (input.clearSubscription) {
      patch.stripeSubscriptionId = null;
      patch.stripePriceId = null;
    }
    await c.db.update(organizationProfile).set(patch).where(eq(organizationProfile.id, PROFILE_ROW_ID)).run();
  },

  async setOrganizationBillingPaymentMethod(c: any, input: { label: string }): Promise<void> {
    assertOrganizationShell(c);
    await c.db
      .update(organizationProfile)
      .set({
        billingPaymentMethodLabel: input.label,
        updatedAt: Date.now(),
      })
      .where(eq(organizationProfile.id, PROFILE_ROW_ID))
      .run();
  },

  async setOrganizationBillingStatus(c: any, input: { status: FoundryBillingState["status"] }): Promise<void> {
    assertOrganizationShell(c);
    await c.db
      .update(organizationProfile)
      .set({
        billingStatus: input.status,
        updatedAt: Date.now(),
      })
      .where(eq(organizationProfile.id, PROFILE_ROW_ID))
      .run();
  },

  async upsertOrganizationInvoice(c: any, input: { id: string; label: string; issuedAt: string; amountUsd: number; status: "paid" | "open" }): Promise<void> {
    assertOrganizationShell(c);
    await c.db
      .insert(invoices)
      .values({
        id: input.id,
        label: input.label,
        issuedAt: input.issuedAt,
        amountUsd: input.amountUsd,
        status: input.status,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: invoices.id,
        set: {
          label: input.label,
          issuedAt: input.issuedAt,
          amountUsd: input.amountUsd,
          status: input.status,
        },
      })
      .run();
  },

  async recordOrganizationSeatUsage(c: any, input: { email: string }): Promise<void> {
    assertOrganizationShell(c);
    await c.db
      .insert(seatAssignments)
      .values({
        email: input.email,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  },

  async applyGithubInstallationCreated(c: any, input: { installationId: number }): Promise<void> {
    assertOrganizationShell(c);
    await c.db
      .update(organizationProfile)
      .set({
        githubInstallationId: input.installationId,
        githubInstallationStatus: "connected",
        updatedAt: Date.now(),
      })
      .where(eq(organizationProfile.id, PROFILE_ROW_ID))
      .run();
  },

  async applyGithubInstallationRemoved(c: any, _input: {}): Promise<void> {
    assertOrganizationShell(c);
    await c.db
      .update(organizationProfile)
      .set({
        githubInstallationId: null,
        githubInstallationStatus: "install_required",
        githubSyncStatus: "pending",
        githubLastSyncLabel: "GitHub App installation removed",
        updatedAt: Date.now(),
      })
      .where(eq(organizationProfile.id, PROFILE_ROW_ID))
      .run();
  },

  async applyGithubRepositoryChanges(c: any, input: { added: Array<{ fullName: string; private: boolean }>; removed: string[] }): Promise<void> {
    assertOrganizationShell(c);
    const now = Date.now();

    for (const repo of input.added) {
      const remoteUrl = `https://github.com/${repo.fullName}.git`;
      const repoId = repoIdFromRemote(remoteUrl);
      await c.db
        .insert(repos)
        .values({
          repoId,
          remoteUrl,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: repos.repoId,
          set: {
            remoteUrl,
            updatedAt: now,
          },
        })
        .run();
    }

    for (const fullName of input.removed) {
      const remoteUrl = `https://github.com/${fullName}.git`;
      const repoId = repoIdFromRemote(remoteUrl);
      await c.db.delete(repos).where(eq(repos.repoId, repoId)).run();
    }

    const repoCount = (await c.db.select().from(repos).all()).length;
    await c.db
      .update(organizationProfile)
      .set({
        githubSyncStatus: "synced",
        githubLastSyncLabel: `${repoCount} repositories synced`,
        githubLastSyncAt: now,
        updatedAt: now,
      })
      .where(eq(organizationProfile.id, PROFILE_ROW_ID))
      .run();
  },
};
