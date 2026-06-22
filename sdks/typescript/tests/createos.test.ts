import { describe, expect, it } from "vitest";
import { createos } from "../src/providers/createos.ts";

// Drives the REAL @nodeops-createos/sandbox SDK through a mocked fetch (the
// SDK's documented test seam). Verifies the provider's wire behavior —
// command strings, ingress URL, lifecycle endpoint mapping — without secrets
// or a live control plane.

const SANDBOX_ID = "sb_test_01";
const INGRESS_TEMPLATE = "https://<port>-sb.example.test";

interface ExecCall {
  cmd: string;
  args: string[];
}

function jsend(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ status: "success", data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function runningView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SANDBOX_ID,
    status: "running",
    ip: "10.0.0.2",
    vcpu: 1,
    mem_mib: 1024,
    disk_mib: 4096,
    created_at: "2026-06-22T00:00:00Z",
    ingress_enabled: true,
    ingress_url_template: INGRESS_TEMPLATE,
    shape: "s-1vcpu-1gb",
    rootfs: "devbox:1",
    ...overrides,
  };
}

interface Harness {
  fetch: typeof globalThis.fetch;
  execCalls: ExecCall[];
  hits: string[];
  bodies: Record<string, unknown[]>;
}

function makeHarness(opts: { ingressOnCreate?: boolean } = {}): Harness {
  const execCalls: ExecCall[] = [];
  const hits: string[] = [];
  const bodies: Record<string, unknown[]> = {};
  const ingress = opts.ingressOnCreate ?? true;

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const key = `${method} ${path}`;
    hits.push(key);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (body) {
      bodies[key] ??= [];
      bodies[key].push(body);
    }

    // POST /v1/sandboxes — create
    if (method === "POST" && path === "/v1/sandboxes") {
      return jsend({
        id: SANDBOX_ID,
        name: "test",
        ip: "10.0.0.2",
        shape: "s-1vcpu-1gb",
        rootfs: "devbox:1",
        vcpu: 1,
        mem_mib: 1024,
        disk_mib: 4096,
        spawn_ms: 10,
        egress: ["*"],
        bandwidth_quota_bytes: -1,
        ...(ingress ? { ingress_url_template: INGRESS_TEMPLATE } : {}),
      });
    }
    // POST /v1/sandboxes/:id/exec
    if (method === "POST" && path.endsWith("/exec")) {
      execCalls.push({ cmd: body.cmd, args: body.args });
      return jsend({ result: { stdout: "", stderr: "", exit_code: 0 }, exec_ms: 1 });
    }
    // POST .../pause | .../resume — return the patched view
    if (method === "POST" && path.endsWith("/pause")) return jsend(runningView({ status: "paused" }));
    if (method === "POST" && path.endsWith("/resume")) return jsend(runningView());
    // PATCH /v1/sandboxes/:id — setIngress
    if (method === "PATCH" && path === `/v1/sandboxes/${SANDBOX_ID}`) {
      return jsend(runningView({ ingress_enabled: body.ingress_enabled, ingress_url_template: INGRESS_TEMPLATE }));
    }
    // DELETE /v1/sandboxes/:id — destroy
    if (method === "DELETE" && path === `/v1/sandboxes/${SANDBOX_ID}`) {
      return jsend({ id: SANDBOX_ID, status: "destroying" });
    }
    // GET /v1/sandboxes/:id — view
    if (method === "GET" && path === `/v1/sandboxes/${SANDBOX_ID}`) {
      return jsend(runningView({ ingress_enabled: ingress }));
    }

    return jsend({ message: `unhandled ${key}` }, 500);
  }) as typeof globalThis.fetch;

  return { fetch, execCalls, hits, bodies };
}

function provider(h: Harness) {
  return createos({ client: { apiKey: "test", baseUrl: "https://api.test", fetch: h.fetch } });
}

describe("createos provider (mocked fetch)", () => {
  it("create(): provisions with ingress, installs agent + agents, starts server", async () => {
    const h = makeHarness();
    const id = await provider(h).create();

    expect(id).toBe(SANDBOX_ID);

    // ingress requested at create time
    const createBody = h.bodies["POST /v1/sandboxes"]?.[0] as Record<string, unknown>;
    expect(createBody.ingress_enabled).toBe(true);
    expect(createBody.shape).toBe("s-1vcpu-1gb");

    // every exec goes through `bash -lc`
    for (const call of h.execCalls) {
      expect(call.cmd).toBe("bash");
      expect(call.args[0]).toBe("-lc");
    }
    const scripts = h.execCalls.map((c) => c.args[1]);
    expect(scripts.some((s) => s.includes("curl -fsSL") && s.includes("install.sh"))).toBe(true);
    expect(scripts.some((s) => s.includes("install-agent claude"))).toBe(true);
    expect(scripts.some((s) => s.includes("install-agent codex"))).toBe(true);
    expect(scripts.some((s) => s.includes("sandbox-agent server") && s.includes("--port 3000"))).toBe(true);
    // PATH exported before each command
    for (const s of scripts) expect(s).toContain("/usr/local/bin");
  });

  it("getUrl(): returns ingress preview URL for the agent port", async () => {
    const h = makeHarness();
    const url = await provider(h).getUrl(SANDBOX_ID);
    expect(url).toBe("https://3000-sb.example.test");
  });

  it("getUrl(): enables ingress when it was off", async () => {
    const h = makeHarness({ ingressOnCreate: false });
    const url = await provider(h).getUrl(SANDBOX_ID);
    expect(h.hits).toContain(`PATCH /v1/sandboxes/${SANDBOX_ID}`);
    expect(url).toBe("https://3000-sb.example.test");
  });

  it("destroy(): DELETEs the sandbox", async () => {
    const h = makeHarness();
    await provider(h).destroy(SANDBOX_ID);
    expect(h.hits).toContain(`DELETE /v1/sandboxes/${SANDBOX_ID}`);
  });

  it("pause(): POSTs /pause", async () => {
    const h = makeHarness();
    await provider(h).pause?.(SANDBOX_ID);
    expect(h.hits).toContain(`POST /v1/sandboxes/${SANDBOX_ID}/pause`);
  });

  it("ensureServer(): restarts the agent server", async () => {
    const h = makeHarness();
    await provider(h).ensureServer?.(SANDBOX_ID);
    const scripts = h.execCalls.map((c) => c.args[1]);
    expect(scripts.some((s) => s.includes("sandbox-agent server") && s.includes("--port 3000"))).toBe(true);
  });
});
