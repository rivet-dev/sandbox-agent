'use client';

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

        <div className="overflow-hidden rounded-2xl border border-white/10 shadow-2xl">
          <img
            src="/images/inspector.png"
            alt="Sandbox Agent Inspector"
            className="w-full"
          />
        </div>
      </div>
    </section>
  );
}
