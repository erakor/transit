import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Each Vercel function bundles every module it imports, directly or not (AGENTS.md). These checks walk the real
 * import graph from each `api/` entry, so an indirect import or a new route can't slip a large module into a
 * function that doesn't use it.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Large modules, and the functions allowed to bundle them (paths relative to the repo root). */
const ALLOWED: Record<string, (fn: string) => boolean> = {
  // The subway station index: 155 KiB of data.
  // /health reads only its feed version (a smaller generated file for that would spare the rest).
  'src/data/subway.generated.ts': fn => /^api\/(subway\/|stops\/|preview\/subway\.ts|health\.ts)/.test(fn),
  // Every agency's static data.
  'src/agency/agencies.ts': fn => fn === 'api/agency.ts',
}

/** Vercel deploys one function per file under api/. */
const FUNCTIONS = readdirSync(join(ROOT, 'api'), { recursive: true, encoding: 'utf8' })
  .filter(f => f.endsWith('.ts'))
  .map(f => `api/${f}`)
  .sort()

/** Runtime imports of a file: `import type` statements are erased, everything else stays (verbatimModuleSyntax). */
function imports(file: string): string[] {
  const source = readFileSync(join(ROOT, file), 'utf8')
  const specifiers = [...source.matchAll(/^(?:import|export)(?!\s+type\s)(?:[^'"]*?from\s+|\s+)'([^']+)'/gm)].map(
    m => m[1]!
  )
  return specifiers.flatMap(s => {
    const path = s.startsWith('#src/') ? `src/${s.slice(5)}` : s.startsWith('.') ? join(dirname(file), s) : undefined
    return path ? [path.replace(/\.js$/, '.ts')] : []
  })
}

function bundle(entry: string): Set<string> {
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    imports(file).forEach(visit)
  }
  visit(entry)
  return seen
}

describe('function bundles', () => {
  it.each(FUNCTIONS)('%s bundles only the large modules it uses', fn => {
    const modules = bundle(fn)
    const large = Object.keys(ALLOWED).filter(m => modules.has(m))
    expect(large).toEqual(Object.keys(ALLOWED).filter(m => modules.has(m) && ALLOWED[m]!(fn)))
  })
})
