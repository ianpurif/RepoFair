import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/.next/**', '**/node_modules/**', '**/next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.{ts,tsx,mjs}'], languageOptions: { globals: {
    process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly',
    Request: 'readonly', Response: 'readonly', Headers: 'readonly', Buffer: 'readonly',
    setTimeout: 'readonly', clearTimeout: 'readonly', AbortController: 'readonly',
  } }, rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
);
