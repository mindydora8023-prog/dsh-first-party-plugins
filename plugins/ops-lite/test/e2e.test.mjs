/**
 * Real-file end-to-end tests over a fake host fs, plus the tool contract.
 *
 * The fake here implements the same surface the host exposes (`resolve`,
 * `stat`, `readBytes`) and records every `fs/observed` emission, so the test can
 * prove the read-before-edit registration actually happens. That registration is
 * what makes a file read here editable with the host `edit` tool afterwards.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import { buildReadFilesTool, revisionOf } from '../lib/tools.js'
import { readConfig } from '../lib/config.js'
import { defineTool } from '../lib/define.js'
import { buildWindow } from '../lib/text.js'
import { capText } from '../lib/escape.js'

/** A minimal host-fs stand-in backed by the real filesystem. */
function fakeHost(root) {
  const observed = []
  return {
    observed,
    fs: {
      async resolve(requested, options = {}) {
        const base = options.cwd ?? root
        const absolute = resolve(base, requested)
        return { targetKey: absolute, displayPath: absolute }
      },
      async stat(target) {
        try {
          const stats = (await import('node:fs')).statSync(target.targetKey)
          return {
            type: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other',
            size: stats.size,
            version: `${stats.size}:${stats.mtimeMs}`,
          }
        } catch {
          return undefined
        }
      },
      async readBytes(target, signal, maxBytes) {
        const buffer = (await import('node:fs')).readFileSync(target.targetKey)
        return buffer.subarray(0, maxBytes)
      },
    },
    emit(name, target, observation) {
      if (name === 'fs/observed') observed.push({ path: target.targetKey, observation })
    },
  }
}

/** Build a context + exec pair over a temporary workspace. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'ops-lite-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  const host = fakeHost(root)
  const ctx = {
    fs: host.fs,
    emit: (...args) => host.emit(...args),
    logger: { info() {}, warn() {} },
  }
  const exec = { agent: { session: { header: { cwd: root } } }, signal: undefined, callId: 'c1' }
  return { root, ctx, exec, host, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Build a registered (argument-validating) tool over a workspace. */
function tool(ctx, configOverrides = {}) {
  const config = readConfig(configOverrides)
  return { definition: defineTool(buildReadFilesTool(ctx, config)), config }
}

test('reading two files in one call returns both bodies', async () => {
  const space = workspace()
  try {
    writeFileSync(join(space.root, 'src', 'a.js'), 'alpha\nbeta\n', 'utf8')
    writeFileSync(join(space.root, 'src', 'b.js'), 'gamma\n', 'utf8')
    const { definition } = tool(space.ctx)
    const value = await definition.execute({ files: [{ path: 'src/a.js' }, { path: 'src/b.js' }] }, space.exec)

    assert.equal(value.total, 2)
    assert.equal(value.pending, 0)
    assert.equal(value.failed, 0)
    assert.equal(value.complete, true)
    assert.match(value.text, /alpha/)
    assert.match(value.text, /gamma/)
    // One shared Base, relative names: the compact form.
    assert.match(value.text, /\[Base: /)
    assert.match(value.text, /=== FILE: "a\.js"/)
  } finally {
    space.cleanup()
  }
})

test('every read is registered for the host read-before-edit table', async () => {
  const space = workspace()
  try {
    writeFileSync(join(space.root, 'src', 'a.js'), 'alpha\n', 'utf8')
    const { definition } = tool(space.ctx)
    await definition.execute({ files: [{ path: 'src/a.js' }] }, space.exec)

    assert.equal(space.host.observed.length, 1, 'exactly one observation per successful read')
    const entry = space.host.observed[0]
    assert.equal(entry.observation.kind, 'present')
    assert.equal(typeof entry.observation.version, 'string')
  } finally {
    space.cleanup()
  }
})

test('an absent file is recorded as absent and reported per file', async () => {
  const space = workspace()
  try {
    writeFileSync(join(space.root, 'src', 'a.js'), 'alpha\n', 'utf8')
    const { definition } = tool(space.ctx)
    const value = await definition.execute(
      { files: [{ path: 'src/missing.js' }, { path: 'src/a.js' }] },
      space.exec,
    )

    assert.equal(value.failed, 1)
    assert.equal(value.complete, false, 'one failed file must block the complete claim')
    assert.match(value.text, /NOT_FOUND/)
    // The neighbour still rendered: one bad file does not hide the others.
    assert.match(value.text, /alpha/)
    assert.ok(space.host.observed.some((entry) => entry.observation.kind === 'absent'))
  } finally {
    space.cleanup()
  }
})

test('a credential-shaped path is refused without echoing it', async () => {
  const space = workspace()
  try {
    writeFileSync(join(space.root, '.env'), 'SECRET_TOKEN=abc\n', 'utf8')
    const { definition } = tool(space.ctx)
    const value = await definition.execute({ files: [{ path: '.env' }] }, space.exec)

    assert.equal(value.failed, 1)
    assert.match(value.text, /CREDENTIAL_DENIED/)
    assert.match(value.text, /retry=never/)
    assert.equal(value.text.includes('SECRET_TOKEN'), false, 'the secret must never reach the model')
  } finally {
    space.cleanup()
  }
})

test('a binary file is refused instead of decoded lossily', async () => {
  const space = workspace()
  try {
    writeFileSync(join(space.root, 'src', 'blob.bin'), Buffer.from([1, 0, 2, 0, 3]))
    const { definition } = tool(space.ctx)
    const value = await definition.execute({ files: [{ path: 'src/blob.bin' }] }, space.exec)

    assert.equal(value.failed, 1)
    assert.match(value.text, /ENCODING_ERROR/)
  } finally {
    space.cleanup()
  }
})

test('an invalid UTF-8 file is refused, not replaced', async () => {
  const space = workspace()
  try {
    // 0xFF is never valid UTF-8 and is not a NUL, so it must fail the strict decode.
    writeFileSync(join(space.root, 'src', 'bad.txt'), Buffer.from([0x61, 0xff, 0x62]))
    const { definition } = tool(space.ctx)
    const value = await definition.execute({ files: [{ path: 'src/bad.txt' }] }, space.exec)
    assert.equal(value.failed, 1)
    assert.match(value.text, /ENCODING_ERROR/)
  } finally {
    space.cleanup()
  }
})

test('a partial window reports the offset to resume from', async () => {
  const space = workspace()
  try {
    const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`)
    writeFileSync(join(space.root, 'src', 'big.js'), `${lines.join('\n')}\n`, 'utf8')
    const { definition } = tool(space.ctx)
    const value = await definition.execute({ files: [{ path: 'src/big.js', limit: 5 }] }, space.exec)

    assert.equal(value.complete, false)
    assert.match(value.text, /more lines; nextOffset=6/)
    assert.match(value.text, /complete=false/)
  } finally {
    space.cleanup()
  }
})

test('resuming at nextOffset completes the file', async () => {
  const space = workspace()
  try {
    writeFileSync(join(space.root, 'src', 'small.js'), 'one\ntwo\nthree\n', 'utf8')
    const { definition } = tool(space.ctx)
    const first = await definition.execute({ files: [{ path: 'src/small.js', limit: 1 }] }, space.exec)
    assert.match(first.text, /nextOffset=2/)

    const second = await definition.execute(
      { files: [{ path: 'src/small.js', offset: 2, limit: 10 }] },
      space.exec,
    )
    assert.equal(second.complete, true)
    assert.match(second.text, /end of file; complete=true/)
    assert.match(second.text, /three/)
  } finally {
    space.cleanup()
  }
})

test('a stale offset past the end is a structured failure', async () => {
  const space = workspace()
  try {
    writeFileSync(join(space.root, 'src', 'tiny.js'), 'only\n', 'utf8')
    const { definition } = tool(space.ctx)
    const value = await definition.execute({ files: [{ path: 'src/tiny.js', offset: 50 }] }, space.exec)

    assert.equal(value.failed, 1)
    assert.match(value.text, /OFFSET_OUT_OF_RANGE/)
    assert.match(value.text, /nextAction|Next:/)
  } finally {
    space.cleanup()
  }
})

test('a call over the byte cap leaves the rest pending and never reads them', async () => {
  const space = workspace()
  try {
    // Each file is large enough that two cannot share the call budget.
    const body = `${'w'.repeat(2000)}\n`
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      writeFileSync(join(space.root, 'src', name), body.repeat(8), 'utf8')
    }
    const { definition } = tool(space.ctx, { callMaxBytes: 8192 })
    const value = await definition.execute(
      { files: [{ path: 'src/a.txt' }, { path: 'src/b.txt' }, { path: 'src/c.txt' }] },
      space.exec,
    )

    // The batch-level completeness level must be REAL, not always zero.
    assert.ok(value.pending > 0, 'entries that did not fit must be reported pending')
    assert.equal(value.nextIndex, value.total - value.pending)
    assert.equal(value.complete, false)
    // A pending entry must not have been read at all: no observation for it.
    assert.equal(
      space.host.observed.length,
      value.nextIndex,
      'an entry reported pending must not have been read',
    )
    assert.match(value.text, /pending=[1-9]/)
  } finally {
    space.cleanup()
  }
})

test('the first entry always fits, even when it alone exceeds the cap', async () => {
  const space = workspace()
  try {
    // Without this rule a single oversized file would return nothing at all and
    // report every entry pending -- an infinite loop for the model.
    writeFileSync(join(space.root, 'src', 'a.txt'), `${'q'.repeat(5000)}\n`, 'utf8')
    const { definition } = tool(space.ctx, { callMaxBytes: 8192 })
    const value = await definition.execute({ files: [{ path: 'src/a.txt' }] }, space.exec)
    assert.equal(value.pending, 0)
    assert.equal(value.total, 1)
    assert.match(value.text, /qqqq/)
  } finally {
    space.cleanup()
  }
})

test('a large file read at a small window is not charged for the whole file', async () => {
  const space = workspace()
  try {
    writeFileSync(join(space.root, 'src', 'small.txt'), 'small\n', 'utf8')
    const big = `${'x'.repeat(99)}\n`
    writeFileSync(join(space.root, 'src', 'big.txt'), big.repeat(2000), 'utf8') // ~200 KB
    // The whole-file estimate (~600 KB) exceeds the cap, but a 2-line window does
    // not: charging by whole-file size would push big.txt to pending forever.
    const { definition } = tool(space.ctx, { callMaxBytes: 30000 })
    const value = await definition.execute(
      { files: [{ path: 'src/small.txt' }, { path: 'src/big.txt', offset: 1, limit: 2 }] },
      space.exec,
    )
    assert.equal(value.pending, 0, 'a windowed read of a big file must not be pushed to pending')
    assert.equal(value.nextIndex, 2)
    assert.equal(space.host.observed.length, 2)
  } finally {
    space.cleanup()
  }
})

test('offset past the physical end is OFFSET_OUT_OF_RANGE even with a trailing newline', async () => {
  const space = workspace()
  try {
    writeFileSync(join(space.root, 'src', 'two.txt'), 'a\nb\n', 'utf8')
    const { definition } = tool(space.ctx)
    const value = await definition.execute({ files: [{ path: 'src/two.txt', offset: 3 }] }, space.exec)
    assert.equal(value.failed, 1)
    assert.match(value.text, /OFFSET_OUT_OF_RANGE/)
  } finally {
    space.cleanup()
  }
})

test('an empty files array fails with a repair instruction', async () => {
  const space = workspace()
  try {
    const { definition } = tool(space.ctx)
    const value = await definition.execute({ files: [] }, space.exec)
    assert.equal(value.complete, false)
    assert.equal(value.failed, 1)
    assert.match(value.text, /INVALID_ARGUMENT/)
  } finally {
    space.cleanup()
  }
})

test('the declared revision matches a SHA-256 of the file bytes', async () => {
  const space = workspace()
  try {
    const body = 'alpha\nbeta\n'
    writeFileSync(join(space.root, 'src', 'a.js'), body, 'utf8')
    const { definition } = tool(space.ctx)
    const value = await definition.execute({ files: [{ path: 'src/a.js' }] }, space.exec)
    const expected = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')
    assert.match(value.text, new RegExp(`revision=${expected}`))
  } finally {
    space.cleanup()
  }
})

test('the whole rendered body stays inside the configured text budget', async () => {
  const space = workspace()
  try {
    // Many long lines force the per-call budget to bite. The file window caps
    // itself first, so the assertion is on the OUTER bound only: whatever the
    // renderer produced must fit, and it must say how to continue.
    const line = 'x'.repeat(200)
    const lines = Array.from({ length: 400 }, () => line)
    writeFileSync(join(space.root, 'src', 'huge.js'), `${lines.join('\n')}\n`, 'utf8')
    const { definition } = tool(space.ctx)
    const value = await definition.execute({ files: [{ path: 'src/huge.js' }] }, space.exec)

    const bytes = Buffer.byteLength(JSON.stringify([{ type: 'text', text: value.text }]), 'utf8')
    // The budget is 64 KiB by default; allow the JSON frame's own bytes.
    assert.ok(bytes <= 64 * 1024 + 64, `rendered ${bytes} bytes, over budget`)
    // Whatever cut it, the model is told where to resume -- either the file
    // window (`nextOffset`) or the display budget (`Display incomplete`).
    assert.ok(
      /nextOffset=\d+/.test(value.text) || /Display incomplete/.test(value.text),
      'a bounded result must state how to continue',
    )
  } finally {
    space.cleanup()
  }
})

test('a result cut by the display budget keeps its recovery instruction', () => {
  // Force the outer cap with a custom measure so the branch is deterministic.
  const capped = capText('z'.repeat(10000), { budget: 600, measure: (text) => text.length })
  assert.match(capped, /Display incomplete/)
  assert.ok(capped.length <= 600)
})

test('argument validation rejects an unknown property before any read', async () => {
  const space = workspace()
  try {
    const { definition } = tool(space.ctx)
    await assert.rejects(
      () => definition.execute({ files: [{ path: 'src/a.js', bogus: 1 }] }, space.exec),
      /invalid arguments/i,
    )
    assert.equal(space.host.observed.length, 0, 'nothing may be read when arguments are invalid')
  } finally {
    space.cleanup()
  }
})

test('an unknown configuration key is rejected by name', () => {
  assert.throws(() => readConfig({ maxFiels: 3 }), /unknown configuration key "maxFiels"/)
})

test('config bounds are clamped rather than trusted', () => {
  const config = readConfig({ maxFiles: 9999, defaultLimit: 999999, maxLineLength: 1 })
  assert.equal(config.maxFiles, 32)
  assert.equal(config.defaultLimit, 2000)
  assert.equal(config.maxLineLength, 80)
})

test('a line longer than the cap is clipped and marked', () => {
  const window = buildWindow(`${'y'.repeat(500)}\nshort\n`, {
    offset: 1,
    limit: 10,
    maxLineLength: 100,
    maxBytes: 10 * 1024,
  })
  assert.equal(window.lines.length, 2)
  assert.equal(window.lines[0].text.length, 100)
  assert.equal(window.truncatedInLine.line, 1)
  assert.equal(window.truncatedInLine.charactersOmitted, 400)
  assert.equal(window.complete, true)
})

test('byte accounting matches the host: CRLF counts once, trailing LF adds no line', () => {
  const window = buildWindow('a\r\nb\r\n', { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 1024 })
  assert.equal(window.lineCount, 2)
  assert.equal(window.lines[0].text, 'a')
  assert.equal(window.lines[1].text, 'b')
})

test('an empty file has zero lines and is complete', () => {
  const window = buildWindow('', { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 1024 })
  assert.equal(window.lineCount, 0)
  assert.equal(window.lines.length, 0)
  assert.equal(window.complete, true)
})

test('the byte cap stops the window and names the resume offset', () => {
  const body = Array.from({ length: 100 }, (_, index) => `${index}:${'z'.repeat(50)}`).join('\n')
  const window = buildWindow(body, { offset: 1, limit: 100, maxLineLength: 200, maxBytes: 500 })
  assert.equal(window.truncatedByBytes, true)
  assert.equal(window.complete, false)
  assert.ok(window.nextOffset > 1)
})

test('revisionOf is stable and hex', () => {
  const buffer = Buffer.from('stable body', 'utf8')
  assert.equal(revisionOf(buffer), revisionOf(Buffer.from('stable body', 'utf8')))
  assert.match(revisionOf(buffer), /^[a-f0-9]{64}$/)
})
