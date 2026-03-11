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
  WorkbenchProjectSection,
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
    // ── rivet-dev/sandbox-agent ──
    {
      id: "h1",
      repoId: "sandbox-agent",
      title: "Normalize Pi ACP bootstrap payloads",
      status: "idle",
      repoName: "rivet-dev/sandbox-agent",
      updatedAtMs: minutesAgo(8),
      branch: "NathanFlurry/pi-bootstrap-fix",
      pullRequest: { number: 227, status: "ready" },
      tabs: [
        {
          id: "t1",
          sessionId: "t1",
          sessionName: "Pi payload fix",
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
              createdAtMs: minutesAgo(18),
              lines: [
                "I'll fix the Pi agent ACP bootstrap payloads. The `initialize` method sends `protocolVersion` as a string but Pi expects a number. Let me examine `acp_proxy_runtime.rs`.",
                "",
                "Found the issue — the ACP proxy forwards the raw JSON-RPC payload without normalizing field types per-agent. Adding a `normalize_payload_for_agent` pass before dispatch.",
              ],
              durationMs: 14_000,
            },
            {
              id: "m2",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(15),
              lines: [
                "Done. Added `normalize_pi_payload()` in `acp_proxy_runtime.rs` that converts `protocolVersion` from string to number for `initialize`, and ensures `mcpServers` is present in `session/new` params.",
              ],
              durationMs: 22_000,
            },
            {
              id: "m3",
              role: "user",
              agent: null,
              createdAtMs: minutesAgo(12),
              lines: ['Does this also handle the case where protocolVersion is a float string like "2.0"?'],
            },
            {
              id: "m4",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(11),
              lines: ['Yes — the `parse_json_number` helper tries u64, then i64, then f64 parsing in order. So "2.0" becomes `2.0` as a JSON number.'],
              durationMs: 8_000,
            },
          ]),
        },
        {
          id: "t2",
          sessionId: "t2",
          sessionName: "Test coverage",
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
              createdAtMs: minutesAgo(20),
              lines: ["Analyzed the normalize_pi_payload function. It handles `initialize` and `session/new` methods. I'll add unit tests for edge cases."],
              durationMs: 18_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "server/packages/sandbox-agent/src/acp_proxy_runtime.rs", added: 51, removed: 0, type: "M" },
        { path: "server/packages/sandbox-agent/src/acp_proxy_runtime_test.rs", added: 38, removed: 0, type: "A" },
      ],
      diffs: {
        "server/packages/sandbox-agent/src/acp_proxy_runtime.rs": [
          "@@ -134,6 +134,8 @@ impl AcpProxyRuntime {",
          '             "acp_proxy: instance resolved"',
          "         );",
          " ",
          "+        let payload = normalize_payload_for_agent(instance.agent, payload);",
          "+",
          "         match instance.runtime.post(payload).await {",
          "@@ -510,6 +512,57 @@ fn map_adapter_error(err: AdapterError) -> SandboxError {",
          " }",
          " ",
          "+fn normalize_payload_for_agent(agent: AgentId, payload: Value) -> Value {",
          "+    if agent != AgentId::Pi {",
          "+        return payload;",
          "+    }",
          "+    normalize_pi_payload(payload)",
          "+}",
          "+",
          "+fn normalize_pi_payload(mut payload: Value) -> Value {",
          "+    let method = payload",
          '+        .get("method")',
          "+        .and_then(Value::as_str)",
          "+        .unwrap_or_default();",
          "+",
          "+    match method {",
          '+        "initialize" => {',
          '+            if let Some(protocol) = payload.pointer_mut("/params/protocolVersion") {',
          "+                if let Some(raw) = protocol.as_str() {",
          "+                    if let Some(number) = parse_json_number(raw) {",
          "+                        *protocol = Value::Number(number);",
          "+                    }",
          "+                }",
          "+            }",
          "+        }",
          '+        "session/new" => {',
          '+            if let Some(params) = payload.get_mut("params").and_then(Value::as_object_mut) {',
          '+                params.entry("mcpServers".to_string())',
          "+                    .or_insert_with(|| Value::Array(Vec::new()));",
          "+            }",
          "+        }",
          "+        _ => {}",
          "+    }",
          "+    payload",
          "+}",
        ].join("\n"),
      },
      fileTree: [
        {
          name: "server",
          path: "server",
          isDir: true,
          children: [
            {
              name: "packages",
              path: "server/packages",
              isDir: true,
              children: [
                {
                  name: "sandbox-agent",
                  path: "server/packages/sandbox-agent",
                  isDir: true,
                  children: [
                    {
                      name: "src",
                      path: "server/packages/sandbox-agent/src",
                      isDir: true,
                      children: [
                        { name: "acp_proxy_runtime.rs", path: "server/packages/sandbox-agent/src/acp_proxy_runtime.rs", isDir: false },
                        { name: "acp_proxy_runtime_test.rs", path: "server/packages/sandbox-agent/src/acp_proxy_runtime_test.rs", isDir: false },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "h2",
      repoId: "sandbox-agent",
      title: "Auto-inject builtin agent skills at startup",
      status: "running",
      repoName: "rivet-dev/sandbox-agent",
      updatedAtMs: minutesAgo(3),
      branch: "feat/builtin-agent-skills",
      pullRequest: { number: 223, status: "draft" },
      tabs: [
        {
          id: "t3",
          sessionId: "t3",
          sessionName: "Skills injection",
          agent: "Claude",
          model: "claude-opus-4",
          status: "running",
          thinkingSinceMs: NOW_MS - 45_000,
          unread: false,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("t3", [
            {
              id: "m10",
              role: "user",
              agent: null,
              createdAtMs: minutesAgo(30),
              lines: ["Add builtin skill injection to agent startup. Skills should be loaded from the skills registry and written to the agent's CLAUDE.md."],
            },
            {
              id: "m11",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(28),
              lines: [
                "I'll implement this in the agent management package. The approach:",
                "1. Load skills from the registry during agent install",
                "2. Inject skill definitions into the agent's working directory as `.claude/skills/`",
                "3. Append skill references to CLAUDE.md if present",
                "",
                "Working on `server/packages/agent-management/src/agents/install.rs` now...",
              ],
              durationMs: 32_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "server/packages/agent-management/src/agents/install.rs", added: 87, removed: 12, type: "M" },
        { path: "server/packages/agent-management/src/skills/mod.rs", added: 145, removed: 0, type: "A" },
        { path: "server/packages/agent-management/src/skills/registry.rs", added: 63, removed: 0, type: "A" },
      ],
      diffs: {},
      fileTree: [
        {
          name: "server",
          path: "server",
          isDir: true,
          children: [
            {
              name: "packages",
              path: "server/packages",
              isDir: true,
              children: [
                {
                  name: "agent-management",
                  path: "server/packages/agent-management",
                  isDir: true,
                  children: [
                    {
                      name: "src",
                      path: "server/packages/agent-management/src",
                      isDir: true,
                      children: [
                        {
                          name: "agents",
                          path: "server/packages/agent-management/src/agents",
                          isDir: true,
                          children: [{ name: "install.rs", path: "server/packages/agent-management/src/agents/install.rs", isDir: false }],
                        },
                        {
                          name: "skills",
                          path: "server/packages/agent-management/src/skills",
                          isDir: true,
                          children: [
                            { name: "mod.rs", path: "server/packages/agent-management/src/skills/mod.rs", isDir: false },
                            { name: "registry.rs", path: "server/packages/agent-management/src/skills/registry.rs", isDir: false },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "h3",
      repoId: "sandbox-agent",
      title: "Add hooks example for Claude, Codex, and OpenCode",
      status: "idle",
      repoName: "rivet-dev/sandbox-agent",
      updatedAtMs: minutesAgo(45),
      branch: "hooks-example",
      pullRequest: { number: 225, status: "ready" },
      tabs: [
        {
          id: "t4",
          sessionId: "t4",
          sessionName: "Example docs",
          agent: "Claude",
          model: "claude-sonnet-4",
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
              createdAtMs: minutesAgo(60),
              lines: ["Create an example showing how to use hooks with Claude, Codex, and OpenCode agents."],
            },
            {
              id: "m21",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(58),
              lines: [
                "Done. Created `examples/hooks/` with a TypeScript example that demonstrates lifecycle hooks for all three agents. Includes `onPermissionRequest`, `onSessionEvent`, and `onAgentOutput` hooks.",
              ],
              durationMs: 16_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "examples/hooks/src/index.ts", added: 120, removed: 0, type: "A" },
        { path: "examples/hooks/package.json", added: 18, removed: 0, type: "A" },
        { path: "examples/hooks/tsconfig.json", added: 12, removed: 0, type: "A" },
      ],
      diffs: {},
      fileTree: [
        {
          name: "examples",
          path: "examples",
          isDir: true,
          children: [
            {
              name: "hooks",
              path: "examples/hooks",
              isDir: true,
              children: [
                { name: "package.json", path: "examples/hooks/package.json", isDir: false },
                { name: "tsconfig.json", path: "examples/hooks/tsconfig.json", isDir: false },
                {
                  name: "src",
                  path: "examples/hooks/src",
                  isDir: true,
                  children: [{ name: "index.ts", path: "examples/hooks/src/index.ts", isDir: false }],
                },
              ],
            },
          ],
        },
      ],
    },
    // ── rivet-dev/rivet ──
    {
      id: "h4",
      repoId: "rivet",
      title: "Add actor reschedule endpoint",
      status: "idle",
      repoName: "rivet-dev/rivet",
      updatedAtMs: minutesAgo(15),
      branch: "actor-reschedule-endpoint",
      pullRequest: { number: 4400, status: "ready" },
      tabs: [
        {
          id: "t5",
          sessionId: "t5",
          sessionName: "Reschedule API",
          agent: "Claude",
          model: "claude-sonnet-4",
          status: "idle",
          thinkingSinceMs: null,
          unread: false,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("t5", [
            {
              id: "m30",
              role: "user",
              agent: null,
              createdAtMs: minutesAgo(90),
              lines: ["Implement a POST /actors/{actor_id}/reschedule endpoint that signals the actor workflow to reschedule."],
            },
            {
              id: "m31",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(87),
              lines: [
                "I'll add the reschedule endpoint to `api-peer`. The flow is:",
                "1. Resolve actor by ID and verify namespace ownership",
                "2. Send `Reschedule` signal to the actor workflow",
                "3. Return 200 on success, 404 if actor not found",
                "",
                "Created `engine/packages/api-peer/src/actors/reschedule.rs` and wired it into the router.",
              ],
              durationMs: 28_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "engine/packages/api-peer/src/actors/reschedule.rs", added: 64, removed: 0, type: "A" },
        { path: "engine/packages/api-peer/src/actors/mod.rs", added: 1, removed: 0, type: "M" },
        { path: "engine/packages/api-peer/src/router.rs", added: 12, removed: 3, type: "M" },
        { path: "engine/packages/api-types/src/actors/reschedule.rs", added: 24, removed: 0, type: "A" },
      ],
      diffs: {
        "engine/packages/api-peer/src/actors/reschedule.rs": [
          "@@ -0,0 +1,64 @@",
          "+use anyhow::Result;",
          "+use gas::prelude::*;",
          "+use rivet_api_builder::ApiCtx;",
          "+use rivet_api_types::actors::reschedule::*;",
          "+use rivet_util::Id;",
          "+",
          "+#[utoipa::path(",
          "+    post,",
          '+    operation_id = "actors_reschedule",',
          '+    path = "/actors/{actor_id}/reschedule",',
          "+)]",
          "+#[tracing::instrument(skip_all)]",
          "+pub async fn reschedule(",
          "+    ctx: ApiCtx,",
          "+    path: ReschedulePath,",
          "+    query: RescheduleQuery,",
          "+) -> Result<RescheduleResponse> {",
          "+    let actors_res = ctx.op(pegboard::ops::actor::get::Input {",
          "+        actor_ids: vec![path.actor_id],",
          "+        fetch_error: false,",
          "+    }).await?;",
          "+",
          "+    let actor = actors_res.actors.into_iter().next()",
          "+        .ok_or_else(|| pegboard::errors::Actor::NotFound.build())?;",
          "+",
          "+    ctx.signal(pegboard::workflows::actor::Reschedule {",
          "+        reset_rescheduling: true,",
          "+    })",
          "+    .to_workflow::<pegboard::workflows::actor::Workflow>()",
          '+    .tag("actor_id", path.actor_id)',
          "+    .send().await?;",
          "+",
          "+    Ok(RescheduleResponse {})",
          "+}",
        ].join("\n"),
      },
      fileTree: [
        {
          name: "engine",
          path: "engine",
          isDir: true,
          children: [
            {
              name: "packages",
              path: "engine/packages",
              isDir: true,
              children: [
                {
                  name: "api-peer",
                  path: "engine/packages/api-peer",
                  isDir: true,
                  children: [
                    {
                      name: "src",
                      path: "engine/packages/api-peer/src",
                      isDir: true,
                      children: [
                        {
                          name: "actors",
                          path: "engine/packages/api-peer/src/actors",
                          isDir: true,
                          children: [
                            { name: "mod.rs", path: "engine/packages/api-peer/src/actors/mod.rs", isDir: false },
                            { name: "reschedule.rs", path: "engine/packages/api-peer/src/actors/reschedule.rs", isDir: false },
                          ],
                        },
                        { name: "router.rs", path: "engine/packages/api-peer/src/router.rs", isDir: false },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "h5",
      repoId: "rivet",
      title: "Dynamic actors",
      status: "idle",
      repoName: "rivet-dev/rivet",
      updatedAtMs: minutesAgo(35),
      branch: "feat/dynamic-actors",
      pullRequest: { number: 4395, status: "draft" },
      tabs: [
        {
          id: "t6",
          sessionId: "t6",
          sessionName: "Dynamic actors impl",
          agent: "Claude",
          model: "claude-opus-4",
          status: "idle",
          thinkingSinceMs: null,
          unread: true,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("t6", [
            {
              id: "m40",
              role: "user",
              agent: null,
              createdAtMs: minutesAgo(120),
              lines: ["Implement dynamic actor support — actors that can be created at runtime without pre-registration in the registry."],
            },
            {
              id: "m41",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(115),
              lines: [
                "This is a large change spanning the RivetKit runtime, the engine scheduler, and the SDK. I'll start with the core runtime changes and work outward.",
                "",
                "Key design decisions:",
                "- Dynamic actors use a special `__dynamic` registry entry",
                "- They receive their behavior module at creation time via `createDynamic()`",
                "- State persistence works identically to registered actors",
              ],
              durationMs: 45_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "rivetkit-typescript/packages/rivetkit/src/dynamic.ts", added: 280, removed: 0, type: "A" },
        { path: "rivetkit-typescript/packages/rivetkit/src/registry.ts", added: 45, removed: 12, type: "M" },
        { path: "engine/packages/pegboard/src/workflows/actor.rs", added: 120, removed: 30, type: "M" },
      ],
      diffs: {},
      fileTree: [],
    },
    // ── rivet-dev/cloud ──
    {
      id: "h6",
      repoId: "cloud",
      title: "Use full cloud run pool name for routing",
      status: "idle",
      repoName: "rivet-dev/cloud",
      updatedAtMs: minutesAgo(25),
      branch: "fix-use-full-cloud-run-pool-name",
      pullRequest: { number: 235, status: "ready" },
      tabs: [
        {
          id: "t7",
          sessionId: "t7",
          sessionName: "Pool routing fix",
          agent: "Claude",
          model: "claude-sonnet-4",
          status: "idle",
          thinkingSinceMs: null,
          unread: false,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("t7", [
            {
              id: "m50",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(40),
              lines: [
                "Fixed the managed pool routing issue. The Cloud Run service was using a truncated pool name for routing, causing 404s on pools with long names. Updated the gateway routing endpoint to use the full pool name.",
              ],
              durationMs: 24_000,
            },
            {
              id: "m51",
              role: "user",
              agent: null,
              createdAtMs: minutesAgo(38),
              lines: ["Does this also update the SDK type exports?"],
            },
            {
              id: "m52",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(36),
              lines: [
                "Yes — the `Registry` type is now exported from `actors/index.ts` so downstream consumers can reference it. Also bumped rivetkit to `2.0.4-rc.1` in pnpm overrides.",
              ],
              durationMs: 11_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "packages/api/src/actors/index.ts", added: 4, removed: 2, type: "M" },
        { path: "package.json", added: 2, removed: 1, type: "M" },
        { path: "packages/api/scripts/managed-pools-e2e.ts", added: 2, removed: 2, type: "M" },
      ],
      diffs: {
        "packages/api/src/actors/index.ts": [
          "@@ -28,6 +28,8 @@ export const registry = setup({",
          "   inspector: {},",
          " });",
          " ",
          "+export type Registry = typeof registry;",
          "+",
          " export type ActorClient = ReturnType<typeof createActorClient>;",
          " ",
          " let _client: ActorClient | null = null;",
          "@@ -37,7 +39,7 @@ function createActorClient() {",
          "     const managerPort = process.env.RIVETKIT_MANAGER_PORT",
          "       ? Number.parseInt(process.env.RIVETKIT_MANAGER_PORT, 10)",
          "       : 6420;",
          "-    return createClient<typeof registry>({",
          "+    return createClient<Registry>({",
          "       endpoint: `http://127.0.0.1:${managerPort}`,",
        ].join("\n"),
      },
      fileTree: [
        {
          name: "packages",
          path: "packages",
          isDir: true,
          children: [
            {
              name: "api",
              path: "packages/api",
              isDir: true,
              children: [
                {
                  name: "src",
                  path: "packages/api/src",
                  isDir: true,
                  children: [
                    {
                      name: "actors",
                      path: "packages/api/src/actors",
                      isDir: true,
                      children: [{ name: "index.ts", path: "packages/api/src/actors/index.ts", isDir: false }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    // ── rivet-dev/engine-ee ──
    {
      id: "h7",
      repoId: "engine-ee",
      title: "Route compute gateway path correctly",
      status: "idle",
      repoName: "rivet-dev/engine-ee",
      updatedAtMs: minutesAgo(50),
      branch: "fix-guard-support-https-targets",
      pullRequest: { number: 125, status: "ready" },
      tabs: [
        {
          id: "t8",
          sessionId: "t8",
          sessionName: "Guard routing",
          agent: "Claude",
          model: "claude-sonnet-4",
          status: "idle",
          thinkingSinceMs: null,
          unread: false,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("t8", [
            {
              id: "m60",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(65),
              lines: [
                "Fixed the guard proxy to support HTTPS targets and correct compute gateway path routing. The proxy was using an HTTP-only connector — switched to `hyper_tls::HttpsConnector`. Also fixed path-based routing to strip the `/compute/gateway` prefix before forwarding.",
              ],
              durationMs: 30_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "engine/packages/guard-core/src/proxy_service.rs", added: 8, removed: 4, type: "M" },
        { path: "engine/packages/guard/src/routing/compute_gateway.rs", added: 42, removed: 8, type: "M" },
        { path: "engine/packages/guard-core/Cargo.toml", added: 1, removed: 0, type: "M" },
        { path: "Cargo.lock", added: 37, removed: 5, type: "M" },
      ],
      diffs: {
        "engine/packages/guard-core/src/proxy_service.rs": [
          "@@ -309,15 +309,19 @@ pub struct ProxyService {",
          "     remote_addr: SocketAddr,",
          "-    client: Client<hyper_util::client::legacy::connect::HttpConnector, Full<Bytes>>,",
          "+    client: Client<",
          "+        hyper_tls::HttpsConnector<hyper_util::client::legacy::connect::HttpConnector>,",
          "+        Full<Bytes>,",
          "+    >,",
          " }",
          " ",
          " impl ProxyService {",
          "     pub fn new(state: Arc<ProxyState>, remote_addr: SocketAddr) -> Self {",
          "+        let https_connector = hyper_tls::HttpsConnector::new();",
          "         let client = Client::builder(TokioExecutor::new())",
          "             .pool_idle_timeout(Duration::from_secs(30))",
          "-            .build_http();",
          "+            .build(https_connector);",
        ].join("\n"),
      },
      fileTree: [
        {
          name: "engine",
          path: "engine",
          isDir: true,
          children: [
            {
              name: "packages",
              path: "engine/packages",
              isDir: true,
              children: [
                {
                  name: "guard-core",
                  path: "engine/packages/guard-core",
                  isDir: true,
                  children: [
                    { name: "Cargo.toml", path: "engine/packages/guard-core/Cargo.toml", isDir: false },
                    {
                      name: "src",
                      path: "engine/packages/guard-core/src",
                      isDir: true,
                      children: [{ name: "proxy_service.rs", path: "engine/packages/guard-core/src/proxy_service.rs", isDir: false }],
                    },
                  ],
                },
                {
                  name: "guard",
                  path: "engine/packages/guard",
                  isDir: true,
                  children: [
                    {
                      name: "src",
                      path: "engine/packages/guard/src",
                      isDir: true,
                      children: [
                        {
                          name: "routing",
                          path: "engine/packages/guard/src/routing",
                          isDir: true,
                          children: [{ name: "compute_gateway.rs", path: "engine/packages/guard/src/routing/compute_gateway.rs", isDir: false }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    // ── rivet-dev/engine-ee (archived) ──
    {
      id: "h8",
      repoId: "engine-ee",
      title: "Move compute gateway to guard",
      status: "archived",
      repoName: "rivet-dev/engine-ee",
      updatedAtMs: minutesAgo(2 * 24 * 60),
      branch: "chore-move-compute-gateway-to",
      pullRequest: { number: 123, status: "ready" },
      tabs: [
        {
          id: "t9",
          sessionId: "t9",
          sessionName: "Gateway migration",
          agent: "Claude",
          model: "claude-sonnet-4",
          status: "idle",
          thinkingSinceMs: null,
          unread: false,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("t9", [
            {
              id: "m70",
              role: "agent",
              agent: "claude",
              createdAtMs: minutesAgo(2 * 24 * 60 + 30),
              lines: ["Migrated the compute gateway from its standalone service into the guard package. Removed 469 lines of duplicated routing logic."],
              durationMs: 38_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "engine/packages/guard/src/routing/compute_gateway.rs", added: 180, removed: 0, type: "A" },
        { path: "engine/packages/compute-gateway/src/lib.rs", added: 0, removed: 320, type: "D" },
      ],
      diffs: {},
      fileTree: [],
    },
    // ── rivet-dev/secure-exec ──
    {
      id: "h9",
      repoId: "secure-exec",
      title: "Harden namespace isolation for nested containers",
      status: "idle",
      repoName: "rivet-dev/secure-exec",
      updatedAtMs: minutesAgo(90),
      branch: "fix/namespace-isolation",
      pullRequest: null,
      tabs: [
        {
          id: "t10",
          sessionId: "t10",
          sessionName: "Namespace fix",
          agent: "Codex",
          model: "gpt-4o",
          status: "idle",
          thinkingSinceMs: null,
          unread: true,
          created: true,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: transcriptFromLegacyMessages("t10", [
            {
              id: "m80",
              role: "user",
              agent: null,
              createdAtMs: minutesAgo(100),
              lines: [
                "Audit and harden the namespace isolation for nested container execution. Make sure PID, network, and mount namespaces are correctly unshared.",
              ],
            },
            {
              id: "m81",
              role: "agent",
              agent: "codex",
              createdAtMs: minutesAgo(97),
              lines: [
                "Audited the sandbox creation path. Found that the PID namespace was shared with the host in certain fallback paths. Fixed by always calling `unshare(CLONE_NEWPID)` before `fork()`. Also tightened the seccomp filter to block `setns` calls from within the sandbox.",
              ],
              durationMs: 42_000,
            },
          ]),
        },
      ],
      fileChanges: [
        { path: "src/sandbox/namespace.ts", added: 35, removed: 8, type: "M" },
        { path: "src/sandbox/seccomp.ts", added: 12, removed: 2, type: "M" },
      ],
      diffs: {},
      fileTree: [],
    },
  ];
}

export function buildInitialMockLayoutViewModel(): TaskWorkbenchSnapshot {
  const repos: WorkbenchRepo[] = [
    { id: "sandbox-agent", label: "rivet-dev/sandbox-agent" },
    { id: "rivet", label: "rivet-dev/rivet" },
    { id: "cloud", label: "rivet-dev/cloud" },
    { id: "engine-ee", label: "rivet-dev/engine-ee" },
    { id: "secure-exec", label: "rivet-dev/secure-exec" },
  ];
  const tasks = buildInitialTasks();
  return {
    workspaceId: "default",
    repos,
    projects: groupWorkbenchProjects(repos, tasks),
    tasks,
  };
}

export function groupWorkbenchProjects(repos: WorkbenchRepo[], tasks: Task[]): WorkbenchProjectSection[] {
  const grouped = new Map<string, WorkbenchProjectSection>();

  for (const repo of repos) {
    grouped.set(repo.id, {
      id: repo.id,
      label: repo.label,
      updatedAtMs: 0,
      tasks: [],
    });
  }

  for (const task of tasks) {
    const existing = grouped.get(task.repoId) ?? {
      id: task.repoId,
      label: task.repoName,
      updatedAtMs: 0,
      tasks: [],
    };

    existing.tasks.push(task);
    existing.updatedAtMs = Math.max(existing.updatedAtMs, task.updatedAtMs);
    grouped.set(task.repoId, existing);
  }

  return [...grouped.values()]
    .map((project) => ({
      ...project,
      tasks: [...project.tasks].sort((a, b) => b.updatedAtMs - a.updatedAtMs),
      updatedAtMs: project.tasks.length > 0 ? Math.max(...project.tasks.map((task) => task.updatedAtMs)) : project.updatedAtMs,
    }))
    .filter((project) => project.tasks.length > 0)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}
