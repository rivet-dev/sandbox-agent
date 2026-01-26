'use client';

import { Workflow, Database, Server } from 'lucide-react';
import { FeatureIcon } from './ui/FeatureIcon';

const problems = [
  {
    title: 'Universal Agent API',
    desc: 'Coding agents like Claude Code and Amp have custom scaffolds. We provide a single API to swap between them effortlessly.',
    icon: Workflow,
    color: 'text-accent',
  },
  {
    title: 'Universal Transcripts',
    desc: 'Maintaining agent history is hard when the agent manages its own session. Our schema makes retrieval and storage simple.',
    icon: Database,
    color: 'text-purple-400',
  },
  {
    title: 'Agents in Sandboxes',
    desc: 'Run a simple curl command inside any sandbox to spawn an HTTP server that bridges the agent to your system.',
    icon: Server,
    color: 'text-green-400',
  },
];

export function ProblemsSolved() {
  return (
    <section id="features" className="py-24 bg-zinc-950 border-y border-white/5">
      <div className="max-w-7xl mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold text-white mb-4">Why Sandbox Agent SDK?</h2>
          <p className="text-zinc-400 max-w-xl mx-auto">
            Solving the three fundamental friction points of agentic software development.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {problems.map((item, idx) => (
            <div
              key={idx}
              className="group p-8 rounded-2xl bg-zinc-900/40 border border-white/5 hover:border-accent/30 transition-all duration-300"
            >
              <FeatureIcon icon={item.icon} color={item.color} />
              <h3 className="text-xl font-bold text-white mb-3">{item.title}</h3>
              <p className="text-zinc-400 text-sm leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
