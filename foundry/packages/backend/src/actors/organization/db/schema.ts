import { integer, sqliteTable, text } from "rivetkit/db/drizzle";

// SQLite is per organization actor instance, so no organizationId column needed.

/**
 * Coordinator index of RepositoryActor instances.
 * The organization actor is the coordinator for repositories.
 * Rows are created/removed when repos are added/removed from the organization.
 */
export const repos = sqliteTable("repos", {
  repoId: text("repo_id").notNull().primaryKey(),
  remoteUrl: text("remote_url").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Coordinator index of TaskActor instances.
 * Fast taskId → repoId lookup so the organization can route requests
 * to the correct RepositoryActor without scanning all repos.
 */
export const taskLookup = sqliteTable("task_lookup", {
  taskId: text("task_id").notNull().primaryKey(),
  repoId: text("repo_id").notNull(),
});

/**
 * Coordinator index of TaskActor instances — materialized sidebar projection.
 * Task actors push summary updates to the organization actor via
 * applyTaskSummaryUpdate(). Source of truth lives on each TaskActor;
 * this table exists so organization reads stay local without fan-out.
 */
export const taskSummaries = sqliteTable("task_summaries", {
  taskId: text("task_id").notNull().primaryKey(),
  repoId: text("repo_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  repoName: text("repo_name").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  branch: text("branch"),
  pullRequestJson: text("pull_request_json"),
  sessionsSummaryJson: text("sessions_summary_json").notNull().default("[]"),
});

export const organizationProfile = sqliteTable("organization_profile", {
  id: text("id").notNull().primaryKey(),
  kind: text("kind").notNull(),
  githubAccountId: text("github_account_id").notNull(),
  githubLogin: text("github_login").notNull(),
  githubAccountType: text("github_account_type").notNull(),
  displayName: text("display_name").notNull(),
  slug: text("slug").notNull(),
  primaryDomain: text("primary_domain").notNull(),
  defaultModel: text("default_model").notNull(),
  autoImportRepos: integer("auto_import_repos").notNull(),
  repoImportStatus: text("repo_import_status").notNull(),
  githubConnectedAccount: text("github_connected_account").notNull(),
  githubInstallationStatus: text("github_installation_status").notNull(),
  githubSyncStatus: text("github_sync_status").notNull(),
  githubInstallationId: integer("github_installation_id"),
  githubLastSyncLabel: text("github_last_sync_label").notNull(),
  githubLastSyncAt: integer("github_last_sync_at"),
  githubLastWebhookAt: integer("github_last_webhook_at"),
  githubLastWebhookEvent: text("github_last_webhook_event"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripePriceId: text("stripe_price_id"),
  billingPlanId: text("billing_plan_id").notNull(),
  billingStatus: text("billing_status").notNull(),
  billingSeatsIncluded: integer("billing_seats_included").notNull(),
  billingTrialEndsAt: text("billing_trial_ends_at"),
  billingRenewalAt: text("billing_renewal_at"),
  billingPaymentMethodLabel: text("billing_payment_method_label").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const organizationMembers = sqliteTable("organization_members", {
  id: text("id").notNull().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull(),
  state: text("state").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const seatAssignments = sqliteTable("seat_assignments", {
  email: text("email").notNull().primaryKey(),
  createdAt: integer("created_at").notNull(),
});

export const invoices = sqliteTable("invoices", {
  id: text("id").notNull().primaryKey(),
  label: text("label").notNull(),
  issuedAt: text("issued_at").notNull(),
  amountUsd: integer("amount_usd").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * Coordinator index of AuthUserActor instances — routes session token → userId.
 * Better Auth adapter uses this to resolve which user actor to query
 * before the user identity is known.
 */
export const authSessionIndex = sqliteTable("auth_session_index", {
  sessionId: text("session_id").notNull().primaryKey(),
  sessionToken: text("session_token").notNull(),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Coordinator index of AuthUserActor instances — routes email → userId.
 * Better Auth adapter uses this to resolve which user actor to query.
 */
export const authEmailIndex = sqliteTable("auth_email_index", {
  email: text("email").notNull().primaryKey(),
  userId: text("user_id").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Coordinator index of AuthUserActor instances — routes OAuth account → userId.
 * Better Auth adapter uses this to resolve which user actor to query.
 */
export const authAccountIndex = sqliteTable("auth_account_index", {
  id: text("id").notNull().primaryKey(),
  providerId: text("provider_id").notNull(),
  accountId: text("account_id").notNull(),
  userId: text("user_id").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const authVerification = sqliteTable("auth_verification", {
  id: text("id").notNull().primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const stripeLookup = sqliteTable("stripe_lookup", {
  lookupKey: text("lookup_key").notNull().primaryKey(),
  organizationId: text("organization_id").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
