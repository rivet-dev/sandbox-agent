# Spec: Foundry Provider Credential Management

## Overview

Allow Foundry users to sign in to Claude and Codex with their own accounts. Credentials are extracted from the sandbox filesystem, stored in the user actor, and re-populated into sandboxes on task ownership change.

## Supported Providers

- **Claude** (Anthropic) - OAuth via `claude /login`
- **Codex** (OpenAI) - OAuth via Codex CLI login

## Credential Files

Each provider's CLI writes credentials to a well-known path:

| Provider | File Path (in sandbox) | Key Fields |
|----------|----------------------|------------|
| Claude | `~/.claude/.credentials.json` | `claudeAiOauth.accessToken`, `claudeAiOauth.expiresAt` |
| Codex | `~/.codex/auth.json` | `tokens.access_token` or `OPENAI_API_KEY` |

## Architecture

```
User Actor                     Sandbox
+--------------------------+   +---------------------------+
| userProviderCredentials  |   | ~/.claude/.credentials.json|
|  - provider              |-->| ~/.codex/auth.json        |
|  - credentialFileJson    |   +---------------------------+
|  - updatedAt             |        |
+--------------------------+        | poll interval
        ^                          | (extract & store)
        |                          v
        +--- periodic sync --------+
```

Credentials are stored **outside the sandbox** in the user actor. They are written into the sandbox before the agent session starts, and periodically re-extracted to capture token refreshes.

## Flows

### 1. Sign-In Flow (First Time)

1. User opens **Settings** screen (separate from task view).
2. Settings shows Claude and Codex sign-in status (signed in / not signed in).
3. User clicks **[Sign in to Claude]** or **[Sign in to Codex]**.
4. Button opens a terminal in the active sandbox and auto-runs the `terminal-auth` command from `authMethods._meta["terminal-auth"]` (discovered during ACP `initialize`).
5. User completes OAuth flow in browser. CLI writes credentials to disk and exits.
6. On process exit (code 0), extract credentials from sandbox filesystem and persist to user actor.
7. Settings UI updates to show "Signed in".

**Fallback:** If process exits non-zero or user closes terminal, show "Sign in" button again.

### 2. Auth Error Detection

1. User sends a message to a task.
2. `maybeSwapTaskOwner` runs, writes credential files to sandbox.
3. Agent's `newSession` or `prompt` call proceeds.
4. If agent returns `auth_required` error:
   - Surface "Sign in required" in the task UI.
   - Show buttons: **[Sign in to Claude]** / **[Sign in to Codex]** (depending on which agent errored).
   - Same terminal flow as above.
5. After sign-in completes, automatically retry the failed operation.

### 3. Credential Population on Task Ownership Change

Extends the existing `maybeSwapTaskOwner` in `task/workspace.ts`:

1. User sends message to task.
2. `maybeSwapTaskOwner` detects owner change (or first message with no owner).
3. Existing: inject git credentials via `injectGitCredentials`.
4. **New:** inject provider credentials via `injectProviderCredentials`:
   - Read stored credentials from user actor.
   - Write `~/.claude/.credentials.json` and `~/.codex/auth.json` into sandbox filesystem.
5. Await completion of both injections.
6. Send prompt to agent.

This runs before `newSession` / `sendPrompt`, so credentials are on disk when the agent reads them.

### 4. Credential Polling (Sync from Sandbox)

Similar to git status polling:

1. On a poll interval (e.g. 30s), read credential files from the sandbox filesystem.
2. Compare with stored credentials in user actor.
3. If changed (e.g. token refreshed by the agent), update the user actor.
4. This keeps stored credentials fresh for repopulation into other sandboxes.

## Data Model

### User Actor: New Table `userProviderCredentials`

```sql
CREATE TABLE userProviderCredentials (
  provider TEXT PRIMARY KEY,          -- "anthropic" | "openai"
  credentialFileJson TEXT NOT NULL,   -- raw file contents to write back
  filePath TEXT NOT NULL,             -- e.g. ".claude/.credentials.json"
  updatedAt INTEGER NOT NULL
);
```

We store the raw file JSON rather than individual fields. This avoids needing to understand every field the CLI writes, and means we can write back exactly what was extracted. The file path is stored so we know where to write it in the sandbox.

### User Actor: New Queue

- `user.command.provider_credentials.upsert` - update provider credentials

### User Actor: New Action

- `getProviderCredentialStatus()` - returns `{ anthropic: boolean, openai: boolean }` for the settings UI

## Implementation Changes

### Backend

| File | Change |
|------|--------|
| `actors/user/db/schema.ts` | Add `userProviderCredentials` table |
| `actors/user/workflow.ts` | Add `user.command.provider_credentials.upsert` queue handler |
| `actors/user/actions/user.ts` | Add `getProviderCredentialStatus` action, extend `getAppAuthState` to include provider credential status |
| `actors/task/workspace.ts` | Add `injectProviderCredentials` function, call it from `maybeSwapTaskOwner`. Also handle first-message case (no owner change but credentials need populating). |
| `actors/task/workspace.ts` | Add credential polling logic (similar to git status poll) to periodically extract credential files from sandbox and update user actor. |
| `actors/organization/actions/tasks.ts` | Add action for triggering terminal-auth command in sandbox |

### Frontend

| File | Change |
|------|--------|
| Settings screen | Show Claude/Codex sign-in status with **[Sign in]** buttons |
| Task view | Handle `auth_required` errors from agent, show sign-in prompt with buttons |
| Terminal integration | Open sandbox terminal and auto-run the terminal-auth command when sign-in button clicked |

### SDK (not required for initial implementation)

The `terminal-auth` command metadata comes from the ACP adapter's `initialize` response. The current SDK skips interactive auth methods in `autoAuthenticate`. For the Foundry, we don't need to change the SDK since we handle auth at a higher level (UI + sandbox terminal).

## Credential Injection Implementation

```typescript
async function injectProviderCredentials(
  sandbox: Sandbox,
  credentials: Array<{ provider: string; credentialFileJson: string; filePath: string }>
): Promise<void> {
  for (const cred of credentials) {
    const fullPath = `/home/user/${cred.filePath}`;
    const dir = path.dirname(fullPath);
    const script = [
      `mkdir -p ${JSON.stringify(dir)}`,
      `cat > ${JSON.stringify(fullPath)} << 'CRED_EOF'\n${cred.credentialFileJson}\nCRED_EOF`,
      `chmod 600 ${JSON.stringify(fullPath)}`,
    ].join(" && ");

    await sandbox.runProcess({
      command: "bash",
      args: ["-lc", script],
      cwd: "/",
      timeoutMs: 10_000,
    });
  }
}
```

## Credential Extraction Implementation

```typescript
async function extractProviderCredentials(
  sandbox: Sandbox
): Promise<Array<{ provider: string; credentialFileJson: string; filePath: string }>> {
  const files = [
    { provider: "anthropic", filePath: ".claude/.credentials.json" },
    { provider: "openai", filePath: ".codex/auth.json" },
  ];

  const results = [];
  for (const file of files) {
    const fullPath = `/home/user/${file.filePath}`;
    const result = await sandbox.runProcess({
      command: "cat",
      args: [fullPath],
      cwd: "/",
      timeoutMs: 5_000,
    });
    if (result.exitCode === 0 && result.stdout.trim()) {
      results.push({
        provider: file.provider,
        credentialFileJson: result.stdout.trim(),
        filePath: file.filePath,
      });
    }
  }
  return results;
}
```

## Security Considerations

- Credential files written with `chmod 600` (owner-only read/write in sandbox).
- Credentials stored in user actor's SQLite (same security model as GitHub OAuth tokens in `authAccounts`).
- Credentials never sent to the frontend. Only boolean status (signed in / not signed in) exposed to UI.
- On owner swap, old credentials are overwritten (same as git credential swap).

## Out of Scope

- Token refresh handling: the agent adapters (Claude/Codex) handle their own token refresh internally. We just re-extract periodically to capture refreshed tokens.
- Other providers beyond Claude and Codex.
- API key entry via UI (users sign in via CLI, not by pasting keys).
- Changes to the Sandbox Agent SDK's `autoAuthenticate` function.
