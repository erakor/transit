import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildOpenApi, ROUTES } from '#src/openapi.js'

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))

describe('public/openapi.json', () => {
  it('is up to date with the schemas (run `pnpm build:openapi`)', () => {
    expect(read('public/openapi.json')).toEqual(buildOpenApi(read('package.json').version))
  })

  it('is the only folder Vercel serves as static files', () => {
    // Without it, Vercel serves the whole repository.
    expect(read('vercel.json').outputDirectory).toBe('public')
  })

  it('documents only public paths that exist', () => {
    // Rewrite sources are patterns: `:op(stations|arrivals)` is one of those words, a bare `:name` one segment.
    const sources = (read('vercel.json').rewrites as { source: string }[]).map(
      r => new RegExp(`^${r.source.replace(/:\w+\(([^)]+)\)/g, '($1)').replace(/:\w+/g, '[^/]+')}$`)
    )
    for (const route of ROUTES)
      expect(
        sources.some(s => s.test(route.path)),
        route.path
      ).toBe(true)
    expect(sources.some(s => s.test('/lirr/arrivals'))).toBe(true)
    expect(sources.some(s => s.test('/nowhere'))).toBe(false)
  })
})
