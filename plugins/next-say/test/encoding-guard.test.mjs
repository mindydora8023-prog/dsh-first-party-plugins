/**
 * Encoding guard: executable source must be pure ASCII, EXCEPT for declared text carriers.
 *
 * Why this matters here: on this machine PowerShell reads UTF-8 source as CP936 and writes
 * it back, so a single non-ASCII character in an executable file can come back as mojibake
 * - or, when a quote is eaten, as a syntax error. The workspace has really corrupted files
 * this way before.
 *
 * TWO KINDS OF FILE, NOT ONE.
 *
 * The rule as first written said "every executable file must be ASCII, including `.py`".
 * That was wrong, and it only looked right because the guard happened to run in the two
 * plugins that have no text carriers:
 *
 *   - `archived-sessions/tools/build-reasons.py` holds the Chinese reason dictionary.
 *   - `next-say/tools/make-locales.py` holds the Chinese locale dictionary.
 *   - `gmail/gmail_cli.py` holds the Chinese help and error text of a real CLI.
 *
 * In those three files Chinese is the PAYLOAD, not an accident: they are the readable
 * authority, and `\uXXXX` escaping happens in the GENERATED JavaScript (`lib/reasons.js`),
 * which this guard still requires to be ASCII. Forcing the sources to ASCII would mean
 * hand-writing escapes, which is exactly the failure mode the dictionary design removes.
 *
 * So a file may opt into being a carrier by being listed in TEXT_CARRIERS below. The list
 * is self-cleaning in both directions: a listed carrier that no longer contains any
 * non-ASCII fails (stale entry), and any unlisted file with non-ASCII fails (new leak).
 *
 * Scope: `lib/`, `test/`, `tools/`, `mcp/`, `bin/`, the plugin root, and `cordis.patch.yml`.
 * The plugin root is included because `gmail/gmail_cli.py` lives there - a guard that only
 * walked the five directories could not see the one file outside them.
 *
 * A missing file is a failure, not a skip: silently losing the guard would be worse than
 * the guard complaining.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')

/**
 * Files whose text payload is legitimately non-ASCII.
 *
 * Keyed by basename because that is how these are identified across plugins. Every entry
 * states what the text is and where the escaped form is generated, so a reader can verify
 * the claim instead of trusting the list.
 */
const TEXT_CARRIERS = new Map([
  [
    'build-reasons.py',
    'Chinese reason dictionary; tools/build-reasons.py emits lib/reasons.js as \\uXXXX',
  ],
  [
    'make-locales.py',
    'locale dictionary for next-say; the generated lib/*.js files are escaped',
  ],
  [
    'gmail_cli.py',
    'help and error text of the gmail command-line client, shown to the operator',
  ],
])

/** Non-ASCII code points in a string, as readable "U+XXXX at line N" hints. */
function nonAsciiHints(text, limit = 5) {
  const hints = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length && hints.length < limit; index += 1) {
    const chars = [...lines[index]].filter((c) => c.codePointAt(0) > 127)
    if (chars.length === 0) continue
    const codes = chars.slice(0, 3).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
    hints.push(`line ${index + 1}: ${codes.join(' ')}`)
  }
  return hints
}

/** True when the file contains at least one code point above U+007F. */
function hasNonAscii(text) {
  return [...text].some((c) => c.codePointAt(0) > 127)
}

/**
 * Every executable file this plugin ships, wherever it lives.
 *
 * `lib/` alone was not enough: on 2026-10-26 the files that actually carried Chinese were
 * `lib/index.js` AND `lib/client.js` AND the tests that asserted on that Chinese. A guard
 * that watched only `lib/` would have declared the plugin clean while `test/*.test.mjs`
 * still held 83 non-ASCII characters.
 *
 * PowerShell (`.ps1`) and C# are deliberately NOT included. A `.ps1` that contains Chinese
 * MUST keep a UTF-8 BOM -- without it Windows PowerShell reads the file as ANSI and the
 * strings become mojibake, which is the opposite of what this rule protects.
 * windows-desktop already encodes that distinction in its own `scripts/check.mjs`, so this
 * shared guard covers the JS/Python surface and leaves those formats to that check.
 */
function shippedSources() {
  const roots = ['lib', 'test', 'tools', 'mcp', 'bin']
  const extensions = ['.js', '.mjs', '.cjs', '.py']
  const files = []
  for (const root of roots) {
    const dir = join(pluginDir, root)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (extensions.some((ext) => name.endsWith(ext))) files.push(join(dir, name))
    }
  }
  // The plugin root holds standalone entry points (e.g. gmail/gmail_cli.py).
  for (const name of readdirSync(pluginDir)) {
    if (extensions.some((ext) => name.endsWith(ext))) files.push(join(pluginDir, name))
  }
  const patch = join(pluginDir, 'cordis.patch.yml')
  if (existsSync(patch)) files.push(patch)
  return files
}

test('executable source is ASCII, except declared text carriers', () => {
  const files = shippedSources()
  assert.ok(files.length > 0, 'expected at least one shipped source file')

  const offenders = []
  const seenCarriers = new Set()

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const name = file.split(/[\\/]/).pop()
    const carrierReason = TEXT_CARRIERS.get(name)

    if (carrierReason === undefined) {
      if (hasNonAscii(text)) {
        offenders.push(`${name} -> ${nonAsciiHints(text).join('; ')}`)
      }
      continue
    }

    // A declared carrier must actually carry text. If someone converts it to escapes or
    // to English, the entry becomes a stale permission that would hide a future leak.
    if (hasNonAscii(text)) {
      seenCarriers.add(name)
    }
  }

  // Report both directions in one assertion so a run shows the whole picture.
  assert.deepEqual(
    offenders,
    [],
    'non-ASCII in executable source (PowerShell will corrupt these on rewrite). '
      + 'Move the text to README.md, or declare the file a carrier in TEXT_CARRIERS '
      + 'if the text IS the payload:\n'
      + offenders.join('\n'),
  )

  const stale = [...TEXT_CARRIERS.keys()].filter(
    (name) => files.some((file) => file.split(/[\\/]/).pop() === name) && !seenCarriers.has(name),
  )
  assert.deepEqual(
    stale,
    [],
    'these files are declared TEXT_CARRIERS but contain no non-ASCII any more, so the '
      + 'declaration is stale and would let a real leak through. Remove them from '
      + `TEXT_CARRIERS:\n${stale.join('\n')}`,
  )
})

test('no replacement characters (mojibake) anywhere in shipped source', () => {
  for (const file of shippedSources()) {
    const text = readFileSync(file, 'utf8')
    assert.equal(
      text.includes('\uFFFD'),
      false,
      `${file.split(/[\\/]/).pop()} contains U+FFFD, i.e. text was already corrupted`,
    )
  }
})

test('README.md exists and is not corrupted', () => {
  const readme = join(pluginDir, 'README.md')
  assert.ok(existsSync(readme), 'README.md is missing, so Chinese docs have nowhere to live')
  const text = readFileSync(readme, 'utf8')
  assert.equal(text.includes('\uFFFD'), false, 'README.md contains U+FFFD (corrupted)')
})
