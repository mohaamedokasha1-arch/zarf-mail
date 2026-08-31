/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/**/*.{html,js}'],
  darkMode: 'class', // الوضع الداكن هو الأساس (يُدار بالكلاس dark على <html>)
  theme: {
    extend: {
      /* ألوان دلالية مربوطة بمتغيرات CSS → تبديل الوضع الليلي/النهاري بسطر واحد */
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        surface2: 'rgb(var(--surface-2) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        brand: 'rgb(var(--brand) / <alpha-value>)',
        brand2: 'rgb(var(--brand-2) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        success: 'rgb(var(--success) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
      },
      fontFamily: {
        sans: [
          '"Segoe UI"', 'system-ui', '-apple-system', '"Noto Sans Arabic"',
          '"Cairo"', '"Tajawal"', 'Tahoma', 'Arial', 'sans-serif',
        ],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        glow: '0 20px 60px -20px rgb(var(--brand) / 0.65)',
        card: '0 24px 60px -30px rgba(0,0,0,0.9)',
        inner_soft: 'inset 0 1px 0 0 rgb(255 255 255 / 0.06)',
      },
      borderRadius: {
        xl2: '1.25rem',
        '4xl': '2rem',
      },
      keyframes: {
        'fade-in': { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        'slide-up': {
          '0%': { opacity: 0, transform: 'translateY(14px) scale(.98)' },
          '100%': { opacity: 1, transform: 'translateY(0) scale(1)' },
        },
        'pop-in': {
          '0%': { opacity: 0, transform: 'scale(.94)' },
          '100%': { opacity: 1, transform: 'scale(1)' },
        },
        float: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-12px)' },
        },
        blob: {
          '0%,100%': { transform: 'translate(0,0) scale(1)' },
          '33%': { transform: 'translate(30px,-40px) scale(1.1)' },
          '66%': { transform: 'translate(-25px,25px) scale(.92)' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'ping-slow': {
          '75%,100%': { transform: 'scale(2.2)', opacity: 0 },
        },
        'gradient-pan': {
          '0%,100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        'bar-load': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(320%)' },
        },
        'toast-in': {
          '0%': { opacity: 0, transform: 'translateY(-16px) scale(.96)' },
          '100%': { opacity: 1, transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in .35s ease-out both',
        'slide-up': 'slide-up .4s cubic-bezier(.16,1,.3,1) both',
        'pop-in': 'pop-in .22s cubic-bezier(.16,1,.3,1) both',
        float: 'float 6s ease-in-out infinite',
        blob: 'blob 18s ease-in-out infinite',
        shimmer: 'shimmer 1.8s infinite',
        'ping-slow': 'ping-slow 2s cubic-bezier(0,0,.2,1) infinite',
        'gradient-pan': 'gradient-pan 8s ease infinite',
        'bar-load': 'bar-load 1.1s ease-in-out infinite',
        'toast-in': 'toast-in .3s cubic-bezier(.16,1,.3,1) both',
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(120deg, rgb(var(--brand)), rgb(var(--brand-2)), rgb(var(--accent)))',
        grid: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'%3E%3Cpath d='M0 0h40v40H0z' fill='none'/%3E%3Ccircle cx='20' cy='20' r='1' fill='rgba(148,163,184,0.16)'/%3E%3C/svg%3E")`,
      },
      backgroundSize: { '200%': '200% 200%' },
    },
  },
  plugins: [],
};
