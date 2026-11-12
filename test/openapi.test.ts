import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildOpenApi, ROUTES } from '#src/openapi.js'

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))

describe('public/openapi.json', () => {
  it('is up to date with the schemas (run `pnpm build:openapi`)', () => {
    expect(read('public/openapi.json')).toEqual(buildOpenApi(read('package.json').version))
  })

  it('documents only public paths that exist', () => {
    const sources = (read('vercel.json').rewrites as { source: string }[]).map(r => r.source)
    for (const route of ROUTES) expect(sources).toContain(route.path)
  })
})
