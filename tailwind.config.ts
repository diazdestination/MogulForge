import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        forge: { ink: "#090d0c", cream: "#f3f0e8", lime: "#c9f75d", moss: "#23332b", rust: "#e36c3d" },
      },
      fontFamily: { sans: ["var(--font-manrope)", "sans-serif"], display: ["var(--font-display)", "serif"] },
    },
  },
  plugins: [],
} satisfies Config;

