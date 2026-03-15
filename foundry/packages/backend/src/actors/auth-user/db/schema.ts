import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const authUsers = sqliteTable("user", {
  id: text("id").notNull().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: integer("email_verified").notNull(),
  image: text("image"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const authSessions = sqliteTable(
  "session",
  {
    id: text("id").notNull().primaryKey(),
    token: text("token").notNull(),
    userId: text("user_id").notNull(),
    expiresAt: integer("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    tokenIdx: uniqueIndex("session_token_idx").on(table.token),
  }),
);

export const authAccounts = sqliteTable(
  "account",
  {
    id: text("id").notNull().primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at"),
    refreshTokenExpiresAt: integer("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    providerAccountIdx: uniqueIndex("account_provider_account_idx").on(table.providerId, table.accountId),
  }),
);

export const userProfiles = sqliteTable("user_profiles", {
  userId: text("user_id").notNull().primaryKey(),
  githubAccountId: text("github_account_id"),
  githubLogin: text("github_login"),
  roleLabel: text("role_label").notNull(),
  eligibleOrganizationIdsJson: text("eligible_organization_ids_json").notNull(),
  starterRepoStatus: text("starter_repo_status").notNull(),
  starterRepoStarredAt: integer("starter_repo_starred_at"),
  starterRepoSkippedAt: integer("starter_repo_skipped_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sessionState = sqliteTable("session_state", {
  sessionId: text("session_id").notNull().primaryKey(),
  activeOrganizationId: text("active_organization_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
