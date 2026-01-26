'use client';

import { Workflow, Server, Database, Zap, Globe } from 'lucide-react';
import { FeatureIcon } from './ui/FeatureIcon';
import { CopyButton } from './ui/CopyButton';

export function FeatureGrid() {
  return (
    <section id="features" className="relative overflow-hidden border-t border-white/5 py-32">
      <div className="relative z-10 mx-auto max-w-7xl px-6">
        <div className="mb-16">
          <h2 className="mb-6 text-3xl font-medium tracking-tight text-white md:text-5xl">
            Full feature coverage. <br />
            <span className="text-zinc-500">Solving the fundamental friction points.</span>
          </h2>
          <p className="text-lg leading-relaxed text-zinc-400">
            Everything you need to ship agents in sandboxes in record time.
          </p>
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* Universal Agent API - Span 7 cols */}
          <div className="col-span-12 lg:col-span-7 row-span-2 group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50 min-h-[400px]">
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
              <p className="text-zinc-400 leading-relaxed text-lg max-w-md">
                Coding agents like Claude Code and Amp have custom scaffolds. We provide a single,
                unified interface to swap between engines effortlessly.
              </p>
            </div>

            <div className="mt-auto relative z-10 h-48 bg-black/50 rounded-xl border border-white/5 p-5 overflow-hidden font-mono text-xs">
              <div className="flex gap-4 border-b border-white/5 pb-3 mb-4">
                <span className="text-orange-400 border-b border-orange-400 pb-3">agent.spawn()</span>
                <span className="text-zinc-600">agent.terminate()</span>
                <span className="text-zinc-600">agent.logs()</span>
              </div>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                  <span className="text-zinc-300">
                    Swapping provider to <span className="text-green-400">"daytona"</span>...
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  <span className="text-zinc-300">Hot-reloading sandbox context...</span>
                </div>
                <div className="text-zinc-500 italic mt-4">// No code changes required</div>
              </div>
            </div>
          </div>

          {/* Server Mode - Span 5 cols */}
          <div className="col-span-12 lg:col-span-5 group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
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
              <h4 className="text-sm font-medium uppercase tracking-wider text-white">Server Mode</h4>
            </div>
            <p className="text-zinc-400 text-sm leading-relaxed">
              Run as an HTTP server within any sandbox. One command to bridge your agent to the
              local environment.
            </p>
            <div className="mt-auto relative z-10 p-3 bg-black/40 rounded-lg border border-white/5 font-mono text-xs text-green-400">
              $ sandbox-agent serve --port 4000
            </div>
          </div>

          {/* Universal Schema - Span 5 cols */}
          <div className="col-span-12 lg:col-span-5 group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
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
              Standardized session JSON to store and replay agent actions. Built-in adapters for
              Postgres and ClickHouse.
            </p>
          </div>

          {/* Rust Binary - Span 8 cols */}
          <div className="col-span-12 md:col-span-8 group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
            {/* Top Shine Highlight */}
            <div className="absolute left-0 right-0 top-0 z-10 h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            {/* Top Left Reflection/Glow */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.15)_0%,transparent_50%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            {/* Sharp Edge Highlight */}
            <div className="pointer-events-none absolute left-0 top-0 z-20 h-24 w-24 rounded-tl-2xl border-l border-t border-amber-500 opacity-0 transition-opacity duration-500 [mask-image:linear-gradient(135deg,black_0%,transparent_50%)] group-hover:opacity-100" />
            
            <div className="flex flex-col gap-4 relative z-10">
              <div className="relative z-10 mb-2 flex items-center gap-3">
                <FeatureIcon 
                  icon={Zap} 
                  color="text-amber-400" 
                  bgColor="bg-amber-500/10"
                  hoverBgColor="group-hover:bg-amber-500/20"
                  glowShadow="group-hover:shadow-[0_0_15px_rgba(245,158,11,0.5)]"
                />
                <h4 className="text-sm font-medium uppercase tracking-wider text-white">Rust Binary</h4>
              </div>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Statically-linked binary. Zero dependencies. 4MB total size. Instant startup with no runtime overhead.
              </p>
            </div>
            <div className="mt-auto w-full relative z-10">
              <div className="bg-black/50 rounded-xl border border-white/5 p-4 font-mono text-xs">
                <div className="flex items-center gap-2 mb-2 text-zinc-500 text-[10px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  Quick Install
                </div>
                <div className="flex items-center gap-2 text-amber-400">
                  <span className="text-zinc-500">$ </span>
                  <span className="text-zinc-300">curl -sSL https://sandboxagent.dev/install | sh</span>
                  <div className="ml-2 border-l border-white/10 pl-2">
                    <CopyButton text="curl -sSL https://sandboxagent.dev/install | sh" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Provider Agnostic - Span 4 cols */}
          <div className="col-span-12 md:col-span-4 group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50">
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
              <h4 className="text-sm font-medium uppercase tracking-wider text-white">Provider Agnostic</h4>
            </div>
            <p className="text-zinc-500 text-sm leading-relaxed">
              Seamless support for E2B, Daytona, Vercel Sandboxes, and custom Docker.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
