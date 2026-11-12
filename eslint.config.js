// @ts-check
import js from '@eslint/js'
import prettier from 'eslint-config-prettier/flat'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

/**
 * Import rules from AGENTS.md, as `no-restricted-imports` patterns.
 *
 * In flat config, a later block that sets the same rule replaces the earlier options for the files it matches
 * instead of merging them. So each block below repeats the patterns of the blocks before it (`restrict()` adds
 * them), and the blocks go from general to specific.
 */
const ALIAS = {
  regex: '^(\\.\\./)+src/',
  message: 'Import src/ through the #src/* alias (see AGENTS.md).',
}
const WITHIN_SRC = {
  regex: '^\\.\\./',
  message: 'Use #src/... to reach another folder of src/; ./ is for the same folder.',
}

/** Provider folders import shared code (#src/gtfsrt.js and others), not each other. */
const PROVIDERS = ['subway', 'agency', 'path', 'citibike']

/** Each function bundles what it imports: keep large data out of the functions that don't use it. */
const NO_SUBWAY_INDEX = {
  regex: '^#src/(stops/stations|data/subway\\.generated)\\.js$',
  message: "The subway's station index is 155 KiB of data: only subway routes may import it.",
}
const NO_AGENCIES = {
  regex: '^#src/agency/agencies\\.js$',
  message: 'Subway routes must not bundle the agency data: src/agency/agencies.ts is for the agency function.',
}

const restrict = (files, ...patterns) => ({
  files,
  rules: { 'no-restricted-imports': ['error', { patterns }] },
})

export default defineConfig([
  globalIgnores(['src/data/*.generated.ts', 'test/fixtures/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // Destructuring a value only to leave it out of `...rest`, or an unused `_`-prefixed argument, is deliberate.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }],
    },
  },
  restrict(['**/*.ts'], ALIAS),
  restrict(['src/**/*.ts'], ALIAS, WITHIN_SRC),
  ...PROVIDERS.map(provider =>
    restrict([`src/${provider}/**/*.ts`], ALIAS, WITHIN_SRC, {
      regex: `^#src/(${PROVIDERS.filter(p => p !== provider).join('|')})/`,
      message: 'Provider folders import from shared modules (#src/gtfsrt.js), not from each other.',
    })
  ),
  restrict(['src/routes/{agency,citibike,path}.ts'], ALIAS, WITHIN_SRC, NO_SUBWAY_INDEX),
  restrict(['src/routes/{arrivals,alerts,vehicles,search,preview}.ts'], ALIAS, WITHIN_SRC, NO_AGENCIES),
])
