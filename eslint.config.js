// ESLint flat config: TypeScript everywhere, React hooks rules for the web UI.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", "fixtures/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow intentionally unused names when prefixed with "_" (destructuring out a field, unused callback args).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["src/web/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat["recommended-latest"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["src/server/**/*.ts", "src/shared/**/*.ts", "scripts/**/*.ts", "test/**/*.ts", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
);
