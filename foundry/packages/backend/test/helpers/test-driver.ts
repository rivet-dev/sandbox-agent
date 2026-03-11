import type {
  BackendDriver,
  DaytonaClientLike,
  DaytonaDriver,
  GitDriver,
  GithubDriver,
  StackDriver,
  SandboxAgentDriver,
  SandboxAgentClientLike,
  TmuxDriver,
} from "../../src/driver.js";
import type { ListEventsRequest, ListPage, ListPageRequest, ProcessInfo, ProcessLogsResponse, SessionEvent, SessionRecord } from "sandbox-agent";

export function createTestDriver(overrides?: Partial<BackendDriver>): BackendDriver {
  return {
    git: overrides?.git ?? createTestGitDriver(),
    stack: overrides?.stack ?? createTestStackDriver(),
    github: overrides?.github ?? createTestGithubDriver(),
    sandboxAgent: overrides?.sandboxAgent ?? createTestSandboxAgentDriver(),
    daytona: overrides?.daytona ?? createTestDaytonaDriver(),
    tmux: overrides?.tmux ?? createTestTmuxDriver(),
  };
}

export function createTestGitDriver(overrides?: Partial<GitDriver>): GitDriver {
  return {
    validateRemote: async () => {},
    ensureCloned: async () => {},
    fetch: async () => {},
    listRemoteBranches: async () => [],
    remoteDefaultBaseRef: async () => "origin/main",
    revParse: async () => "abc1234567890",
    ensureRemoteBranch: async () => {},
    diffStatForBranch: async () => "+0/-0",
    conflictsWithMain: async () => false,
    ...overrides,
  };
}

export function createTestStackDriver(overrides?: Partial<StackDriver>): StackDriver {
  return {
    available: async () => false,
    listStack: async () => [],
    syncRepo: async () => {},
    restackRepo: async () => {},
    restackSubtree: async () => {},
    rebaseBranch: async () => {},
    reparentBranch: async () => {},
    trackBranch: async () => {},
    ...overrides,
  };
}

export function createTestGithubDriver(overrides?: Partial<GithubDriver>): GithubDriver {
  return {
    listPullRequests: async () => [],
    createPr: async (_repoPath, _headBranch, _title) => ({
      number: 1,
      url: `https://github.com/test/repo/pull/1`,
    }),
    starRepository: async () => {},
    ...overrides,
  };
}

export function createTestSandboxAgentDriver(overrides?: Partial<SandboxAgentDriver>): SandboxAgentDriver {
  return {
    createClient: (_opts) => createTestSandboxAgentClient(),
    ...overrides,
  };
}

export function createTestSandboxAgentClient(overrides?: Partial<SandboxAgentClientLike>): SandboxAgentClientLike {
  const defaultProcess: ProcessInfo = {
    id: "process-1",
    command: "bash",
    args: ["-lc", "echo test"],
    createdAtMs: Date.now(),
    cwd: "/workspace",
    exitCode: null,
    exitedAtMs: null,
    interactive: true,
    pid: 123,
    status: "running",
    tty: true,
  };
  const defaultLogs: ProcessLogsResponse = {
    processId: defaultProcess.id,
    stream: "combined",
    entries: [],
  };
  return {
    createSession: async (_prompt) => ({ id: "test-session-1", status: "running" }),
    sessionStatus: async (sessionId) => ({ id: sessionId, status: "running" }),
    listSessions: async (_request?: ListPageRequest): Promise<ListPage<SessionRecord>> => ({
      items: [],
      nextCursor: undefined,
    }),
    listEvents: async (_request: ListEventsRequest): Promise<ListPage<SessionEvent>> => ({
      items: [],
      nextCursor: undefined,
    }),
    createProcess: async () => defaultProcess,
    listProcesses: async () => ({ processes: [defaultProcess] }),
    getProcessLogs: async () => defaultLogs,
    stopProcess: async () => ({ ...defaultProcess, status: "exited", exitCode: 0, exitedAtMs: Date.now() }),
    killProcess: async () => ({ ...defaultProcess, status: "exited", exitCode: 137, exitedAtMs: Date.now() }),
    deleteProcess: async () => {},
    sendPrompt: async (_request) => {},
    cancelSession: async (_sessionId) => {},
    destroySession: async (_sessionId) => {},
    ...overrides,
  };
}

export function createTestDaytonaDriver(overrides?: Partial<DaytonaDriver>): DaytonaDriver {
  return {
    createClient: (_opts) => createTestDaytonaClient(),
    ...overrides,
  };
}

export function createTestDaytonaClient(overrides?: Partial<DaytonaClientLike>): DaytonaClientLike {
  return {
    createSandbox: async () => ({ id: "sandbox-test-1", state: "started" }),
    getSandbox: async (sandboxId) => ({ id: sandboxId, state: "started" }),
    startSandbox: async () => {},
    stopSandbox: async () => {},
    deleteSandbox: async () => {},
    executeCommand: async () => ({ exitCode: 0, result: "" }),
    getPreviewEndpoint: async (sandboxId, port) => ({
      url: `https://preview.example/sandbox/${sandboxId}/port/${port}`,
      token: "preview-token",
    }),
    ...overrides,
  };
}

export function createTestTmuxDriver(overrides?: Partial<TmuxDriver>): TmuxDriver {
  return {
    setWindowStatus: () => 0,
    ...overrides,
  };
}
