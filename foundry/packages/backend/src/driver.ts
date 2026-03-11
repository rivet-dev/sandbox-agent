import type { BranchSnapshot } from "./integrations/git/index.js";
import type { PullRequestSnapshot } from "./integrations/github/index.js";
import type { SandboxSession, SandboxAgentClientOptions, SandboxSessionCreateRequest } from "./integrations/sandbox-agent/client.js";
import type {
  ListEventsRequest,
  ListPage,
  ListPageRequest,
  ProcessCreateRequest,
  ProcessInfo,
  ProcessLogFollowQuery,
  ProcessLogsResponse,
  ProcessSignalQuery,
  SessionEvent,
  SessionRecord,
} from "sandbox-agent";
import type { DaytonaClientOptions, DaytonaCreateSandboxOptions, DaytonaPreviewEndpoint, DaytonaSandbox } from "./integrations/daytona/client.js";
import {
  validateRemote,
  ensureCloned,
  fetch,
  listRemoteBranches,
  remoteDefaultBaseRef,
  revParse,
  ensureRemoteBranch,
  diffStatForBranch,
  conflictsWithMain,
} from "./integrations/git/index.js";
import {
  gitSpiceAvailable,
  gitSpiceListStack,
  gitSpiceRebaseBranch,
  gitSpiceReparentBranch,
  gitSpiceRestackRepo,
  gitSpiceRestackSubtree,
  gitSpiceSyncRepo,
  gitSpiceTrackBranch,
} from "./integrations/git-spice/index.js";
import { listPullRequests, createPr, starRepository } from "./integrations/github/index.js";
import { SandboxAgentClient } from "./integrations/sandbox-agent/client.js";
import { DaytonaClient } from "./integrations/daytona/client.js";

export interface GitDriver {
  validateRemote(remoteUrl: string): Promise<void>;
  ensureCloned(remoteUrl: string, targetPath: string): Promise<void>;
  fetch(repoPath: string): Promise<void>;
  listRemoteBranches(repoPath: string): Promise<BranchSnapshot[]>;
  remoteDefaultBaseRef(repoPath: string): Promise<string>;
  revParse(repoPath: string, ref: string): Promise<string>;
  ensureRemoteBranch(repoPath: string, branchName: string): Promise<void>;
  diffStatForBranch(repoPath: string, branchName: string): Promise<string>;
  conflictsWithMain(repoPath: string, branchName: string): Promise<boolean>;
}

export interface StackBranchSnapshot {
  branchName: string;
  parentBranch: string | null;
}

export interface StackDriver {
  available(repoPath: string): Promise<boolean>;
  listStack(repoPath: string): Promise<StackBranchSnapshot[]>;
  syncRepo(repoPath: string): Promise<void>;
  restackRepo(repoPath: string): Promise<void>;
  restackSubtree(repoPath: string, branchName: string): Promise<void>;
  rebaseBranch(repoPath: string, branchName: string): Promise<void>;
  reparentBranch(repoPath: string, branchName: string, parentBranch: string): Promise<void>;
  trackBranch(repoPath: string, branchName: string, parentBranch: string): Promise<void>;
}

export interface GithubDriver {
  listPullRequests(repoPath: string): Promise<PullRequestSnapshot[]>;
  createPr(repoPath: string, headBranch: string, title: string, body?: string): Promise<{ number: number; url: string }>;
  starRepository(repoFullName: string): Promise<void>;
}

export interface SandboxAgentClientLike {
  createSession(request: string | SandboxSessionCreateRequest): Promise<SandboxSession>;
  sessionStatus(sessionId: string): Promise<SandboxSession>;
  listSessions(request?: ListPageRequest): Promise<ListPage<SessionRecord>>;
  listEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>>;
  createProcess(request: ProcessCreateRequest): Promise<ProcessInfo>;
  listProcesses(): Promise<{ processes: ProcessInfo[] }>;
  getProcessLogs(processId: string, query?: ProcessLogFollowQuery): Promise<ProcessLogsResponse>;
  stopProcess(processId: string, query?: ProcessSignalQuery): Promise<ProcessInfo>;
  killProcess(processId: string, query?: ProcessSignalQuery): Promise<ProcessInfo>;
  deleteProcess(processId: string): Promise<void>;
  sendPrompt(request: { sessionId: string; prompt: string; notification?: boolean }): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  destroySession(sessionId: string): Promise<void>;
}

export interface SandboxAgentDriver {
  createClient(options: SandboxAgentClientOptions): SandboxAgentClientLike;
}

export interface DaytonaClientLike {
  createSandbox(options: DaytonaCreateSandboxOptions): Promise<DaytonaSandbox>;
  getSandbox(sandboxId: string): Promise<DaytonaSandbox>;
  startSandbox(sandboxId: string, timeoutSeconds?: number): Promise<void>;
  stopSandbox(sandboxId: string, timeoutSeconds?: number): Promise<void>;
  deleteSandbox(sandboxId: string): Promise<void>;
  executeCommand(sandboxId: string, command: string): Promise<{ exitCode: number; result: string }>;
  getPreviewEndpoint(sandboxId: string, port: number): Promise<DaytonaPreviewEndpoint>;
}

export interface DaytonaDriver {
  createClient(options: DaytonaClientOptions): DaytonaClientLike;
}

export interface TmuxDriver {
  setWindowStatus(branchName: string, status: string): number;
}

export interface BackendDriver {
  git: GitDriver;
  stack: StackDriver;
  github: GithubDriver;
  sandboxAgent: SandboxAgentDriver;
  daytona: DaytonaDriver;
  tmux: TmuxDriver;
}

export function createDefaultDriver(): BackendDriver {
  const sandboxAgentClients = new Map<string, SandboxAgentClient>();
  const daytonaClients = new Map<string, DaytonaClient>();

  return {
    git: {
      validateRemote,
      ensureCloned,
      fetch,
      listRemoteBranches,
      remoteDefaultBaseRef,
      revParse,
      ensureRemoteBranch,
      diffStatForBranch,
      conflictsWithMain,
    },
    stack: {
      available: gitSpiceAvailable,
      listStack: gitSpiceListStack,
      syncRepo: gitSpiceSyncRepo,
      restackRepo: gitSpiceRestackRepo,
      restackSubtree: gitSpiceRestackSubtree,
      rebaseBranch: gitSpiceRebaseBranch,
      reparentBranch: gitSpiceReparentBranch,
      trackBranch: gitSpiceTrackBranch,
    },
    github: {
      listPullRequests,
      createPr,
      starRepository,
    },
    sandboxAgent: {
      createClient: (opts) => {
        if (opts.persist) {
          return new SandboxAgentClient(opts);
        }
        const key = `${opts.endpoint}|${opts.token ?? ""}|${opts.agent ?? ""}`;
        const cached = sandboxAgentClients.get(key);
        if (cached) {
          return cached;
        }
        const created = new SandboxAgentClient(opts);
        sandboxAgentClients.set(key, created);
        return created;
      },
    },
    daytona: {
      createClient: (opts) => {
        const key = `${opts.apiUrl ?? ""}|${opts.apiKey ?? ""}|${opts.target ?? ""}`;
        const cached = daytonaClients.get(key);
        if (cached) {
          return cached;
        }
        const created = new DaytonaClient(opts);
        daytonaClients.set(key, created);
        return created;
      },
    },
    tmux: {
      setWindowStatus: () => 0,
    },
  };
}
