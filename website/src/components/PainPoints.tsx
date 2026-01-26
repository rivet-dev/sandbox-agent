'use client';

import { motion } from 'framer-motion';

const frictions = [
  {
    number: '01',
    title: 'Fragmented Agent Scaffolds',
    description:
      'Every coding agent (Claude Code, Amp, OpenCode) uses proprietary plumbing. Swapping agents means rewriting your entire infrastructure bridge.',
    solution: 'Unified control plane for all agent engines.',
    visual: (
      <div className="mt-6 space-y-3">
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-gradient-to-r from-red-500/50 to-transparent" />
          <span className="text-xs text-zinc-500">Claude Bridge</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-gradient-to-r from-red-500/50 to-transparent" />
          <span className="text-xs text-zinc-500">Amp Bridge</span>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <div className="h-px flex-1 bg-gradient-to-r from-green-500 to-green-500/20" />
          <span className="text-xs text-green-400 font-medium">API</span>
        </div>
        <div className="mt-4 bg-black/60 rounded-lg border border-white/5 p-3 font-mono text-xs">
          <div className="text-zinc-500">
            <span className="text-zinc-600">01</span>{' '}
            <span className="text-purple-400">agent</span>
            <span className="text-zinc-400">.</span>
            <span className="text-blue-400">spawn</span>
            <span className="text-zinc-400">(</span>
            <span className="text-green-400">"claude-code"</span>
            <span className="text-zinc-400">)</span>
          </div>
          <div className="text-zinc-500">
            <span className="text-zinc-600">02</span>{' '}
            <span className="text-purple-400">agent</span>
            <span className="text-zinc-400">.</span>
            <span className="text-blue-400">spawn</span>
            <span className="text-zinc-400">(</span>
            <span className="text-green-400">"amp"</span>
            <span className="text-zinc-400">)</span>
          </div>
          <div className="text-zinc-600 mt-2">// Exactly same methods</div>
        </div>
      </div>
    ),
    accentColor: 'orange',
  },
  {
    number: '02',
    title: 'Deploy Anywhere',
    description:
      'Sandbox providers like E2B, Daytona, and Vercel each have unique strengths. Building integrations for each one from scratch is tedious.',
    solution: 'One SDK, every provider. Deploy to any sandbox platform with a single config change.',
    visual: (
      <div className="mt-6">
        <div className="flex items-center justify-between gap-2 text-xs">
          <div className="flex-1 text-center py-2 px-3 rounded-lg bg-zinc-800/50 border border-white/5 text-zinc-400">
            E2B
          </div>
          <div className="text-zinc-500">+</div>
          <div className="flex-1 text-center py-2 px-3 rounded-lg bg-zinc-800/50 border border-white/5 text-zinc-400">
            Daytona
          </div>
          <div className="text-zinc-500">+</div>
          <div className="flex-1 text-center py-2 px-3 rounded-lg bg-zinc-800/50 border border-white/5 text-zinc-400">
            Vercel
          </div>
        </div>
        <div className="mt-4 bg-black/60 rounded-lg border border-white/5 p-3 font-mono text-xs">
          <div className="text-zinc-500 mb-1"># Works with all providers</div>
          <div>
            <span className="text-green-400">SANDBOX_PROVIDER</span>
            <span className="text-zinc-400">=</span>
            <span className="text-amber-400">"daytona"</span>
          </div>
        </div>
      </div>
    ),
    accentColor: 'purple',
  },
  {
    number: '03',
    title: 'Transient State',
    description:
      'Transcripts and session data are usually lost when the sandbox dies. Debugging becomes impossible.',
    solution: 'Standardized session JSON. Stream events to your own storage in real-time.',
    visual: (
      <div className="mt-6">
        <div className="bg-black/60 rounded-lg border border-white/5 p-3 font-mono text-xs overflow-hidden">
          <div className="text-zinc-500 mb-2"># Session persisted automatically</div>
          <div className="space-y-1">
            <div>
              <span className="text-blue-400">"events"</span>
              <span className="text-zinc-400">: [</span>
            </div>
            <div className="pl-4">
              <span className="text-zinc-400">{'{ '}</span>
              <span className="text-blue-400">"type"</span>
              <span className="text-zinc-400">: </span>
              <span className="text-green-400">"tool_call"</span>
              <span className="text-zinc-400">{' }'}</span>
            </div>
            <div className="pl-4">
              <span className="text-zinc-400">{'{ '}</span>
              <span className="text-blue-400">"type"</span>
              <span className="text-zinc-400">: </span>
              <span className="text-green-400">"message"</span>
              <span className="text-zinc-400">{' }'}</span>
            </div>
            <div className="text-zinc-400">]</div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-zinc-500">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            <span>Streaming to Rivet Actors</span>
          </div>
        </div>
      </div>
    ),
    accentColor: 'blue',
  },
];

const accentStyles = {
  orange: {
    gradient: 'from-orange-500/20',
    border: 'border-orange-500/30',
    glow: 'rgba(255,79,0,0.15)',
    number: 'text-orange-500',
  },
  purple: {
    gradient: 'from-purple-500/20',
    border: 'border-purple-500/30',
    glow: 'rgba(168,85,247,0.15)',
    number: 'text-purple-500',
  },
  blue: {
    gradient: 'from-blue-500/20',
    border: 'border-blue-500/30',
    glow: 'rgba(59,130,246,0.15)',
    number: 'text-blue-500',
  },
};

export function PainPoints() {
  return (
    <section className="relative overflow-hidden border-t border-white/5 py-32">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="mb-16"
        >
          <h2 className="mb-6 text-3xl font-medium tracking-tight text-white md:text-5xl">
            Building coding agents is hard.
          </h2>
          <p className="max-w-2xl text-lg leading-relaxed text-zinc-400">
            Integrating coding agents into your product means dealing with fragmented tooling,
            provider-specific APIs, and ephemeral state.
          </p>
        </motion.div>

        <div className="grid gap-6 md:grid-cols-3">
          {frictions.map((friction, index) => {
            const styles = accentStyles[friction.accentColor as keyof typeof accentStyles];
            return (
              <motion.div
                key={friction.number}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm transition-colors duration-500 hover:bg-zinc-900/50"
              >
                {/* Top shine */}
                <div className="absolute left-0 right-0 top-0 z-10 h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />

                {/* Hover glow */}
                <div
                  className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                  style={{
                    background: `radial-gradient(circle at top left, ${styles.glow} 0%, transparent 50%)`,
                  }}
                />

                {/* Corner highlight */}
                <div
                  className={`pointer-events-none absolute left-0 top-0 z-20 h-24 w-24 rounded-tl-2xl border-l border-t ${styles.border} opacity-0 transition-opacity duration-500 [mask-image:linear-gradient(135deg,black_0%,transparent_50%)] group-hover:opacity-100`}
                />

                <div className="relative z-10">
                  {/* Friction number */}
                  <div className="mb-4 flex items-center gap-3">
                    <span className={`font-mono text-xs ${styles.number}`}>
                      Friction #{friction.number}
                    </span>
                  </div>

                  {/* Title */}
                  <h3 className="mb-3 text-xl font-medium text-white">{friction.title}</h3>

                  {/* Description */}
                  <p className="text-sm leading-relaxed text-zinc-500">{friction.description}</p>

                  {/* Solution */}
                  <div className="mt-4 border-t border-white/5 pt-4">
                    <p className="text-sm font-medium text-zinc-300">{friction.solution}</p>
                  </div>

                  {/* Visual */}
                  {friction.visual}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
