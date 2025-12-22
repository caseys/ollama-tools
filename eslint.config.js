import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
      parser: tsparser,
      parserOptions: {
        project: undefined,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      unicorn,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...unicorn.configs.recommended.rules,
    },
  },
  {
    ignores: ["node_modules/**"],
  },
];
