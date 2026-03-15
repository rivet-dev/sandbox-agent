# Backend Notes

## Actor Hierarchy

Keep the backend actor tree aligned with this shape unless we explicitly decide to change it:

```text
OrganizationActor
├─ HistoryActor(organization-scoped global feed)
├─ GithubDataActor
├─ RepositoryActor(repo)
│  └─ TaskActor(task)
│     ├─ TaskSessionActor(session) × N
│     │  └─ SessionStatusSyncActor(session) × 0..1
│     └─ Task-local workbench state
└─ SandboxInstanceActor(sandboxProviderId, sandboxId) × N
```

## Coordinator Pattern

Actors follow a coordinator pattern where each coordinator is responsible for:
1. **Index tables** — keeping a local SQLite index/summary of its child actors' data
2. **Create/destroy** — handling lifecycle of child actors
3. **Routing** — resolving lookups to the correct child actor

Children push updates **up** to their direct coordinator only. Coordinators broadcast changes to connected clients. This keeps the read path local (no fan-out to children).

### Coordinator hierarchy and index tables

```text
OrganizationActor (coordinator for repos + auth users)
│
│  Index tables:
│  ├─ repos              → RepositoryActor index (repo catalog)
│  ├─ taskLookup         → TaskActor index (taskId → repoId routing)
│  ├─ taskSummaries      → TaskActor index (materialized sidebar projection)
│  ├─ authSessionIndex   → AuthUserActor index (session token → userId)
│  ├─ authEmailIndex     → AuthUserActor index (email → userId)
│  └─ authAccountIndex   → AuthUserActor index (OAuth account → userId)
│
├─ RepositoryActor (coordinator for tasks)
│  │
│  │  Index tables:
│  │  └─ taskIndex       → TaskActor index (taskId → branchName)
│  │
│  └─ TaskActor (coordinator for sessions + sandboxes)
│     │
│     │  Index tables:
│     │  ├─ taskWorkbenchSessions → Session index (session metadata, transcript, draft)
│     │  └─ taskSandboxes         → SandboxInstanceActor index (sandbox history)
│     │
│     └─ SandboxInstanceActor (leaf)
│
├─ HistoryActor (organization-scoped audit log, not a coordinator)
└─ GithubDataActor (GitHub API cache, not a coordinator)
```

When adding a new index table, annotate it in the schema file with a doc comment identifying it as a coordinator index and which child actor it indexes (see existing examples).

## Ownership Rules

- `OrganizationActor` is the organization coordinator and lookup/index owner.
- `HistoryActor` is organization-scoped. There is one organization-level history feed.
- `RepositoryActor` is the repo coordinator and owns repo-local caches/indexes.
- `TaskActor` is one branch. Treat `1 task = 1 branch` once branch assignment is finalized.
- `TaskActor` can have many sessions.
- `TaskActor` can reference many sandbox instances historically, but should have only one active sandbox/session at a time.
- Session unread state and draft prompts are backend-owned workbench state, not frontend-local state.
- Branch rename is a real git operation, not just metadata.
- `SandboxInstanceActor` stays separate from `TaskActor`; tasks/sessions reference it by identity.
- The backend stores no local git state. No clones, no refs, no working trees, and no git-spice. Repository metadata comes from GitHub API data and webhook events. Any working-tree git operation runs inside a sandbox via `executeInSandbox()`.
- When a backend request path must aggregate multiple independent actor calls or reads, prefer bounded parallelism over sequential fan-out when correctness permits. Do not serialize independent work by default.
- Only a coordinator creates/destroys its children. Do not create child actors from outside the coordinator.
- Children push state changes up to their direct coordinator only — never skip levels (e.g., task pushes to repo, not directly to org, unless org is the direct coordinator for that index).
- Read paths must use the coordinator's local index tables. Do not fan out to child actors on the hot read path.
- Never build "enriched" read actions that chain through multiple actors (e.g., coordinator → child actor → sibling actor). If data from multiple actors is needed for a read, it should already be materialized in the coordinator's index tables via push updates. If it's not there, fix the write path to push it — do not add a fan-out read path.

## Multiplayer Correctness

Per-user UI state must live on the user actor, not on shared task/session actors. This is critical for multiplayer — multiple users may view the same task simultaneously with different active sessions, unread states, and in-progress drafts.

**Per-user state (user actor):** active session tab, unread counts, draft text, draft attachments. Keyed by `(userId, taskId, sessionId)`.

**Task-global state (task actor):** session transcript, session model, session runtime status, sandbox identity, task status, branch name, PR state. These are shared across all users viewing the task — that is correct behavior.

Do not store per-user preferences, selections, or ephemeral UI state on shared actors. If a field's value should differ between two users looking at the same task, it belongs on the user actor.

## Maintenance

- Keep this file up to date whenever actor ownership, hierarchy, or lifecycle responsibilities change.
- If the real actor tree diverges from this document, update this document in the same change.
- When adding, removing, or renaming coordinator index tables, update the hierarchy diagram above in the same change.
- When adding a new coordinator index table in a schema file, add a doc comment identifying which child actor it indexes (pattern: `/** Coordinator index of {ChildActor} instances. ... */`).
