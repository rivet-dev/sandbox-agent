import { integer, sqliteTable, text } from "rivetkit/db/drizzle";

// SQLite is per workspace actor instance, so no workspaceId column needed.
export const providerProfiles = sqliteTable("provider_profiles", {
  providerId: text("provider_id").notNull().primaryKey(),
  profileJson: text("profile_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const repos = sqliteTable("repos", {
  repoId: text("repo_id").notNull().primaryKey(),
  remoteUrl: text("remote_url").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const taskLookup = sqliteTable("task_lookup", {
  taskId: text("task_id").notNull().primaryKey(),
  repoId: text("repo_id").notNull(),
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

export const appSessions = sqliteTable("app_sessions", {
  id: text("id").notNull().primaryKey(),
  currentUserId: text("current_user_id"),
  currentUserName: text("current_user_name"),
  currentUserEmail: text("current_user_email"),
  currentUserGithubLogin: text("current_user_github_login"),
  currentUserRoleLabel: text("current_user_role_label"),
  eligibleOrganizationIdsJson: text("eligible_organization_ids_json").notNull(),
  activeOrganizationId: text("active_organization_id"),
  githubAccessToken: text("github_access_token"),
  githubScope: text("github_scope").notNull(),
  starterRepoStatus: text("starter_repo_status").notNull(),
  starterRepoStarredAt: integer("starter_repo_starred_at"),
  starterRepoSkippedAt: integer("starter_repo_skipped_at"),
  oauthState: text("oauth_state"),
  oauthStateExpiresAt: integer("oauth_state_expires_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const stripeLookup = sqliteTable("stripe_lookup", {
  lookupKey: text("lookup_key").notNull().primaryKey(),
  organizationId: text("organization_id").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
