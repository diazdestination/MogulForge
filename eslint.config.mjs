import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const config = [
  { ignores: ["dist/**", ".next/**", ".next-stale-*/**", ".vinext/**"] },
  ...nextVitals,
  ...nextTypeScript,
];
export default config;
