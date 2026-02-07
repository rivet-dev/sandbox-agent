'use client';

import { Workflow, Server, Database, Download, Globe, Plug } from 'lucide-react';
import { FeatureIcon } from './ui/FeatureIcon';

export function FeatureGrid() {
  return (
    <section id="features" className="relative overflow-hidden border-t border-white/5 py-32">
      <div className="relative z-10 mx-auto max-w-7xl px-6">
        <div className="mb-16">
          <h2 className="mb-4 text-3xl font-medium tracking-tight text-white md:text-5xl">
            How it works.
          </h2>
          <p className="text-lg leading-relaxed text-zinc-400">
            A server runs inside your sandbox. Your app connects over HTTP to control any coding agent.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {/* Universal Agent API - Span full width */}
          <div className="col-span-full group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
            {/* Top Shine Highlight */}
            <div className="absolute left-0 right-0 top-0 z-10 h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            {/* Top Left Reflection/Glow */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,79,0,0.15)_0%,transparent_50%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            {/* Sharp Edge Highlight */}
            <div className="pointer-events-none absolute left-0 top-0 z-20 h-24 w-24 rounded-tl-2xl border-l border-t border-orange-500 opacity-0 transition-opacity duration-500 [mask-image:linear-gradient(135deg,black_0%,transparent_50%)] group-hover:opacity-100" />

            <div className="relative z-10 flex flex-col gap-4">
              <div className="relative z-10 mb-2 flex items-center gap-3">
                <FeatureIcon
                  icon={Workflow}
                  color="text-orange-400"
                  bgColor="bg-orange-500/10"
                  hoverBgColor="group-hover:bg-orange-500/20"
                  glowShadow="group-hover:shadow-[0_0_15px_rgba(255,79,0,0.5)]"
                />
                <h4 className="text-sm font-medium uppercase tracking-wider text-white">Universal Agent API</h4>
              </div>
              <p className="text-zinc-400 leading-relaxed text-lg max-w-2xl">
                Claude Code, Codex, OpenCode, Amp, and Pi each have different APIs. We provide a single,
                unified interface to control them all.
              </p>
            </div>
          </div>
          {/* Streaming Events */}
          <div className="group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
            {/* Top Shine Highlight */}
            <div className="absolute left-0 right-0 top-0 z-10 h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            {/* Top Left Reflection/Glow */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,197,94,0.15)_0%,transparent_50%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            {/* Sharp Edge Highlight */}
            <div className="pointer-events-none absolute left-0 top-0 z-20 h-24 w-24 rounded-tl-2xl border-l border-t border-green-500 opacity-0 transition-opacity duration-500 [mask-image:linear-gradient(135deg,black_0%,transparent_50%)] group-hover:opacity-100" />

            <div className="relative z-10 mb-2 flex items-center gap-3">
              <FeatureIcon
                icon={Server}
                color="text-green-400"
                bgColor="bg-green-500/10"
                hoverBgColor="group-hover:bg-green-500/20"
                glowShadow="group-hover:shadow-[0_0_15px_rgba(34,197,94,0.5)]"
              />
              <h4 className="text-sm font-medium uppercase tracking-wider text-white">Streaming Events</h4>
            </div>
            <p className="text-zinc-400 text-sm leading-relaxed">
              Real-time SSE stream of everything the agent does. Persist to your storage, replay sessions, audit everything.
            </p>
          </div>

          {/* Handling Permissions */}
          <div className="group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
            {/* Top Shine Highlight */}
            <div className="absolute left-0 right-0 top-0 z-10 h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            {/* Top Left Reflection/Glow */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(168,85,247,0.15)_0%,transparent_50%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            {/* Sharp Edge Highlight */}
            <div className="pointer-events-none absolute left-0 top-0 z-20 h-24 w-24 rounded-tl-2xl border-l border-t border-purple-500 opacity-0 transition-opacity duration-500 [mask-image:linear-gradient(135deg,black_0%,transparent_50%)] group-hover:opacity-100" />

            <div className="relative z-10 mb-2 flex items-center gap-3">
              <FeatureIcon
                icon={Database}
                color="text-purple-400"
                bgColor="bg-purple-500/10"
                hoverBgColor="group-hover:bg-purple-500/20"
                glowShadow="group-hover:shadow-[0_0_15px_rgba(168,85,247,0.5)]"
              />
              <h4 className="text-sm font-medium uppercase tracking-wider text-white">Universal Schema</h4>
            </div>
            <p className="text-zinc-400 text-sm leading-relaxed">
              Standardized session schema that covers all features of all agents. Includes tool calls, permission requests, file edits, etc. Approve or deny tool executions remotely over HTTP.
            </p>
          </div>

          {/* Runs Inside Any Sandbox */}
          <div className="lg:col-span-2 group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
            {/* Top Shine Highlight */}
            <div className="absolute left-0 right-0 top-0 z-10 h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            {/* Top Left Reflection/Glow */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.15)_0%,transparent_50%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            {/* Sharp Edge Highlight */}
            <div className="pointer-events-none absolute left-0 top-0 z-20 h-24 w-24 rounded-tl-2xl border-l border-t border-blue-500 opacity-0 transition-opacity duration-500 [mask-image:linear-gradient(135deg,black_0%,transparent_50%)] group-hover:opacity-100" />

            <div className="relative z-10 mb-2 flex items-center gap-3">
              <FeatureIcon
                icon={Globe}
                color="text-blue-400"
                bgColor="bg-blue-500/10"
                hoverBgColor="group-hover:bg-blue-500/20"
                glowShadow="group-hover:shadow-[0_0_15px_rgba(59,130,246,0.5)]"
              />
              <h4 className="text-sm font-medium uppercase tracking-wider text-white">Runs Inside Any Sandbox</h4>
            </div>
            <p className="text-zinc-400 text-sm leading-relaxed">
              Lightweight static binary. One curl command to install inside E2B, Daytona, Vercel Sandboxes, or Docker.
            </p>
          </div>

          {/* Automatic Agent Installation */}
          <div className="lg:col-span-2 group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
            {/* Top Shine Highlight */}
            <div className="absolute left-0 right-0 top-0 z-10 h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            {/* Top Left Reflection/Glow */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.15)_0%,transparent_50%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            {/* Sharp Edge Highlight */}
            <div className="pointer-events-none absolute left-0 top-0 z-20 h-24 w-24 rounded-tl-2xl border-l border-t border-amber-500 opacity-0 transition-opacity duration-500 [mask-image:linear-gradient(135deg,black_0%,transparent_50%)] group-hover:opacity-100" />

            <div className="relative z-10 mb-2 flex items-center gap-3">
              <FeatureIcon
                icon={Download}
                color="text-amber-400"
                bgColor="bg-amber-500/10"
                hoverBgColor="group-hover:bg-amber-500/20"
                glowShadow="group-hover:shadow-[0_0_15px_rgba(245,158,11,0.5)]"
              />
              <h4 className="text-sm font-medium uppercase tracking-wider text-white">Automatic Agent Installation</h4>
            </div>
            <p className="text-zinc-400 text-sm leading-relaxed">
              Create sessions, send messages, persist transcripts. Full session lifecycle management over HTTP.
            </p>
          </div>

          {/* OpenCode SDK & UI Support */}
          <div className="lg:col-span-2 group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
            {/* Top Shine Highlight */}
            <div className="absolute left-0 right-0 top-0 z-10 h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            {/* Top Left Reflection/Glow */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(236,72,153,0.15)_0%,transparent_50%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            {/* Sharp Edge Highlight */}
            <div className="pointer-events-none absolute left-0 top-0 z-20 h-24 w-24 rounded-tl-2xl border-l border-t border-pink-500 opacity-0 transition-opacity duration-500 [mask-image:linear-gradient(135deg,black_0%,transparent_50%)] group-hover:opacity-100" />

            <div className="relative z-10 mb-2 flex items-center gap-3">
              <FeatureIcon
                icon={Plug}
                color="text-pink-400"
                bgColor="bg-pink-500/10"
                hoverBgColor="group-hover:bg-pink-500/20"
                glowShadow="group-hover:shadow-[0_0_15px_rgba(236,72,153,0.5)]"
              />
              <h4 className="text-sm font-medium uppercase tracking-wider text-white">OpenCode SDK & UI Support</h4>
              <span className="rounded-full bg-pink-500/20 px-2 py-0.5 text-xs font-medium text-pink-300">Experimental</span>
            </div>
            <p className="text-zinc-400 text-sm leading-relaxed">
              Connect OpenCode CLI, SDK, or web UI to control agents through familiar OpenCode tooling.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
