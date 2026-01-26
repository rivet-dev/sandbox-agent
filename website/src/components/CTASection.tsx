'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Terminal, Check } from 'lucide-react';

const CTA_TITLES = [
  'Run any coding agent in any sandbox — with Sandbox Agent.',
  'One API for all coding agents — powered by Sandbox Agent.',
  'Claude Code, Codex, Amp — unified with Sandbox Agent.',
  'Swap agents without refactoring — thanks to Sandbox Agent.',
  'Agentic backends, zero complexity — with Sandbox Agent.',
  'Manage transcripts, maintain state — powered by Sandbox Agent.',
  'Your agents deserve a universal API — Sandbox Agent delivers.',
  'Build agentic sandboxes that scale — with Sandbox Agent.',
];

function AnimatedCTATitle() {
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentIndex(prev => (prev + 1) % CTA_TITLES.length);
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  return (
    <h2 className='min-h-[1.2em] text-4xl font-medium tracking-tight text-white md:text-5xl'>
      <AnimatePresence mode='wait'>
        <motion.span
          key={currentIndex}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -5 }}
          transition={{ duration: 0.1 }}
          style={{ display: 'block' }}
        >
          {CTA_TITLES[currentIndex]}
        </motion.span>
      </AnimatePresence>
    </h2>
  );
}

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

export function CTASection() {
  return (
    <section className='relative overflow-hidden border-t border-white/10 px-6 py-32 text-center'>
      <div className='absolute inset-0 z-0 bg-gradient-to-b from-black to-zinc-900/50' />
      <motion.div
        animate={{ opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 4, repeat: Infinity }}
        className='pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-zinc-500/10 via-transparent to-transparent opacity-50'
      />
      <div className='relative z-10 mx-auto max-w-3xl'>
        <div className='mb-8'>
          <AnimatedCTATitle />
        </div>
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className='mb-10 text-lg leading-relaxed text-zinc-400'
        >
          API for coding agents. <br className='hidden md:block' />
          Deploy anywhere. Swap agents on demand.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className='flex flex-col items-center justify-center gap-4 sm:flex-row'
        >
          <a
            href='/docs'
            className='inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-white/10 bg-white px-4 py-2 text-sm text-black subpixel-antialiased shadow-sm transition-colors hover:bg-zinc-200'
          >
            Read the Docs
            <ArrowRight className='h-4 w-4' />
          </a>
          <CopyInstallButton />
        </motion.div>
      </div>
    </section>
  );
}
