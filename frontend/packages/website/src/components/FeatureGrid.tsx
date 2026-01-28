'use client';

import { Workflow, Server, Database, Zap, Globe } from 'lucide-react';
import { FeatureIcon } from './ui/FeatureIcon';
import { CopyButton } from './ui/CopyButton';

function AgentLogo({ name, color, src }: { name: string; color: string; src?: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded bg-zinc-800/50 border border-white/5">
      {src ? (
        <img src={src} alt={name} className="w-4 h-4" style={{ filter: 'brightness(0) invert(1)' }} />
      ) : (
        <div
          className="w-4 h-4 rounded-sm flex items-center justify-center text-[8px] font-bold"
          style={{ backgroundColor: `${color}20`, color }}
        >
          {name[0]}
        </div>
      )}
      <span className="text-[10px] text-zinc-400">{name}</span>
    </div>
  );
}

function ProviderLogo({ name, src }: { name: string; src?: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded bg-zinc-800/50 border border-white/5">
      {src ? (
        <img src={src} alt={name} className="h-3 w-auto" style={{ filter: 'brightness(0) invert(1)' }} />
      ) : (
        <div className="w-4 h-4 rounded-sm flex items-center justify-center text-[8px] font-bold bg-blue-500/20 text-blue-400">
          D
        </div>
      )}
      <span className="text-[10px] text-zinc-400">{name}</span>
    </div>
  );
}

export function FeatureGrid() {
  return (
    <section id="features" className="relative overflow-hidden border-t border-white/5 py-32">
      <div className="relative z-10 mx-auto max-w-7xl px-6">
        <div className="mb-16">
          <h2 className="mb-6 text-3xl font-medium tracking-tight text-white md:text-5xl">
            Full feature coverage. <br />
            <span className="text-zinc-500">Available as an HTTP API or TypeScript SDK.</span>
          </h2>
          <p className="text-lg leading-relaxed text-zinc-400">
            Everything you need to integrate coding agents in record time.
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
                Claude Code, Codex, OpenCode, and Amp each have different APIs. We provide a single,
                unified interface to control them all.
              </p>
            </div>

            <div className="mt-auto relative z-10 bg-black/50 rounded-xl border border-white/5 p-5 overflow-hidden">
              <div className="relative w-full aspect-[16/9] bg-[#050505] rounded-xl border border-white/10 overflow-hidden flex items-center justify-center">
                {/* Subtle Background Grid */}
                <div className="absolute inset-0 opacity-[0.03] pointer-events-none" 
                     style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

                <svg viewBox="0 0 800 450" className="w-full h-full relative z-10">
                  <defs>
                    {/* Glow effect for active lines */}
                    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                      <feGaussianBlur stdDeviation="2.5" result="blur" />
                      <feComposite in="SourceGraphic" in2="blur" operator="over" />
                    </filter>
                  </defs>

                  {/* Define curved paths with their respective brand colors */}
                  {(() => {
                    const curvedPaths = [
                      { d: "M480 225 C540 225, 560 90, 620 90", label: "Claude", color: "#d97757" },
                      { d: "M480 225 C540 225, 560 180, 620 180", label: "OpenAI", color: "#ffffff" },
                      { d: "M480 225 C540 225, 560 270, 620 270", label: "OpenCode", color: "#10B981" },
                      { d: "M480 225 C540 225, 560 360, 620 360", label: "Amp", color: "#F59E0B" }
                    ];

                    return (
                      <>
                        {/* Connection Lines */}
                        <g className="stroke-zinc-800" fill="none" strokeWidth="1.5">
                          {/* App -> Agent (Straight) */}
                          <path d="M180 225 L320 225" strokeDasharray="4 4" />
                          
                          {/* Agent -> Providers (Curved) */}
                          {curvedPaths.map((path, i) => (
                            <path key={i} d={path.d} strokeDasharray="4 4" />
                          ))}
                        </g>

                        {/* High-Performance Tracers */}
                        {/* Blue Tracer: App to SDK */}
                        <circle r="2.5" fill="#3B82F6" filter="url(#glow)">
                          <animateMotion path="M180 225 L320 225" dur="1.2s" repeatCount="indefinite" />
                          <animate attributeName="opacity" values="0;1;0" dur="1.2s" repeatCount="indefinite" />
                        </circle>
                        
                        {/* Colored Tracers: SDK to Providers (following curves and matching brand colors) */}
                        {curvedPaths.map((path, i) => (
                          <circle key={i} r="2.5" fill={path.color} filter="url(#glow)">
                            <animateMotion path={path.d} dur="2s" begin={`${i * 0.4}s`} repeatCount="indefinite" />
                            <animate attributeName="opacity" values="0;1;0" dur="2s" begin={`${i * 0.4}s`} repeatCount="indefinite" />
                          </circle>
                        ))}
                      </>
                    );
                  })()}

                  {/* Nodes */}
                  {/* App Node */}
                  <g transform="translate(80, 190)">
                    <rect width="100" height="70" rx="12" fill="#111" stroke="#333" strokeWidth="1" />
                    <text x="50" y="42" fill="#999" textAnchor="middle" fontSize="14" fontWeight="600" className="uppercase tracking-tighter">Client App</text>
                  </g>

                  {/* Central SDK Node */}
                  <g transform="translate(320, 180)">
                    <rect width="160" height="90" rx="14" fill="#18181B" stroke="#3B82F6" strokeWidth="2" />
                    <text x="80" y="52" fill="white" textAnchor="middle" fontSize="14" fontWeight="800">Sandbox Agent SDK</text>
                  </g>

                  {/* Provider Nodes with Logos - Vertical Layout (centered) */}
                  {/* Claude */}
                  <g transform="translate(620, 50)">
                    <rect width="140" height="80" rx="10" fill="#111" stroke="#222" strokeWidth="1" />
                    <foreignObject x="0" y="10" width="140" height="32">
                      <div className="flex justify-center">
                        <img src="/logos/claude.svg" alt="Claude" className="h-8 w-8" />
                      </div>
                    </foreignObject>
                    <text x="70" y="62" fill="#999" textAnchor="middle" fontSize="11" fontWeight="600">Claude Code</text>
                  </g>

                  {/* Codex */}
                  <g transform="translate(620, 140)">
                    <rect width="140" height="80" rx="10" fill="#111" stroke="#222" strokeWidth="1" />
                    <foreignObject x="0" y="10" width="140" height="32">
                      <div className="flex justify-center">
                        <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
                          <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" fill="#ffffff" />
                        </svg>
                      </div>
                    </foreignObject>
                    <text x="70" y="62" fill="#999" textAnchor="middle" fontSize="11" fontWeight="600">Codex</text>
                  </g>

                  {/* OpenCode */}
                  <g transform="translate(620, 230)">
                    <rect width="140" height="80" rx="10" fill="#111" stroke="#222" strokeWidth="1" />
                    <foreignObject x="0" y="10" width="140" height="32">
                      <div className="flex justify-center">
                        <svg className="h-8 w-auto" viewBox="0 0 32 40" fill="none">
                          <path d="M24 32H8V16H24V32Z" fill="#4B4646"/>
                          <path d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" fill="#F1ECEC"/>
                        </svg>
                      </div>
                    </foreignObject>
                    <text x="70" y="62" fill="#999" textAnchor="middle" fontSize="11" fontWeight="600">OpenCode</text>
                  </g>

                  {/* Amp */}
                  <g transform="translate(620, 320)">
                    <rect width="140" height="80" rx="10" fill="#111" stroke="#222" strokeWidth="1" />
                    <foreignObject x="0" y="12" width="140" height="28">
                      <div className="flex justify-center">
                        <img src="/logos/amp.svg" alt="Amp" className="h-6 w-auto" style={{ filter: 'brightness(0) invert(1)' }} />
                      </div>
                    </foreignObject>
                    <text x="70" y="62" fill="#999" textAnchor="middle" fontSize="11" fontWeight="600">Amp</text>
                  </g>
                </svg>
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
              Run as an HTTP server anywhere. One command to bridge coding agents to your
              application.
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
              Run locally, in Docker, or deploy to E2B, Daytona, and Vercel. Same SDK everywhere.
            </p>
            <div className="mt-auto flex flex-wrap gap-2">
              {['Local', 'Docker', 'E2B', 'Daytona', 'Vercel', 'Netlify'].map((provider) => (
                <span
                  key={provider}
                  className="px-2 py-1 rounded-md bg-zinc-800/50 border border-white/5 text-[10px] font-mono text-zinc-400"
                >
                  {provider}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
