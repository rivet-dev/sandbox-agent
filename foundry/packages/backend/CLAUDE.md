# Backend Notes

## Actor Hierarchy

Keep the backend actor tree aligned with this shape unless we explicitly decide to change it:

```text
WorkspaceActor
├─ HistoryActor(workspace-scoped global feed)
├─ ProjectActor(repo)
│  ├─ ProjectBranchSyncActor
│  ├─ ProjectPrSyncActor
│  └─ TaskActor(task)
│     ├─ TaskSessionActor(session) × N
│     │  └─ SessionStatusSyncActor(session) × 0..1
│     └─ Task-local workbench state
└─ SandboxInstanceActor(providerId, sandboxId) × N
```

## Ownership Rules

- `WorkspaceActor` is the workspace coordinator and lookup/index owner.
- `HistoryActor` is workspace-scoped. There is one workspace-level history feed.
- `ProjectActor` is the repo coordinator and owns repo-local caches/indexes.
- `TaskActor` is one branch. Treat `1 task = 1 branch` once branch assignment is finalized.
- `TaskActor` can have many sessions.
- `TaskActor` can reference many sandbox instances historically, but should have only one active sandbox/session at a time.
- Session unread state and draft prompts are backend-owned workbench state, not frontend-local state.
- Branch rename is a real git operation, not just metadata.
- `SandboxInstanceActor` stays separate from `TaskActor`; tasks/sessions reference it by identity.
- Sync actors are polling workers only. They feed parent actors and should not become the source of truth.

## Maintenance

- Keep this file up to date whenever actor ownership, hierarchy, or lifecycle responsibilities change.
- If the real actor tree diverges from this document, update this document in the same change.
