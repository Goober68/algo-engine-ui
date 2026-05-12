/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg:     '#0f1115',
        panel:  '#1a1d23',
        panel2: '#181c25',
        border: '#2a2e36',
        text:   '#d4d7dd',
        muted:  '#7c8190',
        accent: '#5fa8ff',
        // Outcome (positive/negative PnL, win/loss). Reserve green/red
        // exclusively for outcome — never for action-direction.
        long:   '#26a69a',   // teal (positive outcome)
        short:  '#ef5350',   // red  (negative outcome)
        win:    '#7fff00',   // chartreuse (alt positive)
        loss:   '#ef5350',
        tp:     '#4caf50',
        sl:     '#f44336',
        trail:  '#ffb300',
        // Action-direction. Neutral colors that say "this is a long"
        // or "this is a short" without implying win/loss. Matches
        // tv-broker-relay's Live Relays panel exactly:
        //   text-blue-400  = #60a5fa  (BUY  / long)
        //   text-yellow-400= #facc15  (SELL / short)
        // Same hex used in relay's RelaysPage.jsx for cross-app
        // visual consistency when the operator hops between dashboards.
        buy:    '#60a5fa',
        sell:   '#facc15',
      },
      fontFamily: {
        mono: ['"Azeret Mono"', 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', '"Inter"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
