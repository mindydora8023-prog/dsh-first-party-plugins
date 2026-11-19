/**
 * Small Markdown helpers shared by the office readers.
 *
 * The output is for a model, so the rules are the ones that keep structure
 * readable rather than pretty: headings stay headings, tables stay tables,
 * and a cell can never break the row it sits in.
 */

/** Escape the characters that would change Markdown meaning inside a cell. */
export function mdCell(value, max) {
  const flat = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '')
    .replace(/\n/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/\|/g, '\\|')
  const trimmed = flat.trim()
  if (Number.isFinite(max) && trimmed.length > max) return `${trimmed.slice(0, max)}...`
  return trimmed
}

/**
 * Render rows as one Markdown table. The first row is the header; a table
 * with no header still gets an empty one so the separator line stays valid.
 * @param {string[][]} rows
 * @param {number} maxCellLength
 * @returns {string}
 */
export function markdownTable(rows, maxCellLength) {
  if (!Array.isArray(rows) || rows.length === 0) return ''
  const width = rows.reduce((w, row) => Math.max(w, row.length), 0)
  if (width === 0) return ''
  const cells = (row) => Array.from({ length: width }, (_, i) => mdCell(row?.[i], maxCellLength))
  const header = cells(rows[0])
  const body = rows.slice(1).map((row) => `| ${cells(row).join(' | ')} |`)
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body,
  ].join('\n')
}

/** Turn a Word heading level (1..9) into a Markdown heading prefix. */
export function headingPrefix(level) {
  const n = Number.isInteger(level) ? level : 0
  if (n < 1) return ''
  return `${'#'.repeat(Math.min(n, 6))} `
}
