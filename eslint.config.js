// ESLint 9 flat config. Минимальный набор правил на старте — ужесточать
// по ходу, не блокировать первые недели разработки строгим линтом.
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  // Игнорирование — отдельной записью, а не полем рядом с files: в плоском
  // конфиге ESLint 9 ignores внутри блока исключает файлы только из этого
  // блока, и сборочные каталоги всё равно попадали бы под правила по умолчанию.
  { ignores: ["**/dist/**", "**/node_modules/**", "**/generated/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
    },
  },
];
