'use client';

import { useState } from 'react';
import { Terminal, Check, ArrowRight } from 'lucide-react';

const CopyInstallButton = () => {
  const [copied, setCopied] = useState(false);
  const installCommand = 'npx rivet-dev/sandbox-agent';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className='inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm text-white subpixel-antialiased shadow-sm transition-colors hover:border-white/20'
    >
      {copied ? <Check className='h-4 w-4' /> : <Terminal className='h-4 w-4' />}
      {installCommand}
    </button>
  );
};

export function Hero() {
  return (
    <section className="relative pt-32 pb-24 overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 relative z-10">
        <div className="flex flex-col lg:flex-row items-center gap-16">
          <div className="flex-1 text-center lg:text-left">
            <h1 className="mb-6 text-5xl font-medium leading-[1.1] tracking-tighter text-white md:text-7xl">
              API for <br />
              Sandbox Agents
            </h1>
            <p className="mt-8 text-xl text-zinc-400 leading-relaxed max-w-2xl mx-auto lg:mx-0">
              One API to run Claude Code, Codex, and Amp inside any sandbox. Manage transcripts, maintain state, and swap agents with zero refactoring.
            </p>

            <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center lg:justify-start">
              <a
                href="/docs"
                className='inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-white/10 bg-white px-4 py-2 text-sm text-black subpixel-antialiased shadow-sm transition-colors hover:bg-zinc-200'
              >
                Read the Docs
                <ArrowRight className='h-4 w-4' />
              </a>
              <CopyInstallButton />
            </div>

            <div className="mt-16 flex flex-col items-center lg:items-start gap-6">
              <span className="text-sm font-mono uppercase tracking-widest text-white/60">
                Supported Sandbox Providers
              </span>
              <div className="flex gap-10 items-center">
                <DaytonaLogo />
                <E2BLogo />
                <VercelLogo />
              </div>
            </div>
          </div>

          <div className="flex-1 w-full max-w-xl">
            <div className="relative group">
              <div className="absolute -inset-1 rounded-xl bg-gradient-to-r from-zinc-700 to-zinc-800 opacity-20 blur" />
              <div className="group relative overflow-hidden rounded-xl border border-white/10 bg-zinc-900/50 shadow-2xl backdrop-blur-xl">
                <div className="flex items-center justify-between border-b border-white/5 bg-white/5 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-3 rounded-full border border-zinc-500/50 bg-zinc-500/20" />
                    <div className="h-3 w-3 rounded-full border border-zinc-500/50 bg-zinc-500/20" />
                    <div className="h-3 w-3 rounded-full border border-zinc-500/50 bg-zinc-500/20" />
                  </div>
                  <div className="font-mono text-xs text-zinc-500">example_agent.ts</div>
                </div>
                <div className="p-6 font-mono text-sm leading-relaxed">
                  <CodeLine num="01">
                    <span className="text-purple-400">import</span>{' '}
                    <span className="text-white">{'{ SandboxAgent }'}</span>{' '}
                    <span className="text-purple-400">from</span>{' '}
                    <span className="text-green-400">"@sandbox/sdk"</span>;
                  </CodeLine>
                  <CodeLine num="02">
                    <span className="text-zinc-500">// Start Claude Code in an E2B sandbox</span>
                  </CodeLine>
                  <CodeLine num="03">
                    <span className="text-purple-400">const</span>{' '}
                    <span className="text-white">agent = </span>
                    <span className="text-purple-400">await</span>{' '}
                    <span className="text-white">SandboxAgent.</span>
                    <span className="text-blue-400">spawn</span>
                    <span className="text-white">{'({'}</span>
                  </CodeLine>
                  <CodeLine num="04">
                    <span className="text-white">  provider: </span>
                    <span className="text-green-400">"e2b"</span>,
                  </CodeLine>
                  <CodeLine num="05">
                    <span className="text-white">  engine: </span>
                    <span className="text-green-400">"claude-code"</span>
                  </CodeLine>
                  <CodeLine num="06">
                    <span className="text-white">{'}'});</span>
                  </CodeLine>
                  <div className="h-4" />
                  <CodeLine num="07">
                    <span className="text-purple-400">const</span>{' '}
                    <span className="text-white">transcript = </span>
                    <span className="text-purple-400">await</span>{' '}
                    <span className="text-white">agent.</span>
                    <span className="text-blue-400">getTranscript</span>
                    <span className="text-white">();</span>
                  </CodeLine>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function CodeLine({ num, children }: { num: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <span className="text-zinc-600 select-none">{num}</span>
      {children}
    </div>
  );
}

function DaytonaLogo() {
  return (
    <a href="https://daytona.io" target="_blank" rel="noopener noreferrer" className="opacity-60 hover:opacity-100 transition-opacity">
      <img src="/logos/daytona.svg" alt="Daytona" className="h-6 w-auto" style={{ filter: 'brightness(0) invert(1)' }} />
    </a>
  );
}

function E2BLogo() {
  return (
    <a href="https://e2b.dev" target="_blank" rel="noopener noreferrer" className="opacity-60 hover:opacity-100 transition-opacity">
      <img src="/logos/e2b.svg" alt="E2B" className="h-7 w-auto" style={{ filter: 'brightness(0) invert(1)' }} />
    </a>
  );
}

function VercelLogo() {
  return (
    <a href="https://vercel.com/docs/sandbox" target="_blank" rel="noopener noreferrer" className="opacity-60 hover:opacity-100 transition-opacity flex items-center gap-2">
      <svg viewBox="0 0 24 24" className="h-7 w-7 fill-current text-white">
        <path d="M24 22.525H0l12-21.05 12 21.05z"/>
      </svg>
    </a>
  );
}
