import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { Archive } from '../../app/utils/zim_reader.js'

// Reference values below were taken from the official libzim (python-libzim 3.13 / libzim 9)
// for the starter ZIM shipped in install/. The JS reader must match it exactly.
const ZIM = join(process.cwd(), '..', 'install', 'wikipedia_en_100_mini_2026-01.zim')
const skip = !existsSync(ZIM) && 'bundled ZIM not present'

test('zim_reader: archive-level values match libzim', { skip }, () => {
  const a = new Archive(ZIM)
  try {
    assert.equal(a.uuid, 'f33283c0-0d00-3ceb-20ba-69d9b793a4dd')
    assert.equal(a.filesize, 4537782n)
    assert.equal(a.hasNewNamespaceScheme, true)
    assert.equal(a.allEntryCount, 5133)
    assert.equal(a.entryCount, 5116)
    assert.equal(a.articleCount, 4985)
    assert.equal(a.mediaCount, 108)
    assert.deepEqual([...a.illustrationSizes], [48])
  } finally {
    a.close()
  }
})

test('zim_reader: metadata and illustration', { skip }, () => {
  const a = new Archive(ZIM)
  try {
    assert.equal(a.getMetadata('Title'), 'Wikipedia 100')
    assert.equal(a.getMetadata('Language'), 'eng')
    assert.equal(a.getMetadata('Name'), 'wikipedia_en_100')
    assert.throws(() => a.getMetadata('DoesNotExist'))
    const icon = a.getIllustrationItem(48)
    assert.equal(icon.mimetype, 'image/png')
    assert.deepEqual([...icon.data.data.subarray(1, 4)], [0x50, 0x4e, 0x47]) // "PNG"
  } finally {
    a.close()
  }
})

test('zim_reader: entries, redirects and content', { skip }, () => {
  const a = new Archive(ZIM)
  try {
    const animal = a.getEntryByPath('Animal')
    assert.equal(animal.title, 'Animal')
    assert.equal(animal.isRedirect, false)
    assert.equal(animal.item.mimetype, 'text/html')
    assert.equal(animal.item.data.size, 12055)
    assert.match(animal.item.data.data.toString('utf8'), /Animal/)

    assert.equal(a.mainEntry.path, 'mainPage')
    assert.equal(a.mainEntry.isRedirect, true)
    assert.throws(() => a.mainEntry.item, /redirect/)
    assert.ok(a.mainEntry.getItem(true).mimetype.startsWith('text/html'))

    let count = 0
    let first = ''
    for (const e of a.iterByPath()) {
      if (count === 0) first = e.path
      count++
    }
    assert.equal(count, 5116)
    assert.equal(first, '(Keep_Your)_Hands_Off_(Of_It)') // same path order as libzim
  } finally {
    a.close()
  }
})
