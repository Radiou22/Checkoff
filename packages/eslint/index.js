import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import prettier from 'eslint-config-prettier';
import perfectionist from 'eslint-plugin-perfectionist';
import react from 'eslint-plugin-react';
import hooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import typescript from 'typescript-eslint';

const typedFiles = ['apps/**/*.{ts,tsx}', 'packages/**/*.ts', 'scripts/**/*.ts'];

export default [
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  eslint.configs.recommended,
  ...typescript.configs.recommended,
  {
    languageOptions: { globals: globals.nodeBuiltin },
    files: ['**/*.{js,ts,tsx}'],
    plugins: { perfectionist, sonarjs, unicorn },
    rules: {
      'perfectionist/sort-named-imports': 'error',
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-duplicated-branches': 'error',
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/error-message': 'error',
    },
  },
  {
    files: typedFiles,
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['apps/front/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { react, 'react-hooks': hooks },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/jsx-key': 'error',
      'react/jsx-no-duplicate-props': 'error',
      'react/no-danger': 'error',
      ...hooks.configs.recommended.rules,
    },
  },
  prettier,
  {
    files: ['**/*.{js,ts,tsx}'],
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
    },
  },
];
