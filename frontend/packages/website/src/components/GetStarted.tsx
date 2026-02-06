'use client';

import { Code, Server, GitBranch } from 'lucide-react';
import { CopyButton } from './ui/CopyButton';

const sdkCodeRaw = `import { SandboxAgent } from "sandbox-agent";

const client = await SandboxAgent.start();

await client.createSession("my-session", {
  agent: "claude-code",
});

await client.postMessage("my-session", {
  message: "Hello, world!",
});

for await (const event of client.streamEvents("my-session")) {
  console.log(event.type, event.data);
}`;

function SdkCodeHighlighted() {
  return (
    <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed">
      <code>
        <span className="text-purple-400">import</span>
        <span className="text-zinc-300">{" { "}</span>
        <span className="text-white">SandboxAgent</span>
        <span className="text-zinc-300">{" } "}</span>
        <span className="text-purple-400">from</span>
        <span className="text-zinc-300"> </span>
        <span className="text-green-400">"sandbox-agent"</span>
        <span className="text-zinc-300">;</span>
        {"\n\n"}
        <span className="text-purple-400">const</span>
        <span className="text-zinc-300"> client = </span>
        <span className="text-purple-400">await</span>
        <span className="text-zinc-300"> SandboxAgent.</span>
        <span className="text-blue-400">start</span>
        <span className="text-zinc-300">();</span>
        {"\n\n"}
        <span className="text-purple-400">await</span>
        <span className="text-zinc-300"> client.</span>
        <span className="text-blue-400">createSession</span>
        <span className="text-zinc-300">(</span>
        <span className="text-green-400">"my-session"</span>
        <span className="text-zinc-300">{", {"}</span>
        {"\n"}
        <span className="text-zinc-300">{"  agent: "}</span>
        <span className="text-green-400">"claude-code"</span>
        <span className="text-zinc-300">,</span>
        {"\n"}
        <span className="text-zinc-300">{"});"}</span>
        {"\n\n"}
        <span className="text-purple-400">await</span>
        <span className="text-zinc-300"> client.</span>
        <span className="text-blue-400">postMessage</span>
        <span className="text-zinc-300">(</span>
        <span className="text-green-400">"my-session"</span>
        <span className="text-zinc-300">{", {"}</span>
        {"\n"}
        <span className="text-zinc-300">{"  message: "}</span>
        <span className="text-green-400">"Hello, world!"</span>
        <span className="text-zinc-300">,</span>
        {"\n"}
        <span className="text-zinc-300">{"});"}</span>
        {"\n\n"}
        <span className="text-purple-400">for await</span>
        <span className="text-zinc-300"> (</span>
        <span className="text-purple-400">const</span>
        <span className="text-zinc-300"> event </span>
        <span className="text-purple-400">of</span>
        <span className="text-zinc-300"> client.</span>
        <span className="text-blue-400">streamEvents</span>
        <span className="text-zinc-300">(</span>
        <span className="text-green-400">"my-session"</span>
        <span className="text-zinc-300">{")) {"}</span>
        {"\n"}
        <span className="text-zinc-300">{"  console."}</span>
        <span className="text-blue-400">log</span>
        <span className="text-zinc-300">(event.type, event.data);</span>
        {"\n"}
        <span className="text-zinc-300">{"}"}</span>
      </code>
    </pre>
  );
}

const sandboxCommand = `curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh`;

const sourceCommands = `git clone https://github.com/rivet-dev/sandbox-agent
cd sandbox-agent
cargo run -p sandbox-agent --release`;

export function GetStarted() {
  return (
    <section id="get-started" className="relative overflow-hidden border-t border-white/5 py-32">
      <div className="relative z-10 mx-auto max-w-7xl px-6">
        <div className="mb-16 text-center">
          <h2 className="mb-4 text-3xl font-medium tracking-tight text-white md:text-5xl">
            Get Started
          </h2>
          <p className="text-lg text-zinc-400">
            Choose the installation method that works best for your use case.
          </p>
          <p className="mt-4 text-sm text-zinc-500">
            Quick OpenCode attach: <span className="font-mono text-white">npx @sandbox-agent/gigacode</span>
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {/* Option 1: SDK */}
          <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
            <div className="absolute left-0 right-0 top-0 z-10 h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.15)_0%,transparent_50%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            <div className="pointer-events-none absolute left-0 top-0 z-20 h-24 w-24 rounded-tl-2xl border-l border-t border-blue-500 opacity-0 transition-opacity duration-500 [mask-image:linear-gradient(135deg,black_0%,transparent_50%)] group-hover:opacity-100" />

            <div className="relative z-10 mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400 transition-all duration-300 group-hover:bg-blue-500/20 group-hover:shadow-[0_0_15px_rgba(59,130,246,0.5)]">
                <Code className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">TypeScript SDK</h3>
                <p className="text-xs text-zinc-500">Embed in your application</p>
              </div>
            </div>

            <p className="relative z-10 mb-4 text-sm leading-relaxed text-zinc-400 min-h-[4.5rem]">
              Import the TypeScript SDK directly into your Node or browser application. Full type safety and streaming support.
            </p>

            <div className="relative z-10 flex-1 flex flex-col">
              <div className="overflow-hidden rounded-lg border border-white/5 bg-black/50 flex-1 flex flex-col">
                <div className="flex items-center justify-between border-b border-white/5 bg-white/5 px-3 py-2">
                  <span className="text-[10px] font-medium text-zinc-500">example.ts</span>
                  <CopyButton text={sdkCodeRaw} />
                </div>
                <SdkCodeHighlighted />
              </div>
            </div>
          </div>

          {/* Option 2: Sandbox */}
          <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
            <div className="absolute left-0 right-0 top-0 z-10 h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,197,94,0.15)_0%,transparent_50%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            <div className="pointer-events-none absolute left-0 top-0 z-20 h-24 w-24 rounded-tl-2xl border-l border-t border-green-500 opacity-0 transition-opacity duration-500 [mask-image:linear-gradient(135deg,black_0%,transparent_50%)] group-hover:opacity-100" />

            <div className="relative z-10 mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10 text-green-400 transition-all duration-300 group-hover:bg-green-500/20 group-hover:shadow-[0_0_15px_rgba(34,197,94,0.5)]">
                <Server className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">HTTP API</h3>
                <p className="text-xs text-zinc-500">Run as a server</p>
              </div>
            </div>

            <p className="relative z-10 mb-4 text-sm leading-relaxed text-zinc-400 min-h-[4.5rem]">
              Run as an HTTP server and connect from any language. Deploy to E2B, Daytona, Vercel, or your own infrastructure.
            </p>

            <div className="relative z-10 flex-1 flex flex-col">
              <div className="overflow-hidden rounded-lg border border-white/5 bg-black/50 flex-1 flex flex-col">
                <div className="flex items-center justify-between border-b border-white/5 bg-white/5 px-3 py-2">
                  <span className="text-[10px] font-medium text-zinc-500">terminal</span>
                  <CopyButton text={sandboxCommand} />
                </div>
                <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed flex-1">
                  <code>
                    <span className="text-zinc-500">$ </span>
                    <span className="text-zinc-300">curl -fsSL \</span>
                    {"\n"}
                    <span className="text-zinc-300">{"    "}</span>
                    <span className="text-green-400">https://releases.rivet.dev/sandbox-agent/latest/install.sh</span>
                    <span className="text-zinc-300"> | </span>
                    <span className="text-blue-400">sh</span>
                  </code>
                </pre>
              </div>
            </div>
          </div>

          {/* Option 3: Build from Source */}
          <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
            <div className="absolute left-0 right-0 top-0 z-10 h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.15)_0%,transparent_50%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            <div className="pointer-events-none absolute left-0 top-0 z-20 h-24 w-24 rounded-tl-2xl border-l border-t border-amber-500 opacity-0 transition-opacity duration-500 [mask-image:linear-gradient(135deg,black_0%,transparent_50%)] group-hover:opacity-100" />

            <div className="relative z-10 mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 transition-all duration-300 group-hover:bg-amber-500/20 group-hover:shadow-[0_0_15px_rgba(245,158,11,0.5)]">
                <GitBranch className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Open Source</h3>
                <p className="text-xs text-zinc-500">Full control</p>
              </div>
            </div>

            <p className="relative z-10 mb-4 text-sm leading-relaxed text-zinc-400 min-h-[4.5rem]">
              Clone the repo and build with Cargo. Customize, contribute, or embed directly in your Rust project.
            </p>

            <div className="relative z-10 flex-1 flex flex-col">
              <div className="overflow-hidden rounded-lg border border-white/5 bg-black/50 flex-1 flex flex-col">
                <div className="flex items-center justify-between border-b border-white/5 bg-white/5 px-3 py-2">
                  <span className="text-[10px] font-medium text-zinc-500">terminal</span>
                  <CopyButton text={sourceCommands} />
                </div>
                <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed flex-1">
                  <code>
                    <span className="text-zinc-500">$ </span>
                    <span className="text-blue-400">git clone</span>
                    <span className="text-zinc-300"> </span>
                    <span className="text-green-400">https://github.com/rivet-dev/sandbox-agent</span>
                    {"\n"}
                    <span className="text-zinc-500">$ </span>
                    <span className="text-blue-400">cd</span>
                    <span className="text-zinc-300"> sandbox-agent</span>
                    {"\n"}
                    <span className="text-zinc-500">$ </span>
                    <span className="text-blue-400">cargo run</span>
                    <span className="text-zinc-300"> -p sandbox-agent --release</span>
                  </code>
                </pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
