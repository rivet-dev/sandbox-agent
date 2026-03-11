import type {
  WorkbenchAgentKind as AgentKind,
  WorkbenchAgentTab as AgentTab,
  WorkbenchDiffLineKind as DiffLineKind,
  WorkbenchFileTreeNode as FileTreeNode,
  WorkbenchTask as Task,
  TaskWorkbenchSnapshot,
  WorkbenchHistoryEvent as HistoryEvent,
  WorkbenchModelGroup as ModelGroup,
  WorkbenchModelId as ModelId,
  WorkbenchParsedDiffLine as ParsedDiffLine,
  WorkbenchRepoSection,
  WorkbenchRepo,
  WorkbenchTranscriptEvent as TranscriptEvent,
} from "@sandbox-agent/foundry-shared";

export const MODEL_GROUPS: ModelGroup[] = [
  {
    provider: "Claude",
    models: [
      { id: "claude-sonnet-4", label: "Sonnet 4" },
      { id: "claude-opus-4", label: "Opus 4" },
    ],
  },
  {
    provider: "OpenAI",
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "o3", label: "o3" },
    ],
  },
];

const MOCK_REPLIES = [
  "Got it. I'll work on that now. Let me start by examining the relevant files...",
  "I've analyzed the codebase and found the relevant code. Making the changes now...",
  "Working on it. I'll update you once I have the implementation ready.",
  "Let me look into that. I'll trace through the code to understand the current behavior...",
  "Starting on this now. I'll need to modify a few files to implement this properly.",
];

let nextId = 100;

export function uid(): string {
  return String(++nextId);
}

export function nowMs(): number {
  return Date.now();
}

export function formatThinkingDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatMessageDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function modelLabel(id: ModelId): string {
  const group = MODEL_GROUPS.find((candidate) => candidate.models.some((model) => model.id === id));
  const model = group?.models.find((candidate) => candidate.id === id);
  return model && group ? `${group.provider} ${model.label}` : id;
}

export function providerAgent(provider: string): AgentKind {
  if (provider === "Claude") return "Claude";
  if (provider === "OpenAI") return "Codex";
  return "Cursor";
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function randomReply(): string {
  return MOCK_REPLIES[Math.floor(Math.random() * MOCK_REPLIES.length)]!;
}

const DIFF_PREFIX = "diff:";

export function isDiffTab(id: string): boolean {
  return id.startsWith(DIFF_PREFIX);
}

export function diffPath(id: string): string {
  return id.slice(DIFF_PREFIX.length);
}

export function diffTabId(path: string): string {
  return `${DIFF_PREFIX}${path}`;
}

export function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function messageOrder(id: string): number {
  const match = id.match(/\d+/);
  return match ? Number(match[0]) : 0;
}

interface LegacyMessage {
  id: string;
  role: "agent" | "user";
  agent: string | null;
  createdAtMs: number;
  lines: string[];
  durationMs?: number;
}

function transcriptText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return String(payload ?? "");
  }

  const envelope = payload as {
    method?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };

  if (envelope.params && typeof envelope.params === "object") {
    const prompt = (envelope.params as { prompt?: unknown }).prompt;
    if (Array.isArray(prompt)) {
      const text = prompt
        .map((item) => (item && typeof item === "object" ? (item as { text?: unknown }).text : null))
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join("\n");
      if (text) {
        return text;
      }
    }

    const paramsText = (envelope.params as { text?: unknown }).text;
    if (typeof paramsText === "string" && paramsText.trim().length > 0) {
      return paramsText.trim();
    }
  }

  if (envelope.result && typeof envelope.result === "object") {
    const resultText = (envelope.result as { text?: unknown }).text;
    if (typeof resultText === "string" && resultText.trim().length > 0) {
      return resultText.trim();
    }
  }

  if (envelope.error) {
    return JSON.stringify(envelope.error);
  }

  if (typeof envelope.method === "string") {
    return envelope.method;
  }

  return JSON.stringify(payload);
}

function historyPreview(event: TranscriptEvent): string {
  const content = transcriptText(event.payload).trim() || "Untitled event";
  return content.length > 42 ? `${content.slice(0, 39)}...` : content;
}

function historyDetail(event: TranscriptEvent): string {
  const content = transcriptText(event.payload).trim();
  return content || "Untitled event";
}

export function buildHistoryEvents(tabs: AgentTab[]): HistoryEvent[] {
  return tabs
    .flatMap((tab) =>
      tab.transcript
        .filter((event) => event.sender === "client")
        .map((event) => ({
          id: `history-${tab.id}-${event.id}`,
          messageId: event.id,
          preview: historyPreview(event),
          sessionName: tab.sessionName,
          tabId: tab.id,
          createdAtMs: event.createdAt,
          detail: historyDetail(event),
        })),
    )
    .sort((left, right) => messageOrder(left.messageId) - messageOrder(right.messageId));
}

function transcriptFromLegacyMessages(sessionId: string, messages: LegacyMessage[]): TranscriptEvent[] {
  return messages.map((message, index) => ({
    id: message.id,
    eventIndex: index + 1,
    sessionId,
    createdAt: message.createdAtMs,
    connectionId: "mock-connection",
    sender: message.role === "user" ? "client" : "agent",
    payload:
      message.role === "user"
        ? {
            method: "session/prompt",
            params: {
              prompt: message.lines.map((line) => ({ type: "text", text: line })),
            },
          }
        : {
            result: {
              text: message.lines.join("\n"),
              durationMs: message.durationMs,
            },
          },
  }));
}

const NOW_MS = Date.now();

function minutesAgo(minutes: number): number {
  return NOW_MS - minutes * 60_000;
}

export function parseDiffLines(diff: string): ParsedDiffLine[] {
  return diff.split("\n").map((text, index) => {
    if (text.startsWith("@@")) {
      return { kind: "hunk", lineNumber: index + 1, text };
    }
    if (text.startsWith("+")) {
      return { kind: "add", lineNumber: index + 1, text };
    }
    if (text.startsWith("-")) {
      return { kind: "remove", lineNumber: index + 1, text };
    }
    return { kind: "context", lineNumber: index + 1, text };
  });
}

export function removeFileTreePath(nodes: FileTreeNode[], targetPath: string): FileTreeNode[] {
  return nodes.flatMap((node) => {
    if (node.path === targetPath) {
      return [];
    }

    if (!node.children) {
      return [node];
    }

    const nextChildren = removeFileTreePath(node.children, targetPath);
    if (node.isDir && nextChildren.length === 0) {
      return [];
    }

    return [{ ...node, children: nextChildren }];
  });
}

export function buildInitialTasks(): Task[] {
  return [
    {
      id: "h1",
      repoId: "acme-backend",
      title: "Fix auth token refresh",
      status: "idle",
      repoName: "acme/backend",
      updatedAtMs: minutesAgo(2),
      branch: "fix/auth-token-refresh",
      pullRequest: { number: 47, status: "draft" },
      tabs: [
        {
          id: "t1",
          sessionId: "t1",
          sessionName: "Auth token fix",
          agent: "Claude",
          model: "claude-sonnet-4",
          status: "idle",
          thinkingSinceMs: null,
          unread: false,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("t1", [
            {
              id: "m1",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(12),
              lines: [
                "I'll fix the auth token refresh logic. Let me start by examining the current implementation in `src/auth/token-manager.ts`.",
                "",
                "Found the issue - the refresh interval is set to 1 hour but the token expires in 5 minutes. Updating now.",
              ],
              durationMs: 12_000,
            },
            {
              id: "m2",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(11),
              lines: [
                "Fixed token refresh in `src/auth/token-manager.ts`. Also updated the retry logic in `src/api/client.ts` to handle 401 responses gracefully.",
              ],
              durationMs: 18_000,
            },
            {
              id: "m3",
              role: "user",
              agent: null,
              createdAtMs: minutesAgo(10),
              lines: ["Can you also add unit tests for the refresh logic?"],
            },
            {
              id: "m4",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(9),
              lines: ["Writing tests now in `src/auth/__tests__/token-manager.test.ts`..."],
              durationMs: 9_000,
            },
          ]),
        },
        {
          id: "t2",
          sessionId: "t2",
          sessionName: "Code analysis",
          agent: "Codex",
          model: "gpt-4o",
          status: "idle",
          thinkingSinceMs: null,
          unread: true,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("t2", [
            {
              id: "m5",
              role: "agent",
              agent: "codex",
              createdAtMs: minutesAgo(15),
              lines: ["Analyzed the codebase. The auth module uses a simple in-memory token cache with no refresh mechanism."],
              durationMs: 21_000,
            },
            {
              id: "m6",
              role: "agent",
              agent: "codex",
              createdAtMs: minutesAgo(14),
              lines: ["Suggested approach: add a refresh timer that fires before token expiry. I'll wait for instructions."],
              durationMs: 7_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "src/auth/token-manager.ts", added: 18, removed: 5, type: "M" },
        { path: "src/api/client.ts", added: 8, removed: 3, type: "M" },
        { path: "src/auth/__tests__/token-manager.test.ts", added: 21, removed: 0, type: "A" },
        { path: "src/types/auth.ts", added: 0, removed: 4, type: "M" },
      ],
      diffs: {
        "src/auth/token-manager.ts": [
          "@@ -21,10 +21,15 @@ import { TokenCache } from './cache';",
          " export class TokenManager {",
          "   private refreshInterval: number;",
          " ",
          "-  const REFRESH_MS = 3_600_000; // 1 hour",
          "+  const REFRESH_MS = 300_000; // 5 minutes",
          " ",
          "+  async refreshToken(): Promise<string> {",
          "+    const newToken = await this.fetchNewToken();",
          "+    this.cache.set(newToken);",
          "+    return newToken;",
          "+  }",
          " ",
          "-  private async onExpiry() {",
          "-    console.log('token expired');",
          "-    this.logout();",
          "-  }",
          "+  private async onExpiry() {",
          "+    try {",
          "+      await this.refreshToken();",
          "+    } catch { this.logout(); }",
          "+  }",
        ].join("\n"),
        "src/api/client.ts": [
          "@@ -45,8 +45,16 @@ export class ApiClient {",
          "   private async request<T>(url: string, opts?: RequestInit): Promise<T> {",
          "     const token = await this.tokenManager.getToken();",
          "     const res = await fetch(url, {",
          "-      ...opts,",
          "-      headers: { Authorization: `Bearer ${token}` },",
          "+      ...opts, headers: {",
          "+        ...opts?.headers,",
          "+        Authorization: `Bearer ${token}`,",
          "+      },",
          "     });",
          "-    return res.json();",
          "+    if (res.status === 401) {",
          "+      const freshToken = await this.tokenManager.refreshToken();",
          "+      const retry = await fetch(url, {",
          "+        ...opts, headers: { ...opts?.headers, Authorization: `Bearer ${freshToken}` },",
          "+      });",
          "+      return retry.json();",
          "+    }",
          "+    return res.json() as T;",
          "   }",
        ].join("\n"),
        "src/auth/__tests__/token-manager.test.ts": [
          "@@ -0,0 +1,21 @@",
          "+import { describe, it, expect, vi } from 'vitest';",
          "+import { TokenManager } from '../token-manager';",
          "+",
          "+describe('TokenManager', () => {",
          "+  it('refreshes token before expiry', async () => {",
          "+    const mgr = new TokenManager({ expiresIn: 100 });",
          "+    const first = await mgr.getToken();",
          "+    await new Promise(r => setTimeout(r, 150));",
          "+    const second = await mgr.getToken();",
          "+    expect(second).not.toBe(first);",
          "+  });",
          "+",
          "+  it('retries on 401', async () => {",
          "+    const mgr = new TokenManager();",
          "+    const spy = vi.spyOn(mgr, 'refreshToken');",
          "+    await mgr.handleUnauthorized();",
          "+    expect(spy).toHaveBeenCalledOnce();",
          "+  });",
          "+",
          "+  it('logs out after max retries', async () => {",
          "+    const mgr = new TokenManager({ maxRetries: 0 });",
          "+    await expect(mgr.handleUnauthorized()).rejects.toThrow();",
          "+  });",
          "+});",
        ].join("\n"),
        "src/types/auth.ts": [
          "@@ -8,10 +8,6 @@ export interface AuthConfig {",
          "   clientId: string;",
          "   clientSecret: string;",
          "   redirectUri: string;",
          "-  /** @deprecated Use refreshInterval instead */",
          "-  legacyTimeout?: number;",
          "-  /** @deprecated */",
          "-  useOldRefresh?: boolean;",
          " }",
          " ",
          " export interface TokenPayload {",
        ].join("\n"),
      },
      fileTree: [
        {
          name: "src",
          path: "src",
          isDir: true,
          children: [
            {
              name: "api",
              path: "src/api",
              isDir: true,
              children: [{ name: "client.ts", path: "src/api/client.ts", isDir: false }],
            },
            {
              name: "auth",
              path: "src/auth",
              isDir: true,
              children: [
                {
                  name: "__tests__",
                  path: "src/auth/__tests__",
                  isDir: true,
                  children: [{ name: "token-manager.test.ts", path: "src/auth/__tests__/token-manager.test.ts", isDir: false }],
                },
                { name: "token-manager.ts", path: "src/auth/token-manager.ts", isDir: false },
              ],
            },
            {
              name: "types",
              path: "src/types",
              isDir: true,
              children: [{ name: "auth.ts", path: "src/types/auth.ts", isDir: false }],
            },
          ],
        },
      ],
    },
    {
      id: "h3",
      repoId: "acme-backend",
      title: "Refactor user service",
      status: "idle",
      repoName: "acme/backend",
      updatedAtMs: minutesAgo(5),
      branch: "refactor/user-service",
      pullRequest: { number: 52, status: "ready" },
      tabs: [
        {
          id: "t4",
          sessionId: "t4",
          sessionName: "DI refactor",
          agent: "Claude",
          model: "claude-opus-4",
          status: "idle",
          thinkingSinceMs: null,
          unread: false,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("t4", [
            {
              id: "m20",
              role: "user",
              agent: null,
              createdAtMs: minutesAgo(35),
              lines: ["Refactor the user service to use dependency injection."],
            },
            {
              id: "m21",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(34),
              lines: ["Starting refactor. I'll extract interfaces and set up a DI container..."],
              durationMs: 14_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "src/services/user-service.ts", added: 45, removed: 30, type: "M" },
        { path: "src/services/interfaces.ts", added: 22, removed: 0, type: "A" },
        { path: "src/container.ts", added: 15, removed: 0, type: "A" },
      ],
      diffs: {
        "src/services/user-service.ts": [
          "@@ -1,35 +1,50 @@",
          "-import { db } from '../db';",
          "-import { hashPassword, verifyPassword } from '../utils/crypto';",
          "-import { sendEmail } from '../utils/email';",
          "+import type { IUserRepository, IEmailService, IHashService } from './interfaces';",
          " ",
          "-export class UserService {",
          "-  async createUser(email: string, password: string) {",
          "-    const hash = await hashPassword(password);",
          "-    const user = await db.users.create({",
          "-      email,",
          "-      passwordHash: hash,",
          "-      createdAt: new Date(),",
          "-    });",
          "-    await sendEmail(email, 'Welcome!', 'Thanks for signing up.');",
          "-    return user;",
          "+export class UserService {",
          "+  constructor(",
          "+    private readonly users: IUserRepository,",
          "+    private readonly email: IEmailService,",
          "+    private readonly hash: IHashService,",
          "+  ) {}",
          "+",
          "+  async createUser(email: string, password: string) {",
          "+    const passwordHash = await this.hash.hash(password);",
          "+    const user = await this.users.create({ email, passwordHash });",
          "+    await this.email.send(email, 'Welcome!', 'Thanks for signing up.');",
          "+    return user;",
          "   }",
          " ",
          "-  async authenticate(email: string, password: string) {",
          "-    const user = await db.users.findByEmail(email);",
          "+  async authenticate(email: string, password: string) {",
          "+    const user = await this.users.findByEmail(email);",
          "     if (!user) throw new Error('User not found');",
          "-    const valid = await verifyPassword(password, user.passwordHash);",
          "+    const valid = await this.hash.verify(password, user.passwordHash);",
          "     if (!valid) throw new Error('Invalid password');",
          "     return user;",
          "   }",
          " ",
          "-  async deleteUser(id: string) {",
          "-    await db.users.delete(id);",
          "+  async deleteUser(id: string) {",
          "+    const user = await this.users.findById(id);",
          "+    if (!user) throw new Error('User not found');",
          "+    await this.users.delete(id);",
          "+    await this.email.send(user.email, 'Account deleted', 'Your account has been removed.');",
          "   }",
          " }",
        ].join("\n"),
        "src/services/interfaces.ts": [
          "@@ -0,0 +1,22 @@",
          "+export interface IUserRepository {",
          "+  create(data: { email: string; passwordHash: string }): Promise<User>;",
          "+  findByEmail(email: string): Promise<User | null>;",
          "+  findById(id: string): Promise<User | null>;",
          "+  delete(id: string): Promise<void>;",
          "+}",
          "+",
          "+export interface IEmailService {",
          "+  send(to: string, subject: string, body: string): Promise<void>;",
          "+}",
          "+",
          "+export interface IHashService {",
          "+  hash(password: string): Promise<string>;",
          "+  verify(password: string, hash: string): Promise<boolean>;",
          "+}",
          "+",
          "+export interface User {",
          "+  id: string;",
          "+  email: string;",
          "+  passwordHash: string;",
          "+  createdAt: Date;",
          "+}",
        ].join("\n"),
        "src/container.ts": [
          "@@ -0,0 +1,15 @@",
          "+import { UserService } from './services/user-service';",
          "+import { DrizzleUserRepository } from './repos/user-repo';",
          "+import { ResendEmailService } from './providers/email';",
          "+import { Argon2HashService } from './providers/hash';",
          "+import { db } from './db';",
          "+",
          "+const userRepo = new DrizzleUserRepository(db);",
          "+const emailService = new ResendEmailService();",
          "+const hashService = new Argon2HashService();",
          "+",
          "+export const userService = new UserService(",
          "+  userRepo,",
          "+  emailService,",
          "+  hashService,",
          "+);",
        ].join("\n"),
      },
      fileTree: [
        {
          name: "src",
          path: "src",
          isDir: true,
          children: [
            { name: "container.ts", path: "src/container.ts", isDir: false },
            {
              name: "services",
              path: "src/services",
              isDir: true,
              children: [
                { name: "interfaces.ts", path: "src/services/interfaces.ts", isDir: false },
                { name: "user-service.ts", path: "src/services/user-service.ts", isDir: false },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "h2",
      repoId: "acme-frontend",
      title: "Add dark mode toggle",
      status: "idle",
      repoName: "acme/frontend",
      updatedAtMs: minutesAgo(15),
      branch: "feat/dark-mode",
      pullRequest: null,
      tabs: [
        {
          id: "t3",
          sessionId: "t3",
          sessionName: "Dark mode",
          agent: "Claude",
          model: "claude-sonnet-4",
          status: "idle",
          thinkingSinceMs: null,
          unread: true,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("t3", [
            {
              id: "m10",
              role: "user",
              agent: null,
              createdAtMs: minutesAgo(75),
              lines: ["Add a dark mode toggle to the settings page."],
            },
            {
              id: "m11",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(74),
              lines: [
                "I've added a dark mode toggle to the settings page. The implementation uses CSS custom properties for theming and persists the user's preference to localStorage.",
              ],
              durationMs: 26_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "src/components/settings.tsx", added: 32, removed: 2, type: "M" },
        { path: "src/styles/theme.css", added: 45, removed: 0, type: "A" },
      ],
      diffs: {
        "src/components/settings.tsx": [
          "@@ -1,5 +1,6 @@",
          " import React, { useState, useEffect } from 'react';",
          "+import { useTheme } from '../hooks/use-theme';",
          " import { Card } from './ui/card';",
          " import { Toggle } from './ui/toggle';",
          " import { Label } from './ui/label';",
          "@@ -15,8 +16,38 @@ export function Settings() {",
          "   const [notifications, setNotifications] = useState(true);",
          "+  const { theme, setTheme } = useTheme();",
          "+  const [isDark, setIsDark] = useState(theme === 'dark');",
          " ",
          "   return (",
          '     <div className="settings-page">',
          "+      <Card>",
          "+        <h3>Appearance</h3>",
          '+        <div className="setting-row">',
          '+          <Label htmlFor="dark-mode">Dark Mode</Label>',
          "+          <Toggle",
          '+            id="dark-mode"',
          "+            checked={isDark}",
          "+            onCheckedChange={(checked) => {",
          "+              setIsDark(checked);",
          "+              setTheme(checked ? 'dark' : 'light');",
          "+              document.documentElement.setAttribute(",
          "+                'data-theme',",
          "+                checked ? 'dark' : 'light'",
          "+              );",
          "+            }}",
          "+          />",
          "+        </div>",
          '+        <p className="setting-description">',
          "+          Toggle between light and dark color schemes.",
          "+          Your preference is saved to localStorage.",
          "+        </p>",
          "+      </Card>",
          "+",
          "       <Card>",
          "         <h3>Notifications</h3>",
          '         <div className="setting-row">',
          "-          <Label>Email notifications</Label>",
          "-          <Toggle checked={notifications} onCheckedChange={setNotifications} />",
          '+          <Label htmlFor="notifs">Email notifications</Label>',
          '+          <Toggle id="notifs" checked={notifications} onCheckedChange={setNotifications} />',
          "         </div>",
          "       </Card>",
        ].join("\n"),
        "src/styles/theme.css": [
          "@@ -0,0 +1,45 @@",
          "+:root {",
          "+  --bg-primary: #ffffff;",
          "+  --bg-secondary: #f8f9fa;",
          "+  --bg-tertiary: #e9ecef;",
          "+  --text-primary: #212529;",
          "+  --text-secondary: #495057;",
          "+  --text-muted: #868e96;",
          "+  --border-color: #dee2e6;",
          "+  --accent: #228be6;",
          "+  --accent-hover: #1c7ed6;",
          "+}",
          "+",
          "+[data-theme='dark'] {",
          "+  --bg-primary: #09090b;",
          "+  --bg-secondary: #18181b;",
          "+  --bg-tertiary: #27272a;",
          "+  --text-primary: #fafafa;",
          "+  --text-secondary: #a1a1aa;",
          "+  --text-muted: #71717a;",
          "+  --border-color: #3f3f46;",
          "+  --accent: #ff4f00;",
          "+  --accent-hover: #ff6a00;",
          "+}",
          "+",
          "+body {",
          "+  background: var(--bg-primary);",
          "+  color: var(--text-primary);",
          "+  transition: background 0.2s ease, color 0.2s ease;",
          "+}",
          "+",
          "+.card {",
          "+  background: var(--bg-secondary);",
          "+  border: 1px solid var(--border-color);",
          "+  border-radius: 8px;",
          "+  padding: 16px 20px;",
          "+}",
          "+",
          "+.setting-row {",
          "+  display: flex;",
          "+  align-items: center;",
          "+  justify-content: space-between;",
          "+  padding: 8px 0;",
          "+}",
          "+",
          "+.setting-description {",
          "+  color: var(--text-muted);",
          "+  font-size: 13px;",
          "+  margin-top: 4px;",
          "+}",
        ].join("\n"),
      },
      fileTree: [
        {
          name: "src",
          path: "src",
          isDir: true,
          children: [
            {
              name: "components",
              path: "src/components",
              isDir: true,
              children: [{ name: "settings.tsx", path: "src/components/settings.tsx", isDir: false }],
            },
            {
              name: "styles",
              path: "src/styles",
              isDir: true,
              children: [{ name: "theme.css", path: "src/styles/theme.css", isDir: false }],
            },
          ],
        },
      ],
    },
    {
      id: "h5",
      repoId: "acme-infra",
      title: "Update CI pipeline",
      status: "archived",
      repoName: "acme/infra",
      updatedAtMs: minutesAgo(2 * 24 * 60 + 10),
      branch: "chore/ci-pipeline",
      pullRequest: { number: 38, status: "ready" },
      tabs: [
        {
          id: "t6",
          sessionId: "t6",
          sessionName: "CI pipeline",
          agent: "Claude",
          model: "claude-sonnet-4",
          status: "idle",
          thinkingSinceMs: null,
          unread: false,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("t6", [
            {
              id: "m30",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(2 * 24 * 60 + 60),
              lines: ["CI pipeline updated. Added caching for node_modules and parallel test execution."],
              durationMs: 33_000,
            },
          ]),
        },
      ],
      fileChanges: [{ path: ".github/workflows/ci.yml", added: 20, removed: 8, type: "M" }],
      diffs: {
        ".github/workflows/ci.yml": [
          "@@ -12,14 +12,26 @@ jobs:",
          "   build:",
          "     runs-on: ubuntu-latest",
          "     steps:",
          "-      - uses: actions/checkout@v3",
          "-      - uses: actions/setup-node@v3",
          "+      - uses: actions/checkout@v4",
          "+      - uses: actions/setup-node@v4",
          "         with:",
          "           node-version: 20",
          "-      - run: npm ci",
          "-      - run: npm run build",
          "-      - run: npm test",
          "+          cache: 'pnpm'",
          "+      - uses: pnpm/action-setup@v4",
          "+      - run: pnpm install --frozen-lockfile",
          "+      - run: pnpm build",
          "+",
          "+  test:",
          "+    runs-on: ubuntu-latest",
          "+    needs: build",
          "+    strategy:",
          "+      matrix:",
          "+        shard: [1, 2, 3]",
          "+    steps:",
          "+      - uses: actions/checkout@v4",
          "+      - uses: actions/setup-node@v4",
          "+        with:",
          "+          node-version: 20",
          "+          cache: 'pnpm'",
          "+      - uses: pnpm/action-setup@v4",
          "+      - run: pnpm install --frozen-lockfile",
          "+      - run: pnpm test -- --shard=${{ matrix.shard }}/3",
          " ",
          "-  deploy:",
          "-    needs: build",
          "-    if: github.ref == 'refs/heads/main'",
          "+  deploy:",
          "+    needs: [build, test]",
          "+    if: github.ref == 'refs/heads/main'",
        ].join("\n"),
      },
      fileTree: [
        {
          name: ".github",
          path: ".github",
          isDir: true,
          children: [
            {
              name: "workflows",
              path: ".github/workflows",
              isDir: true,
              children: [{ name: "ci.yml", path: ".github/workflows/ci.yml", isDir: false }],
            },
          ],
        },
      ],
    },
  ];
}

function buildPersonalTasks(ownerName: string, repoId: string, repoName: string): Task[] {
  return [
    {
      id: "h-personal-1",
      repoId,
      title: "Polish onboarding copy",
      status: "idle",
      repoName,
      updatedAtMs: minutesAgo(18),
      branch: "feat/onboarding-copy",
      pullRequest: null,
      tabs: [
        {
          id: "personal-t1",
          sessionId: "personal-t1",
          sessionName: "Landing page copy",
          agent: "Claude",
          model: "claude-sonnet-4",
          status: "idle",
          thinkingSinceMs: null,
          unread: false,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("personal-t1", [
            {
              id: "pm1",
              role: "user",
              agent: null,
              createdAtMs: minutesAgo(22),
              lines: [`Tighten the hero copy and call-to-action for ${ownerName}'s landing page.`],
            },
            {
              id: "pm2",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(20),
              lines: [
                "Updated the hero copy to focus on speed-to-task and clearer user outcomes.",
                "",
                "I also adjusted the primary CTA to feel more action-oriented.",
              ],
              durationMs: 11_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "src/content/home.ts", added: 12, removed: 6, type: "M" },
        { path: "src/components/Hero.tsx", added: 8, removed: 3, type: "M" },
      ],
      diffs: {
        "src/content/home.ts": [
          "@@ -1,6 +1,9 @@",
          "-export const heroHeadline = 'Build AI tasks faster';",
          "+export const heroHeadline = 'Ship clean tasks without the chaos';",
          " export const heroBody = [",
          "-  'OpenTask keeps context, diffs, and follow-up work in one place.',",
          "+  'Review work, keep context, and hand tasks across your team without losing the thread.',",
          "+  'Everything stays attached to the repo, the branch, and the transcript.',",
          " ];",
        ].join("\n"),
      },
      fileTree: [
        {
          name: "src",
          path: "src",
          isDir: true,
          children: [
            {
              name: "components",
              path: "src/components",
              isDir: true,
              children: [{ name: "Hero.tsx", path: "src/components/Hero.tsx", isDir: false }],
            },
            {
              name: "content",
              path: "src/content",
              isDir: true,
              children: [{ name: "home.ts", path: "src/content/home.ts", isDir: false }],
            },
          ],
        },
      ],
    },
  ];
}

function buildRivetTasks(): Task[] {
  return [
    {
      id: "rivet-h1",
      repoId: "rivet-dashboard",
      title: "Add billing upgrade affordances",
      status: "running",
      repoName: "rivet/dashboard",
      updatedAtMs: minutesAgo(6),
      branch: "feat/billing-upgrade-affordances",
      pullRequest: { number: 183, status: "draft" },
      tabs: [
        {
          id: "rivet-t1",
          sessionId: "rivet-t1",
          sessionName: "Upgrade surface",
          agent: "Codex",
          model: "o3",
          status: "running",
          thinkingSinceMs: minutesAgo(1),
          unread: false,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("rivet-t1", [
            {
              id: "rm1",
              role: "user",
              agent: null,
              createdAtMs: minutesAgo(8),
              lines: ["Add an upgrade CTA on the usage banner and thread it into the hosted checkout flow."],
            },
            {
              id: "rm2",
              role: "agent",
              agent: "codex",
              createdAtMs: minutesAgo(7),
              lines: ["I'm wiring the banner CTA to the checkout route and cleaning up the plan comparison copy."],
              durationMs: 16_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "src/routes/settings/billing.tsx", added: 34, removed: 8, type: "M" },
        { path: "src/components/usage-banner.tsx", added: 12, removed: 0, type: "A" },
      ],
      diffs: {
        "src/routes/settings/billing.tsx": [
          "@@ -14,7 +14,13 @@",
          " export function BillingSettings() {",
          "-  return <EmptyState />;",
          "+  return (",
          "+    <>",
          '+      <UsageBanner ctaLabel="Upgrade with Stripe" />',
          "+      <PlanMatrix />",
          "+    </>",
          "+  );",
          " }",
        ].join("\n"),
      },
      fileTree: [
        {
          name: "src",
          path: "src",
          isDir: true,
          children: [
            {
              name: "components",
              path: "src/components",
              isDir: true,
              children: [{ name: "usage-banner.tsx", path: "src/components/usage-banner.tsx", isDir: false }],
            },
            {
              name: "routes",
              path: "src/routes",
              isDir: true,
              children: [
                {
                  name: "settings",
                  path: "src/routes/settings",
                  isDir: true,
                  children: [{ name: "billing.tsx", path: "src/routes/settings/billing.tsx", isDir: false }],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

export function buildInitialMockLayoutViewModel(workspaceId = "default"): TaskWorkbenchSnapshot {
  let repos: WorkbenchRepo[];
  let tasks: Task[];

  switch (workspaceId) {
    case "personal-nathan":
      repos = [{ id: "nathan-personal-site", label: "nathan/personal-site" }];
      tasks = buildPersonalTasks("Nathan", "nathan-personal-site", "nathan/personal-site");
      break;
    case "personal-jamie":
      repos = [{ id: "jamie-demo-app", label: "jamie/demo-app" }];
      tasks = buildPersonalTasks("Jamie", "jamie-demo-app", "jamie/demo-app");
      break;
    case "rivet":
      repos = [
        { id: "rivet-dashboard", label: "rivet/dashboard" },
        { id: "rivet-agents", label: "rivet/agents" },
        { id: "rivet-billing", label: "rivet/billing" },
        { id: "rivet-infrastructure", label: "rivet/infrastructure" },
      ];
      tasks = buildRivetTasks();
      break;
    case "acme":
    case "default":
    default:
      repos = [
        { id: "acme-backend", label: "acme/backend" },
        { id: "acme-frontend", label: "acme/frontend" },
        { id: "acme-infra", label: "acme/infra" },
      ];
      tasks = buildInitialTasks();
      break;
  }

  return {
    workspaceId,
    repos,
    repoSections: groupWorkbenchRepos(repos, tasks),
    tasks,
  };
}

export function groupWorkbenchRepos(repos: WorkbenchRepo[], tasks: Task[]): WorkbenchRepoSection[] {
  const grouped = new Map<string, WorkbenchRepoSection>();

  for (const repo of repos) {
    grouped.set(repo.id, {
      id: repo.id,
      label: repo.label,
      updatedAtMs: 0,
      tasks: [],
    });
  }

  for (const task of tasks) {
    const linkedRepoIds = task.repoIds?.length ? task.repoIds : [task.repoId];
    for (const repoId of linkedRepoIds) {
      const existing = grouped.get(repoId) ?? {
        id: repoId,
        label: repoId === task.repoId ? task.repoName : repoId,
        updatedAtMs: 0,
        tasks: [],
      };

      existing.tasks.push(task);
      existing.updatedAtMs = Math.max(existing.updatedAtMs, task.updatedAtMs);
      grouped.set(repoId, existing);
    }
  }

  return [...grouped.values()]
    .map((repoSection) => ({
      ...repoSection,
      tasks: [...repoSection.tasks].sort((a, b) => b.updatedAtMs - a.updatedAtMs),
      updatedAtMs: repoSection.tasks.length > 0 ? Math.max(...repoSection.tasks.map((task) => task.updatedAtMs)) : repoSection.updatedAtMs,
    }))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}
