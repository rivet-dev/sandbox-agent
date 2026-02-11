/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // Primary accent (OrangeRed)
        accent: '#FF4500',
        // Extended color palette
        background: '#000000',
        'text-primary': '#FAFAFA',
        'text-secondary': '#A0A0A0',
        border: '#252525',
        // Code syntax highlighting
        'code-keyword': '#c084fc',
        'code-function': '#60a5fa',
        'code-string': '#4ade80',
        'code-comment': '#737373',
      },
      fontFamily: {
        sans: ['Open Sans', 'system-ui', 'sans-serif'],
        heading: ['Satoshi', 'Open Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.8s ease-out forwards',
        'hero-line': 'hero-line 1s cubic-bezier(0.19, 1, 0.22, 1) forwards',
        'hero-p': 'hero-p 0.8s ease-out 0.6s forwards',
        'hero-cta': 'hero-p 0.8s ease-out 0.8s forwards',
        'hero-visual': 'hero-p 0.8s ease-out 1s forwards',
        'infinite-scroll': 'infinite-scroll 25s linear infinite',
        'pulse-slow': 'pulse-slow 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(24px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'hero-line': {
          '0%': { opacity: '0', transform: 'translateY(100%) skewY(6deg)' },
          '100%': { opacity: '1', transform: 'translateY(0) skewY(0deg)' },
        },
        'hero-p': {
          from: { opacity: '0', transform: 'translateY(20px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'infinite-scroll': {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(-50%)' },
        },
        'pulse-slow': {
          '50%': { opacity: '.5' },
        },
      },
      spacing: {
        header: 'var(--header-height, 3.5rem)',
      },
      borderRadius: {
        '4xl': '2rem',
      },
    },
  },
  plugins: [],
};
