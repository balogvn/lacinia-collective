import type { Config } from 'tailwindcss'

/**
 * Palette is deliberately tiny: two inks and a paper. Every additional colour
 * is another decision a contributor has to re-litigate, and on a 5" screen in
 * daylight the only thing that survives is contrast.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#0B4A33',
        'canvas-deep': '#083828',
        'canvas-lift': '#0F5A3E',
        paper: '#F1EFE3',
        'paper-dim': 'rgba(241, 239, 227, 0.58)',
        'paper-faint': 'rgba(241, 239, 227, 0.16)',
        signal: '#E4C87A',
        alarm: '#E08363',
      },
      fontFamily: {
        // No webfont fetch. Ever. See README "Why no webfonts".
        display: ['Didot', '"Bodoni 72"', '"Playfair Display"', '"Times New Roman"', 'Georgia', 'serif'],
        mono: ['ui-monospace', '"SF Mono"', '"JetBrains Mono"', '"IBM Plex Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      letterSpacing: {
        wider: '0.14em',
        widest: '0.24em',
      },
      keyframes: {
        blink: { '0%, 49%': { opacity: '1' }, '50%, 100%': { opacity: '0' } },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        blink: 'blink 1.05s step-end infinite',
        'fade-up': 'fade-up 0.4s ease-out both',
      },
    },
  },
  plugins: [],
}

export default config
