import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // §3.1 brand + semantic tokens.
        primary: {
          DEFAULT: '#047857',
          dark: '#065f46',
        },
        accent: '#d97706',
        ink: '#111827',
        muted: '#6b7280',
        line: '#e5e7eb',
        bg: '#f9fafb',
        danger: '#dc2626',
        info: '#2563eb',
        // §3.1 plot-status palette.
        status: {
          available: '#16a34a',
          onhold: '#f59e0b',
          reserved: '#2563eb',
          sold: '#6b7280',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        // §3.2 scale 24/20/17/15/13.
        'gp-2xl': ['24px', { lineHeight: '32px' }],
        'gp-xl': ['20px', { lineHeight: '28px' }],
        'gp-lg': ['17px', { lineHeight: '24px' }],
        'gp-base': ['15px', { lineHeight: '22px' }],
        'gp-sm': ['13px', { lineHeight: '18px' }],
      },
      borderRadius: {
        card: '12px',
        control: '8px',
      },
      boxShadow: {
        card: '0 1px 3px rgb(0 0 0 / .08)',
        sheet: '0 -4px 24px rgb(0 0 0 / .12)',
        modal: '0 10px 40px rgb(0 0 0 / .18)',
      },
      maxWidth: {
        mobile: '28rem',
      },
    },
  },
  plugins: [],
};

export default config;
