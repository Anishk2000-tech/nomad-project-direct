// Streaming ZIP and TAR extraction with no external tools. ZIP supports stored/deflate entries and
// ZIP64 (Ollama's Windows bundle is >1 GB); TAR supports ustar, pax and GNU long names, gzip or
// zstd compression, and OCI whiteouts so container image layers can be applied in order.
import { createReadStream, createWriteStream } from 'node:fs'
import { open, mkdir, rm, symlink, chmod, copyFile, readdir, utimes, lstat } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { isWin } from './util.mjs'

/** Normalise an archive path, apply strip/filter/map, and guard against path traversal. */
function resolveTarget(destDir, rawName, { strip = 0, filter, map } = {}) {
  let name = rawName.replace(/\\/g, '/').replace(/^\.?\/+/, '')
  if (!name) return null
  let parts = name.split('/').filter((p) => p && p !== '.')
  if (parts.some((p) => p === '..')) return null
  if (strip > 0) {
    if (parts.length <= strip) return null
    parts = parts.slice(strip)
  }
  let rel = parts.join('/')
  if (map) {
    rel = map(rel)
    if (rel === null || rel === undefined || rel === '') return null
  }
  if (filter && !filter(rel)) return null
  const target = path.resolve(destDir, ...rel.split('/'))
  const root = path.resolve(destDir)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  return { rel, target }
}

// ───────────────────────────────── ZIP ─────────────────────────────────

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fh.read(buf, 0, length, position)
  return buf.subarray(0, bytesRead)
}

export async function listZip(zipPath) {
  const fh = await open(zipPath, 'r')
  try {
    const { size } = await fh.stat()
    const tailLen = Math.min(size, 65557)
    const tail = await readAt(fh, size - tailLen, tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error(`Not a zip file (no end of central directory): ${zipPath}`)
    let entries = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)

    // ZIP64 end of central directory locator sits right before the EOCD.
    const locPos = eocd - 20
    if (locPos >= 0 && tail.readUInt32LE(locPos) === 0x07064b50) {
      const z64Offset = Number(tail.readBigUInt64LE(locPos + 8))
      const z64 = await readAt(fh, z64Offset, 56)
      if (z64.readUInt32LE(0) === 0x06064b50) {
        entries = Number(z64.readBigUInt64LE(32))
        cdSize = Number(z64.readBigUInt64LE(40))
        cdOffset = Number(z64.readBigUInt64LE(48))
      }
    }

    const cd = await readAt(fh, cdOffset, cdSize)
    const list = []
    let p = 0
    for (let i = 0; i < entries && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory')
      const madeBy = cd.readUInt16LE(p + 4)
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      let compSize = cd.readUInt32LE(p + 20)
      let size = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const extAttr = cd.readUInt32LE(p + 38)
      let localOffset = cd.readUInt32LE(p + 42)
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen)
      const name = flags & 0x800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1')
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
      // ZIP64 extended info: only the fields saturated in the fixed header are present, in order.
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(e)
        const len = extra.readUInt16LE(e + 2)
        if (id === 0x0001) {
          let q = e + 4
          if (size === 0xffffffff) {
            size = Number(extra.readBigUInt64LE(q))
            q += 8
          }
          if (compSize === 0xffffffff) {
            compSize = Number(extra.readBigUInt64LE(q))
            q += 8
          }
          if (localOffset === 0xffffffff) {
            localOffset = Number(extra.readBigUInt64LE(q))
            q += 8
          }
        }
        e += 4 + len
      }
      const unixMode = madeBy >> 8 === 3 ? (extAttr >>> 16) & 0xffff : 0
      list.push({
        name,
        method,
        compSize,
        size,
        localOffset,
        isDir: name.endsWith('/'),
        isSymlink: (unixMode & 0o170000) === 0o120000,
        mode: unixMode & 0o777,
      })
      p += 46 + nameLen + extraLen + commentLen
    }
    return list
  } finally {
    await fh.close()
  }
}

export async function extractZip(zipPath, destDir, opts = {}) {
  const entries = await listZip(zipPath)
  await mkdir(destDir, { recursive: true })
  const fh = await open(zipPath, 'r')
  let done = 0
  const totalBytes = entries.reduce((s, e) => s + e.size, 0)
  let bytes = 0
  try {
    for (const entry of entries) {
      const resolved = resolveTarget(destDir, entry.name, opts)
      done++
      if (!resolved) continue
      if (entry.isDir) {
        await mkdir(resolved.target, { recursive: true })
        continue
      }
      await mkdir(path.dirname(resolved.target), { recursive: true })
      const header = await readAt(fh, entry.localOffset, 30)
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`Corrupt zip local header for ${entry.name}`)
      const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)

      if (entry.isSymlink && !isWin) {
        const linkTarget = (await readAt(fh, dataStart, entry.compSize)).toString('utf8')
        await rm(resolved.target, { force: true })
        await symlink(linkTarget, resolved.target).catch(() => {})
        continue
      }

      const source =
        entry.compSize > 0
          ? createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compSize - 1 })
          : null
      const out = createWriteStream(resolved.target)
      if (!source) {
        out.end()
        await once(out, 'close')
      } else if (entry.method === 0) {
        await pipeline(source, out)
      } else if (entry.method === 8) {
        await pipeline(source, zlib.createInflateRaw(), out)
      } else {
        out.destroy()
        throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`)
      }
      if (!isWin && entry.mode) await chmod(resolved.target, entry.mode).catch(() => {})
      bytes += entry.size
      opts.onProgress?.({ current: bytes, total: totalBytes, entries: done, totalEntries: entries.length })
    }
  } finally {
    await fh.close()
  }
}

// ───────────────────────────────── TAR ─────────────────────────────────

/** Pulls exact byte counts out of an async-iterable byte stream. */
class ByteReader {
  constructor(iterable) {
    this.it = iterable[Symbol.asyncIterator]()
    this.buf = Buffer.alloc(0)
    this.ended = false
  }

  async _fill(n) {
    while (this.buf.length < n && !this.ended) {
      const { value, done } = await this.it.next()
      if (done) {
        this.ended = true
        break
      }
      this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : Buffer.from(value)
    }
  }

  async read(n) {
    await this._fill(n)
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(out.length)
    return out
  }

  /** Yield `n` bytes as a sequence of chunks without buffering them all. */
  async *chunks(n) {
    let remaining = n
    while (remaining > 0) {
      if (this.buf.length === 0) {
        if (this.ended) throw new Error('Unexpected end of tar stream')
        const { value, done } = await this.it.next()
        if (done) {
          this.ended = true
          throw new Error('Unexpected end of tar stream')
        }
        this.buf = Buffer.from(value)
      }
      const take = Math.min(remaining, this.buf.length)
      const chunk = this.buf.subarray(0, take)
      this.buf = this.buf.subarray(take)
      remaining -= take
      yield chunk
    }
  }

  async skip(n) {
    for await (const _ of this.chunks(n)) {
      // discard
    }
  }
}

function parseOctal(buf) {
  // GNU base-256 encoding for large values (high bit set in first byte).
  if (buf[0] & 0x80) {
    let v = 0n
    for (let i = 1; i < buf.length; i++) v = (v << 8n) + BigInt(buf[i])
    return Number(v)
  }
  const s = buf.toString('latin1').replace(/\0.*$/s, '').trim()
  return s ? parseInt(s, 8) : 0
}

function cstr(buf) {
  const i = buf.indexOf(0)
  return buf.subarray(0, i < 0 ? buf.length : i).toString('utf8')
}

function parsePax(buf) {
  const out = {}
  let p = 0
  while (p < buf.length) {
    const sp = buf.indexOf(0x20, p)
    if (sp < 0) break
    const len = parseInt(buf.subarray(p, sp).toString('latin1'), 10)
    if (!len) break
    const rec = buf.subarray(sp + 1, p + len - 1).toString('utf8')
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    p += len
  }
  return out
}

function decompressorFor(firstBytes) {
  if (firstBytes[0] === 0x1f && firstBytes[1] === 0x8b) return zlib.createGunzip()
  if (firstBytes.readUInt32LE(0) === 0xfd2fb528) {
    if (typeof zlib.createZstdDecompress !== 'function') {
      throw new Error('This Node.js build cannot decompress zstd archives')
    }
    return zlib.createZstdDecompress()
  }
  return null
}

/**
 * Extract a (possibly compressed) tar file. Options:
 *   strip, filter(rel), map(rel) → rel|null, whiteouts (apply OCI .wh. files), onEntry(rel)
 */
export async function extractTarFile(tarPath, destDir, opts = {}) {
  const fh = await open(tarPath, 'r')
  const head = await readAt(fh, 0, 4)
  await fh.close()
  const decomp = head.length >= 4 ? decompressorFor(head) : null
  const src = createReadStream(tarPath)
  const stream = decomp ? src.pipe(decomp) : src
  src.on('error', (e) => stream.destroy(e))
  await extractTarStream(stream, destDir, opts)
}

export async function extractTarStream(stream, destDir, opts = {}) {
  await mkdir(destDir, { recursive: true })
  const reader = new ByteReader(stream)
  const deferredLinks = []
  let longName = null
  let longLink = null
  let pax = {}
  let zeroBlocks = 0

  while (true) {
    const header = await reader.read(512)
    if (header.length < 512) break
    if (header.every((b) => b === 0)) {
      if (++zeroBlocks >= 2) break
      continue
    }
    zeroBlocks = 0

    const type = String.fromCharCode(header[156] || 0x30)
    let size = parseOctal(header.subarray(124, 136))
    const magic = header.subarray(257, 263).toString('latin1')
    let name = cstr(header.subarray(0, 100))
    const prefix = magic.startsWith('ustar') ? cstr(header.subarray(345, 500)) : ''
    if (prefix) name = `${prefix}/${name}`
    let linkName = cstr(header.subarray(157, 257))
    const mode = parseOctal(header.subarray(100, 108))
    const mtime = parseOctal(header.subarray(136, 148))
    const padded = Math.ceil(size / 512) * 512

    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      const data = await reader.read(padded)
      const payload = data.subarray(0, size)
      if (type === 'x') pax = { ...pax, ...parsePax(payload) }
      else if (type === 'L') longName = cstr(payload)
      else if (type === 'K') longLink = cstr(payload)
      continue
    }

    if (pax.path) name = pax.path
    if (pax.linkpath) linkName = pax.linkpath
    if (pax.size) size = Number(pax.size)
    if (longName) name = longName
    if (longLink) linkName = longLink
    pax = {}
    longName = null
    longLink = null
    const dataPadded = Math.ceil(size / 512) * 512

    // OCI whiteouts: ".wh.<name>" deletes <name>; ".wh..wh..opq" empties the directory.
    const base = path.posix.basename(name.replace(/\/+$/, ''))
    if (opts.whiteouts && base.startsWith('.wh.')) {
      const dir = path.posix.dirname(name)
      if (base === '.wh..wh..opq') {
        const r = resolveTarget(destDir, dir, opts)
        if (r) {
          const children = await readdir(r.target).catch(() => [])
          for (const c of children) await rm(path.join(r.target, c), { recursive: true, force: true })
        }
      } else {
        const r = resolveTarget(destDir, path.posix.join(dir, base.slice(4)), opts)
        if (r) await rm(r.target, { recursive: true, force: true })
      }
      await reader.skip(dataPadded)
      continue
    }

    const resolved = resolveTarget(destDir, name, opts)
    if (!resolved) {
      await reader.skip(dataPadded)
      continue
    }
    opts.onEntry?.(resolved.rel)

    if (type === '5') {
      await mkdir(resolved.target, { recursive: true })
      await reader.skip(dataPadded)
      continue
    }

    await mkdir(path.dirname(resolved.target), { recursive: true })

    if (type === '2' || type === '1') {
      // Symlinks resolve relative to the entry; hard links name another archive member.
      deferredLinks.push({ type, target: resolved.target, rel: resolved.rel, linkName })
      await reader.skip(dataPadded)
      continue
    }

    if (type !== '0' && type !== '\0' && type !== '7') {
      // Devices, FIFOs etc. have no meaning for a native unpack.
      await reader.skip(dataPadded)
      continue
    }

    // Replace whatever a lower layer left here (file, symlink, or directory).
    try {
      const st = await lstat(resolved.target)
      if (st.isDirectory()) await rm(resolved.target, { recursive: true, force: true })
      else await rm(resolved.target, { force: true })
    } catch {}

    const out = createWriteStream(resolved.target, { mode: !isWin && mode ? mode & 0o777 : undefined })
    for await (const chunk of reader.chunks(size)) {
      if (!out.write(chunk)) await once(out, 'drain')
    }
    out.end()
    await once(out, 'close')
    if (!isWin && mode) await chmod(resolved.target, mode & 0o7777).catch(() => {})
    if (mtime) await utimes(resolved.target, mtime, mtime).catch(() => {})
    if (dataPadded > size) await reader.skip(dataPadded - size)
  }

  // Links are created after all regular files exist so hard links can be copied and Windows
  // (where symlinks need privileges) can fall back to copying the target file.
  for (const link of deferredLinks) {
    await rm(link.target, { recursive: true, force: true }).catch(() => {})
    if (link.type === '1') {
      const src = resolveTarget(destDir, link.linkName, opts)
      if (src) await copyFile(src.target, link.target).catch(() => {})
      continue
    }
    if (!isWin) {
      await symlink(link.linkName, link.target).catch(() => {})
      continue
    }
    const linkRel = link.linkName.startsWith('/')
      ? link.linkName
      : path.posix.join(path.posix.dirname(link.rel), link.linkName)
    const src = resolveTarget(destDir, linkRel, { ...opts, strip: 0, filter: undefined, map: undefined })
    if (src) await copyFile(src.target, link.target).catch(() => {})
  }
}

/** Detect the archive type by magic bytes and extract it. */
export async function extractArchive(file, destDir, opts = {}) {
  const fh = await open(file, 'r')
  const head = await readAt(fh, 0, 4)
  await fh.close()
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return extractZip(file, destDir, opts)
  return extractTarFile(file, destDir, opts)
}
