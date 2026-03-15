import { and, asc, count as sqlCount, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, notInArray, or } from "drizzle-orm";
import { actor } from "rivetkit";
import { authUserDb } from "./db/db.js";
import { authAccounts, authSessions, authUsers, sessionState, userProfiles } from "./db/schema.js";

const tables = {
  user: authUsers,
  session: authSessions,
  account: authAccounts,
  userProfiles,
  sessionState,
} as const;

function tableFor(model: string) {
  const table = tables[model as keyof typeof tables];
  if (!table) {
    throw new Error(`Unsupported auth user model: ${model}`);
  }
  return table as any;
}

function columnFor(table: any, field: string) {
  const column = table[field];
  if (!column) {
    throw new Error(`Unsupported auth user field: ${field}`);
  }
  return column;
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }
  return value;
}

function clauseToExpr(table: any, clause: any) {
  const column = columnFor(table, clause.field);
  const value = normalizeValue(clause.value);

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

function buildWhere(table: any, where: any[] | undefined) {
  if (!where || where.length === 0) {
    return undefined;
  }

  let expr = clauseToExpr(table, where[0]);
  for (const clause of where.slice(1)) {
    const next = clauseToExpr(table, clause);
    expr = clause.connector === "OR" ? or(expr, next) : and(expr, next);
  }
  return expr;
}

function applyJoinToRow(c: any, model: string, row: any, join: any) {
  if (!row || !join) {
    return row;
  }

  if (model === "session" && join.user) {
    return c.db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, row.userId))
      .get()
      .then((user: any) => ({ ...row, user: user ?? null }));
  }

  if (model === "account" && join.user) {
    return c.db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, row.userId))
      .get()
      .then((user: any) => ({ ...row, user: user ?? null }));
  }

  if (model === "user" && join.account) {
    return c.db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.userId, row.id))
      .all()
      .then((accounts: any[]) => ({ ...row, account: accounts }));
  }

  return Promise.resolve(row);
}

async function applyJoinToRows(c: any, model: string, rows: any[], join: any) {
  if (!join || rows.length === 0) {
    return rows;
  }

  if (model === "session" && join.user) {
    const userIds = [...new Set(rows.map((row) => row.userId).filter(Boolean))];
    const users = userIds.length > 0 ? await c.db.select().from(authUsers).where(inArray(authUsers.id, userIds)).all() : [];
    const userMap = new Map(users.map((user: any) => [user.id, user]));
    return rows.map((row) => ({ ...row, user: userMap.get(row.userId) ?? null }));
  }

  if (model === "account" && join.user) {
    const userIds = [...new Set(rows.map((row) => row.userId).filter(Boolean))];
    const users = userIds.length > 0 ? await c.db.select().from(authUsers).where(inArray(authUsers.id, userIds)).all() : [];
    const userMap = new Map(users.map((user: any) => [user.id, user]));
    return rows.map((row) => ({ ...row, user: userMap.get(row.userId) ?? null }));
  }

  if (model === "user" && join.account) {
    const userIds = rows.map((row) => row.id);
    const accounts = userIds.length > 0 ? await c.db.select().from(authAccounts).where(inArray(authAccounts.userId, userIds)).all() : [];
    const accountsByUserId = new Map<string, any[]>();
    for (const account of accounts) {
      const entries = accountsByUserId.get(account.userId) ?? [];
      entries.push(account);
      accountsByUserId.set(account.userId, entries);
    }
    return rows.map((row) => ({ ...row, account: accountsByUserId.get(row.id) ?? [] }));
  }

  return rows;
}

export const authUser = actor({
  db: authUserDb,
  options: {
    name: "Auth User",
    icon: "shield",
    actionTimeout: 60_000,
  },
  createState: (_c, input: { userId: string }) => ({
    userId: input.userId,
  }),
  actions: {
    async createAuthRecord(c, input: { model: string; data: Record<string, unknown> }) {
      const table = tableFor(input.model);
      await c.db
        .insert(table)
        .values(input.data as any)
        .run();
      return await c.db
        .select()
        .from(table)
        .where(eq(columnFor(table, "id"), input.data.id as any))
        .get();
    },

    async findOneAuthRecord(c, input: { model: string; where: any[]; join?: any }) {
      const table = tableFor(input.model);
      const predicate = buildWhere(table, input.where);
      const row = predicate ? await c.db.select().from(table).where(predicate).get() : await c.db.select().from(table).get();
      return await applyJoinToRow(c, input.model, row ?? null, input.join);
    },

    async findManyAuthRecords(c, input: { model: string; where?: any[]; limit?: number; offset?: number; sortBy?: any; join?: any }) {
      const table = tableFor(input.model);
      const predicate = buildWhere(table, input.where);
      let query: any = c.db.select().from(table);
      if (predicate) {
        query = query.where(predicate);
      }
      if (input.sortBy?.field) {
        const column = columnFor(table, input.sortBy.field);
        query = query.orderBy(input.sortBy.direction === "asc" ? asc(column) : desc(column));
      }
      if (typeof input.limit === "number") {
        query = query.limit(input.limit);
      }
      if (typeof input.offset === "number") {
        query = query.offset(input.offset);
      }
      const rows = await query.all();
      return await applyJoinToRows(c, input.model, rows, input.join);
    },

    async updateAuthRecord(c, input: { model: string; where: any[]; update: Record<string, unknown> }) {
      const table = tableFor(input.model);
      const predicate = buildWhere(table, input.where);
      if (!predicate) {
        throw new Error("updateAuthRecord requires a where clause");
      }
      await c.db
        .update(table)
        .set(input.update as any)
        .where(predicate)
        .run();
      return await c.db.select().from(table).where(predicate).get();
    },

    async updateManyAuthRecords(c, input: { model: string; where: any[]; update: Record<string, unknown> }) {
      const table = tableFor(input.model);
      const predicate = buildWhere(table, input.where);
      if (!predicate) {
        throw new Error("updateManyAuthRecords requires a where clause");
      }
      await c.db
        .update(table)
        .set(input.update as any)
        .where(predicate)
        .run();
      const row = await c.db.select({ value: sqlCount() }).from(table).where(predicate).get();
      return row?.value ?? 0;
    },

    async deleteAuthRecord(c, input: { model: string; where: any[] }) {
      const table = tableFor(input.model);
      const predicate = buildWhere(table, input.where);
      if (!predicate) {
        throw new Error("deleteAuthRecord requires a where clause");
      }
      await c.db.delete(table).where(predicate).run();
    },

    async deleteManyAuthRecords(c, input: { model: string; where: any[] }) {
      const table = tableFor(input.model);
      const predicate = buildWhere(table, input.where);
      if (!predicate) {
        throw new Error("deleteManyAuthRecords requires a where clause");
      }
      const rows = await c.db.select().from(table).where(predicate).all();
      await c.db.delete(table).where(predicate).run();
      return rows.length;
    },

    async countAuthRecords(c, input: { model: string; where?: any[] }) {
      const table = tableFor(input.model);
      const predicate = buildWhere(table, input.where);
      const row = predicate
        ? await c.db.select({ value: sqlCount() }).from(table).where(predicate).get()
        : await c.db.select({ value: sqlCount() }).from(table).get();
      return row?.value ?? 0;
    },

    async getAppAuthState(c, input: { sessionId: string }) {
      const session = await c.db.select().from(authSessions).where(eq(authSessions.id, input.sessionId)).get();
      if (!session) {
        return null;
      }
      const [user, profile, currentSessionState, accounts] = await Promise.all([
        c.db.select().from(authUsers).where(eq(authUsers.id, session.userId)).get(),
        c.db.select().from(userProfiles).where(eq(userProfiles.userId, session.userId)).get(),
        c.db.select().from(sessionState).where(eq(sessionState.sessionId, input.sessionId)).get(),
        c.db.select().from(authAccounts).where(eq(authAccounts.userId, session.userId)).all(),
      ]);
      return {
        session,
        user,
        profile: profile ?? null,
        sessionState: currentSessionState ?? null,
        accounts,
      };
    },

    async upsertUserProfile(
      c,
      input: {
        userId: string;
        patch: {
          githubAccountId?: string | null;
          githubLogin?: string | null;
          roleLabel?: string;
          eligibleOrganizationIdsJson?: string;
          starterRepoStatus?: string;
          starterRepoStarredAt?: number | null;
          starterRepoSkippedAt?: number | null;
        };
      },
    ) {
      const now = Date.now();
      await c.db
        .insert(userProfiles)
        .values({
          userId: input.userId,
          githubAccountId: input.patch.githubAccountId ?? null,
          githubLogin: input.patch.githubLogin ?? null,
          roleLabel: input.patch.roleLabel ?? "GitHub user",
          eligibleOrganizationIdsJson: input.patch.eligibleOrganizationIdsJson ?? "[]",
          starterRepoStatus: input.patch.starterRepoStatus ?? "pending",
          starterRepoStarredAt: input.patch.starterRepoStarredAt ?? null,
          starterRepoSkippedAt: input.patch.starterRepoSkippedAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: userProfiles.userId,
          set: {
            ...(input.patch.githubAccountId !== undefined ? { githubAccountId: input.patch.githubAccountId } : {}),
            ...(input.patch.githubLogin !== undefined ? { githubLogin: input.patch.githubLogin } : {}),
            ...(input.patch.roleLabel !== undefined ? { roleLabel: input.patch.roleLabel } : {}),
            ...(input.patch.eligibleOrganizationIdsJson !== undefined ? { eligibleOrganizationIdsJson: input.patch.eligibleOrganizationIdsJson } : {}),
            ...(input.patch.starterRepoStatus !== undefined ? { starterRepoStatus: input.patch.starterRepoStatus } : {}),
            ...(input.patch.starterRepoStarredAt !== undefined ? { starterRepoStarredAt: input.patch.starterRepoStarredAt } : {}),
            ...(input.patch.starterRepoSkippedAt !== undefined ? { starterRepoSkippedAt: input.patch.starterRepoSkippedAt } : {}),
            updatedAt: now,
          },
        })
        .run();

      return await c.db.select().from(userProfiles).where(eq(userProfiles.userId, input.userId)).get();
    },

    async upsertSessionState(c, input: { sessionId: string; activeOrganizationId: string | null }) {
      const now = Date.now();
      await c.db
        .insert(sessionState)
        .values({
          sessionId: input.sessionId,
          activeOrganizationId: input.activeOrganizationId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: sessionState.sessionId,
          set: {
            activeOrganizationId: input.activeOrganizationId,
            updatedAt: now,
          },
        })
        .run();

      return await c.db.select().from(sessionState).where(eq(sessionState.sessionId, input.sessionId)).get();
    },
  },
});
