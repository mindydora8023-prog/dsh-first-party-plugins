/**
 * lib/state-dir.js is generated from shared/state-dir.js.
 * A standalone checkout has no shared/, so the comparison skips there.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_ROOT = resolve(PLUGIN_ROOT, '..')
const SHARED = [['shared/state-dir.js', 'lib/state-dir.js']]

for (const [sourceRel, copyRel] of SHARED) {
  test(`${copyRel} matches ${sourceRel}`, (t) => {
    const sourcePath = join(WORKSPACE_ROOT, sourceRel)
    if (!existsSync(sourcePath)) {
      t.skip('workspace shared/ is not present (standalone checkout)')
      return
    }
    assert.equal(
      readFileSync(join(PLUGIN_ROOT, copyRel), 'utf8'),
      readFileSync(sourcePath, 'utf8'),
      `${copyRel} drifted from ${sourceRel}. Run node tools/sync-shared-code.mjs.`,
    )
  })
}
