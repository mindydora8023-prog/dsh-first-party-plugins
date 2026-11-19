/**
 * PPTX reader tests against a small hand-built fixture: two slides, one
 * table, and speaker notes on the first slide.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listSlides, readPptx, renderSlideXml } from '../lib/pptx.js'

const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.pptx'))

test('listSlides keeps presentation order and prefixes the part path', () => {
  const slides = listSlides(
    '<p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst>',
    '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="/ppt/slides/slide2.xml"/></Relationships>',
  )
  assert.deepEqual(slides, ['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml'])
})

test('renderSlideXml keeps text and turns a table into Markdown', () => {
  const xml = '<p><a:t>Hello</a:t></p><a:tbl><a:tr><a:tc><a:t>A</a:t></a:tc><a:tc><a:t>B</a:t></a:tc></a:tr><a:tr><a:tc><a:t>1</a:t></a:tc><a:tc><a:t>2</a:t></a:tc></a:tr></a:tbl>'
  const text = renderSlideXml(xml, 100)
  assert.match(text, /Hello/)
  assert.match(text, /\| A \| B \|/)
  assert.match(text, /\| 1 \| 2 \|/)
})

test('readPptx pages slides and includes notes only when they have text', () => {
  const first = readPptx(fixture, { offset: 1, limit: 1, maxCellLength: 100, maxBytes: 50000 })
  assert.equal(first.slideCount, 2)
  assert.equal(first.returned, 1)
  assert.match(first.text, /## Slide 1/)
  assert.match(first.text, /Quarterly review/)
  assert.match(first.text, /\| Item \| Qty \|/)
  assert.match(first.text, /\| Bolt \| 4 \|/)
  assert.match(first.text, /### Notes/)
  assert.match(first.text, /Remember the bolt count/)
  assert.match(first.text, /Use offset=2 to continue/)
  const second = readPptx(fixture, { offset: 2, limit: 5, maxCellLength: 100, maxBytes: 50000 })
  assert.match(second.text, /## Slide 2/)
  assert.match(second.text, /Second slide/)
  assert.equal(second.text.includes('### Notes'), false)
  assert.match(second.text, /End of presentation - 2 slides/)
})

test('readPptx rejects a buffer that is not a presentation', () => {
  assert.throws(() => readPptx(Buffer.from('nope'), { offset: 1, limit: 1 }), /not a PPTX container/)
})
