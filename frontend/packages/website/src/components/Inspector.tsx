'use client';

import { ArrowRight } from 'lucide-react';

export function Inspector() {
  return (
    <section className="relative overflow-hidden border-t border-white/5 py-24">
      <div className="mx-auto max-w-4xl px-6 text-center">
        <h2 className="mb-4 text-3xl font-medium tracking-tight text-white md:text-5xl">
          Built-in Debugger
        </h2>
        <p className="mb-12 text-lg text-zinc-400">
          Inspect sessions, view event payloads, and troubleshoot without writing code.
        </p>

        <div className="mb-10 overflow-hidden rounded-2xl border border-white/10 shadow-2xl">
          <img
            src="/images/inspector.png"
            alt="Sandbox Agent Inspector"
            className="w-full"
          />
        </div>

        <a
          href="https://inspect.sandboxagent.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-white/10 bg-white px-5 py-2.5 text-sm font-medium text-black subpixel-antialiased shadow-sm transition-colors hover:bg-zinc-200"
        >
          Open Inspector
          <ArrowRight className="h-4 w-4" />
        </a>
      </div>
    </section>
  );
}
