// UI & API Standards — Rule 8 enforcement (JS/TS side).
// Each rule here corresponds to a rule in the standards doc; the comment
// names it so a failure explains itself without opening the doc.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/** Files that ARE the ui/ layer — allowed to import Radix and own raw values. */
const UI_LAYER = ['src/components/ui/**'];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**', '*.config.js', '*.config.ts'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
    rules: {
      // ---- Rule 7: accessibility floor ----
      // The standard says "error in CI". It is NOT error yet: there are ~57
      // pre-existing violations, and per Rule 9 step 7 a gate is promoted the
      // moment its last violation clears -- adding it as error today would
      // just mean everyone runs with --no-verify.
      //
      // These clear as screens migrate onto Radix-backed ui/ primitives, which
      // is where most of them come from (div-with-onClick instead of button).
      // Promote to 'error' per-directory as each clears; see the ui/ block.
      ...jsxA11y.flatConfigs.recommended.rules,
      ...Object.fromEntries(
        Object.keys(jsxA11y.flatConfigs.recommended.rules).map((r) => [r, 'warn'])
      ),

      // Not part of the standards, but a genuine correctness signal. Warn so it
      // does not compete with the Rule gates above for attention.
      ...Object.fromEntries(
        Object.keys(reactHooks.configs.recommended.rules).map((r) => [r, 'warn'])
      ),

      // ---- Rule 1: tokens are the only visual truth ----
      'no-restricted-syntax': [
        'error',
        {
          // Hex colour literals in app code. Tokens live in styles/index.css.
          selector: 'Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
          message:
            'Rule 1: no hex colour literals in app code. Use a token: var(--accent-primary), var(--text-muted), ... ' +
            'If this is persisted user data (e.g. <input type="color">), add an eslint-disable-next-line with a reason.',
        },
        {
          // Numeric z-index in inline styles / style objects.
          selector: 'Property[key.name="zIndex"] > Literal[value=/^[0-9]+$/]',
          message:
            'Rule 1: no numeric z-index. Use a named layer: zIndex: \'var(--z-dropdown)\'. ' +
            'See the z-layer block in styles/index.css.',
        },
        {
          // Rule 6.1: 100vh is broken on mobile browsers; 100dvh is not.
          selector: 'Literal[value=/100vh/]',
          message: 'Rule 6.1: use 100dvh, not 100vh.',
        },
      ],

      // ---- Rule 0 / A.1.8: application code never imports the UI library ----
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@radix-ui/*'],
              message:
                'Rule 0: application code imports from src/components/ui, never from @radix-ui directly. ' +
                'The ui/ layer wraps the library so it can be replaced without touching screens.',
            },
          ],
        },
      ],

      // ---- Rule 8 / 2.3: no `any` at API boundaries ----
      '@typescript-eslint/no-explicit-any': 'error',

      // Noise reduction: these fire on pre-existing code and are not part of
      // the standards. Left off so the gates above stay readable.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': 'off',
    },
  },

  // The ui/ layer is the one place Radix may be imported.
  {
    files: UI_LAYER,
    rules: { 'no-restricted-imports': 'off' },
  },
);
