import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextVitals,
  ...nextTs,
  {
    // eslint-config-next 默认只覆盖 app/ 等 Next 约定目录，lib/ 与 components/ 会被漏掉，
    // 导致这两个目录下的低层错误（如未定义变量）逃过 lint。这里显式纳入全量源码。
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
];

export default eslintConfig;
