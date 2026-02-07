'use client';

import { motion } from 'framer-motion';
import { X, Check } from 'lucide-react';

const frictions = [
  {
    number: '01',
    title: 'Coding Agents Need Sandboxes',
    problem:
      "You can't let AI execute arbitrary code on your production servers. Coding agents need isolated environments, but existing SDKs assume local execution.",
    solution: 'A server that runs inside the sandbox and exposes HTTP/SSE.',
    accentColor: 'orange',
  },
  {
    number: '02',
    title: 'Every Coding Agent is Different',
    problem:
      'Claude Code, Codex, OpenCode, Amp, and Pi each have proprietary APIs, event formats, and behaviors. Swapping coding agents means rewriting your entire integration.',
    solution: 'One HTTP API. Write your code once, swap coding agents with a config change.',
    accentColor: 'purple',
  },
  {
    number: '03',
    title: 'Sessions Are Ephemeral',
    problem:
      'Coding agent transcripts live in the sandbox. When the process ends, you lose everything. Debugging and replay become impossible.',
    solution: 'Universal event schema streams to your storage. Persist to Postgres or Rivet, replay later, audit everything.',
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
            Running coding agents remotely is hard.
          </h2>
          <p className="max-w-2xl text-lg leading-relaxed text-zinc-400">
            Coding agents need sandboxes, but existing SDKs assume local execution. SSH breaks, CLI wrappers are fragile, and building from scratch means reimplementing everything for each coding agent.
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

                <div className="relative z-10 flex flex-col h-full">
                  {/* Title */}
                  <h3 className="mb-4 text-xl font-medium text-white">{friction.title}</h3>

                  {/* Problem */}
                  <div className="mb-4">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="flex items-center justify-center w-5 h-5 rounded-full bg-red-500/20">
                        <X className="w-3 h-3 text-red-400" />
                      </div>
                      <span className="text-xs font-semibold uppercase tracking-wider text-red-400">Problem</span>
                    </div>
                    <p className="text-sm leading-relaxed text-zinc-500">{friction.problem}</p>
                  </div>

                  {/* Solution */}
                  <div className="mt-auto pt-4 border-t border-white/5">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="flex items-center justify-center w-5 h-5 rounded-full bg-green-500/20">
                        <Check className="w-3 h-3 text-green-400" />
                      </div>
                      <span className="text-xs font-semibold uppercase tracking-wider text-green-400">Solution</span>
                    </div>
                    <p className="text-sm font-medium leading-relaxed text-zinc-300">{friction.solution}</p>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
