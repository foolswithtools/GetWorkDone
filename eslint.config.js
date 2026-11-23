// Flat config shared by every workspace; each workspace runs `eslint .` and the root lints scripts, tests and root files.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'packages/db/src/generated/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**', '**/reports/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // NestJS modules are decorated classes with no members.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  {
    // Tests assert on shapes they have just checked and restore env vars by name.
    files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**', '**/test-support/**', 'tests/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    // k6 scripts (GWP#9) run in k6's JavaScript runtime, not Node.
    files: ['tests/k6/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', crypto: 'readonly' } },
  },
);
