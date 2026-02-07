'use client';

import { useState, useEffect } from 'react';
import { Terminal, Check, ArrowRight } from 'lucide-react';

const ADAPTERS = [
  { label: 'Claude Code', color: '#D97757', x: 35, y: 30, logo: '/logos/claude.svg' },
  { label: 'Codex', color: '#10A37F', x: 185, y: 30, logo: 'openai' },
  { label: 'Amp', color: '#F59E0B', x: 35, y: 115, logo: '/logos/amp.svg' },
  { label: 'OpenCode', color: '#8B5CF6', x: 185, y: 115, logo: 'opencode' },
  { label: 'Pi', color: '#38BDF8', x: 110, y: 200, logo: '/logos/pi.svg' },
];

function UniversalAPIDiagram() {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % ADAPTERS.length);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative w-full aspect-[16/9] bg-[#050505] rounded-xl border border-white/10 overflow-hidden flex items-center justify-center">
      {/* Background Grid */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      {/* Dynamic Background Glow */}
      <div
        className="absolute top-1/2 right-1/4 -translate-y-1/2 w-64 h-64 blur-[100px] rounded-full transition-colors duration-1000 opacity-20"
        style={{ backgroundColor: ADAPTERS[activeIndex].color }}
      />

      <svg viewBox="0 0 800 450" className="w-full h-full relative z-10">
        <defs>
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
          <filter id="invert-white" colorInterpolationFilters="sRGB">
            <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0" />
          </filter>
        </defs>

        {/* YOUR APP NODE */}
        <g transform="translate(60, 175)">
          <rect width="180" height="100" rx="16" fill="#0A0A0A" stroke="#333" strokeWidth="2" />
          <text x="90" y="55" fill="#FFFFFF" textAnchor="middle" fontSize="20" fontWeight="700">
            Your App
          </text>
        </g>

        {/* HTTP/SSE LINE */}
        <g>
          <path d="M240 225 L360 225" stroke="#3B82F6" strokeWidth="2" strokeDasharray="6 4" fill="none" opacity="0.6" />
          <circle r="4" fill="#3B82F6" filter="url(#glow)">
            <animateMotion path="M240 225 L360 225" dur="2s" repeatCount="indefinite" />
          </circle>
          <circle r="4" fill="#3B82F6" filter="url(#glow)">
            <animateMotion path="M360 225 L240 225" dur="2s" repeatCount="indefinite" />
          </circle>

          <rect x="255" y="195" width="90" height="22" rx="11" fill="#111" stroke="#333" strokeWidth="1" />
          <text x="300" y="210" fill="#60A5FA" textAnchor="middle" fontSize="11" fontWeight="800" fontFamily="monospace">
            HTTP / SSE
          </text>
        </g>

        {/* SANDBOX BOUNDARY */}
        <g transform="translate(360, 45)">
          <rect width="380" height="360" rx="24" fill="#080808" stroke="#333" strokeWidth="1.5" />
          <rect width="380" height="45" rx="12" fill="rgba(255,255,255,0.02)" />
          <text x="190" y="28" fill="#FFFFFF" textAnchor="middle" fontSize="14" fontWeight="800" letterSpacing="0.2em">
            SANDBOX
          </text>

          {/* SANDBOX AGENT SDK */}
          <g transform="translate(25, 65)">
            <rect width="330" height="270" rx="20" fill="#0D0D0F" stroke="#3B82F6" strokeWidth="2" />
            <text x="165" y="35" fill="#FFFFFF" textAnchor="middle" fontSize="18" fontWeight="800">
              Sandbox Agent Server
            </text>
            <line x1="40" y1="50" x2="290" y2="50" stroke="#333" strokeWidth="1" />

            {/* PROVIDER ADAPTERS */}
            {ADAPTERS.map((p, i) => {
              const isActive = i === activeIndex;
              return (
                <g key={i} transform={`translate(${p.x}, ${p.y})`}>
                  <rect
                    width="110"
                    height="65"
                    rx="12"
                    fill={isActive ? '#1A1A1E' : '#111'}
                    stroke={isActive ? p.color : '#333'}
                    strokeWidth={isActive ? 2 : 1.5}
                  />
                  <g opacity={isActive ? 1 : 0.4}>
                    {p.logo === 'openai' ? (
                      <svg x="43" y="10" width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" fill="#ffffff" />
                      </svg>
                    ) : p.logo === 'opencode' ? (
                      <svg x="43" y="10" width="19" height="24" viewBox="0 0 32 40" fill="none">
                        <path d="M24 32H8V16H24V32Z" fill="#4B4646"/>
                        <path d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" fill="#F1ECEC"/>
                      </svg>
                    ) : (
                      <image href={p.logo} x="43" y="10" width="24" height="24" filter="url(#invert-white)" />
                    )}
                  </g>
                  <text
                    x="55"
                    y="52"
                    fill="#FFFFFF"
                    textAnchor="middle"
                    fontSize="11"
                    fontWeight="600"
                    opacity={isActive ? 1 : 0.4}
                  >
                    {p.label}
                  </text>
                </g>
              );
            })}

            {/* Active Agent Label */}
            <text
              x="165"
              y="250"
              fill={ADAPTERS[activeIndex].color}
              textAnchor="middle"
              fontSize="10"
              fontWeight="800"
              fontFamily="monospace"
              letterSpacing="0.1em"
            >
              CONNECTED TO {ADAPTERS[activeIndex].label.toUpperCase()}
            </text>
          </g>
        </g>
      </svg>
    </div>
  );
}

const CopyInstallButton = () => {
  const [copied, setCopied] = useState(false);
  const installCommand = 'npx skills add rivet-dev/skills -s sandbox-agent';

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
    <section className="relative pt-44 pb-24 overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 relative z-10">
        <div className="flex flex-col lg:flex-row items-center gap-16">
          <div className="flex-1 text-center lg:text-left">
            <h1 className="mb-6 text-3xl font-medium leading-[1.1] tracking-tight text-white sm:text-4xl md:text-5xl lg:text-6xl">
              Run Coding Agents in Sandboxes.<br />
              <span className="text-zinc-400">Control Them Over HTTP.</span>
            </h1>
            <p className="mt-6 text-lg text-zinc-500 leading-relaxed max-w-xl mx-auto lg:mx-0">
              The Sandbox Agent SDK is a server that runs inside your sandbox. Your app connects remotely to control Claude Code, Codex, OpenCode, Amp, or Pi — streaming events, handling permissions, managing sessions.
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
          </div>

          <div className="flex-1 w-full max-w-2xl">
            <UniversalAPIDiagram />
          </div>
        </div>
      </div>
    </section>
  );
}
