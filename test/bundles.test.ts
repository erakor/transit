import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
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
  'src/data/subway.generated.ts': fn => /^api\/(subway\/|stops\/|preview\/subway\.ts)/.test(fn),
  // Every agency's static data.
  'src/agency/agencies.ts': fn => fn === 'api/agency.ts',
  // The docs generator runs at build time only.
  'src/openapi.ts': () => false,
}

/** Vercel deploys one function per file under api/. */
const FUNCTIONS = readdirSync(join(ROOT, 'api'), { recursive: true, encoding: 'utf8' })
  .filter(f => f.endsWith('.ts'))
  .map(f => `api/${f}`)
  .sort()

/**
 * Runtime imports of a file, parsed by TypeScript: static imports and re-exports, and dynamic `import()`, which
 * Vercel bundles too. `import type` and `export type` are erased (verbatimModuleSyntax), so they don't count.
 */
const importsOf = new Map<string, string[]>()
function imports(file: string): string[] {
  const cached = importsOf.get(file)
  if (cached) return cached
  const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest)
  const specifiers: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments
      if (arg && ts.isStringLiteralLike(arg)) specifiers.push(arg.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const files = specifiers.flatMap(s => {
    const path = s.startsWith('#src/') ? `src/${s.slice(5)}` : s.startsWith('.') ? join(dirname(file), s) : undefined
    return path ? [path.replace(/\.js$/, '.ts')] : []
  })
  importsOf.set(file, files)
  return files
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

/**
 * Vercel's Hobby plan caps a deployment at 12 functions when they are plain files under api/ (vercel.com/docs/functions/runtimes,
 * "Functions created per deployment"); one more and the deploy fails. Add an operation to an existing function instead
 * (`byOp()` in src/http.ts), or merge two.
 */
const MAX_FUNCTIONS = 12

describe('function count', () => {
  it(`stays within Vercel's ${MAX_FUNCTIONS} per deployment`, () => {
    expect(FUNCTIONS.length, FUNCTIONS.join(', ')).toBeLessThanOrEqual(MAX_FUNCTIONS)
  })
})

describe('function bundles', () => {
  it.each(FUNCTIONS)('%s bundles only the large modules it uses', fn => {
    const modules = bundle(fn)
    const large = Object.keys(ALLOWED).filter(m => modules.has(m))
    expect(large).toEqual(Object.keys(ALLOWED).filter(m => modules.has(m) && ALLOWED[m]!(fn)))
  })
})
