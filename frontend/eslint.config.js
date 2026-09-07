// @ts-check
import babelParser from '@babel/eslint-parser'
import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default [
  { ignores: ['dist'] },
  {
    files: ['**/*.{ts,tsx}'],
    ...js.configs.recommended,
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ['@babel/preset-typescript', ['@babel/preset-react', { runtime: 'automatic' }]],
        },
      },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { '@stylistic': stylistic },
    rules: {
      // Types look like identifiers to core ESLint. tsc already checks both.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      // Prettier does not insert blank lines. This does.
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'function', next: '*' },
        { blankLine: 'always', prev: '*', next: 'function' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'multiline-block-like' },
        { blankLine: 'always', prev: 'multiline-expression', next: 'multiline-expression' },
        { blankLine: 'always', prev: 'function', next: 'multiline-expression' },
        { blankLine: 'always', prev: 'multiline-expression', next: ['function', 'return'] },
      ],
    },
  },
  prettier,
]
