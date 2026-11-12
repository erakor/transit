/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF or LF, optional BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  for (; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter(r => !(r.length === 1 && r[0] === ''))
}

/** Parses a CSV with a header row into objects keyed by column name. */
export function parseCsvObjects(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text)
  if (!header) return []
  return rows.map(r => {
    const o: Record<string, string> = {}
    header.forEach((h, i) => (o[h.trim()] = (r[i] ?? '').trim()))
    return o
  })
}

/**
 * Calls `fn` with the requested columns of each data row. Meant for large files such as
 * stop_times.txt: it avoids building one object per row and only does full quote handling
 * on lines that contain a quote.
 */
export function forEachCsvRow(text: string, columns: string[], fn: (values: string[]) => void): void {
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0
  let indexes: number[] | undefined
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    let line = text.slice(start, end)
    start = end + 1
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line === '') continue
    const cells = line.includes('"') ? (parseCsv(line)[0] ?? []) : line.split(',')
    if (!indexes) {
      const header = cells.map(h => h.trim())
      indexes = columns.map(c => {
        const i = header.indexOf(c)
        if (i === -1) throw new Error(`missing column ${c}`)
        return i
      })
      continue
    }
    fn(indexes.map(i => (cells[i] ?? '').trim()))
  }
}
