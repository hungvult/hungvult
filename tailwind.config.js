/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        obsidian: {
          bg: '#1e1e1e',
          panel: '#252526',
          border: '#333333',
          accent: '#a882ff',
          muted: '#8b949e',
        }
      }
    },
  },
  plugins: [],
}
