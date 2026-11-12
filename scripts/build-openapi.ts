/** Writes public/openapi.json from the route schemas (src/openapi.ts). `pnpm build:openapi`. */
import { readFile, writeFile } from 'node:fs/promises'
import { buildOpenApi } from '#src/openapi.js'

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const out = new URL('../public/openapi.json', import.meta.url)
await writeFile(out, JSON.stringify(buildOpenApi(version), null, 2) + '\n')
console.log(`wrote ${out.pathname}`)
