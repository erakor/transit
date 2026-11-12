// @ts-check
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

/**
 * Import rules from AGENTS.md, as `no-restricted-imports` patterns. In flat config a later block setting the same
 * rule replaces the earlier block's options, so each block repeats the patterns of the general one before it.
 * (What each function bundles, imports of imports included, is checked by test/bundles.test.ts.)
 */
const ALIAS = { regex: '^(\\.\\./)+src/', message: 'Import src/ through the #src/* alias (see AGENTS.md).' }
const WITHIN_SRC = {
  regex: '^\\.\\./',
  message: 'Use #src/... to reach another folder of src/; ./ is for the same folder.',
}

/** Provider folders import shared code (#src/gtfsrt.js and others), not each other. */
const PROVIDERS = ['subway', 'agency', 'bus', 'path', 'citibike']

const restrict = (files, ...patterns) => ({ files, rules: { 'no-restricted-imports': ['error', { patterns }] } })

export default defineConfig([
  // Flat config doesn't read .gitignore.
  globalIgnores(['src/data/*.generated.ts', '.vercel/', 'coverage/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Destructuring a value only to leave it out of `...rest`, or an unused `_`-prefixed argument, is deliberate.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }],
    },
  },
  restrict(['**/*.ts'], ALIAS),
  // Inside src/, WITHIN_SRC covers ALIAS too.
  restrict(['src/**/*.ts'], WITHIN_SRC),
  ...PROVIDERS.map(provider =>
    restrict([`src/${provider}/**/*.ts`], WITHIN_SRC, {
      regex: `^#src/(${PROVIDERS.filter(p => p !== provider).join('|')})/`,
      message: 'Provider folders import from shared modules (#src/gtfsrt.js), not from each other.',
    })
  ),
])
