/**
 * Pure-TypeScript reader for the openZIM file format, implementing the subset of the
 * `@openzim/libzim` API NOMAD uses (Archive metadata/illustrations/counts, iterByPath, Entry,
 * Item, Blob). It is the fallback when the native libzim binding is unavailable — notably the
 * Windows native edition, since @openzim/libzim only ships Linux and macOS binaries.
 *
 * Supports ZIM 5/6 with uncompressed, zlib and zstd clusters (every ZIM Kiwix has published
 * since 2021). Legacy XZ-compressed clusters raise ZimCompressionError; metadata that doesn't
 * need cluster data (UUID, counts from directory entries) still works for those files.
 *
 * File handles are closed after a short idle period so Windows can delete/replace ZIM files
 * while NOMAD is running.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import zlib from 'node:zlib'

const ZIM_MAGIC = 72173914
const REDIRECT = 0xffff
const LINKTARGET = 0xfffe
const DELETED = 0xfffd
const NO_MAIN_PAGE = 0xffffffff
const BLOCK_SIZE = 64 * 1024
const MAX_BLOCKS = 64
const MAX_CLUSTERS = 8
const IDLE_CLOSE_MS = 2000

export class ZimCompressionError extends Error {}

interface Dirent {
  index: number
  mimeIndex: number
  namespace: string
  cluster: number
  blob: number
  redirectIndex: number
  path: string
  title: string
}

export class Blob {
  constructor(readonly data: Buffer) {}
  get size(): number {
    return this.data.length
  }
  toString(): string {
    return this.data.toString('utf8')
  }
}

export class Item {
  constructor(
    private archive: Archive,
    private dirent: Dirent
  ) {}
  get path(): string {
    return this.archive._entryPath(this.dirent)
  }
  get title(): string {
    return this.dirent.title || this.dirent.path
  }
  get mimetype(): string {
    return this.archive._mimeType(this.dirent.mimeIndex)
  }
  get index(): number {
    return this.dirent.index
  }
  get data(): Blob {
    return new Blob(this.archive._blob(this.dirent.cluster, this.dirent.blob))
  }
  getData(offset = 0, size?: number): Blob {
    const all = this.archive._blob(this.dirent.cluster, this.dirent.blob)
    return new Blob(all.subarray(offset, size === undefined ? undefined : offset + size))
  }
  get size(): number {
    return this.archive._blob(this.dirent.cluster, this.dirent.blob).length
  }
}

export class Entry {
  constructor(
    private archive: Archive,
    private dirent: Dirent
  ) {}
  get path(): string {
    return this.archive._entryPath(this.dirent)
  }
  get title(): string {
    return this.dirent.title || this.dirent.path
  }
  get index(): number {
    return this.dirent.index
  }
  get isRedirect(): boolean {
    return this.dirent.mimeIndex === REDIRECT
  }
  get redirectEntry(): Entry {
    if (!this.isRedirect) throw new Error(`Entry ${this.path} is not a redirect`)
    return new Entry(this.archive, this.archive._direntAt(this.dirent.redirectIndex))
  }
  get item(): Item {
    return this.getItem(false)
  }
  getItem(follow = false): Item {
    let d = this.dirent
    for (let hops = 0; d.mimeIndex === REDIRECT; hops++) {
      if (!follow) throw new Error(`Entry ${this.path} is a redirect entry`)
      if (hops > 50) throw new Error(`Redirect loop at ${this.path}`)
      d = this.archive._direntAt(d.redirectIndex)
    }
    if (d.mimeIndex === LINKTARGET || d.mimeIndex === DELETED) {
      throw new Error(`Entry ${this.path} has no content`)
    }
    return new Item(this.archive, d)
  }
}

export class Archive {
  readonly filename: string
  private fd: number | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private blocks = new Map<number, Buffer>()
  private clusters = new Map<number, Buffer[]>()
  private sortedClusterOffsets: Float64Array | null = null
  private fileSize = 0

  private majorVersion = 0
  private minorVersion = 0
  private uuidBytes = Buffer.alloc(16)
  private allEntries = 0
  private clusterCount = 0
  private pathPtrPos = 0
  private clusterPtrPos = 0
  private mimeListPos = 0
  private mainPage = NO_MAIN_PAGE
  private checksumPos = 0
  private mimeTypes: string[] = []
  private userRange: [number, number] = [0, 0]

  constructor(filePath: string) {
    this.filename = filePath
    const header = this.read(0, 80)
    if (header.length < 80 || header.readUInt32LE(0) !== ZIM_MAGIC) {
      this.close()
      throw new Error(`Not a ZIM file: ${filePath}`)
    }
    this.majorVersion = header.readUInt16LE(4)
    this.minorVersion = header.readUInt16LE(6)
    header.copy(this.uuidBytes, 0, 8, 24)
    this.allEntries = header.readUInt32LE(24)
    this.clusterCount = header.readUInt32LE(28)
    this.pathPtrPos = Number(header.readBigUInt64LE(32))
    this.clusterPtrPos = Number(header.readBigUInt64LE(48))
    this.mimeListPos = Number(header.readBigUInt64LE(56))
    this.mainPage = header.readUInt32LE(64)
    this.checksumPos = Number(header.readBigUInt64LE(72))
    this.mimeTypes = this.readMimeList()
    this.userRange = this.hasNewNamespaceScheme ? this.namespaceRange('C') : [0, this.allEntries]
  }

  // ── public API (mirrors @openzim/libzim) ──────────────────────────────────

  get filesize(): bigint {
    return BigInt(this.fileSize)
  }

  get uuid(): string {
    const h = this.uuidBytes.toString('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }

  get hasNewNamespaceScheme(): boolean {
    return this.majorVersion >= 6 && this.minorVersion >= 1
  }

  get allEntryCount(): number {
    return this.allEntries
  }

  get entryCount(): number {
    return this.userRange[1] - this.userRange[0]
  }

  get articleCount(): number {
    try {
      const listing = this.findDirent('X', 'listing/titleOrdered/v1')
      if (listing && listing.mimeIndex < this.mimeTypes.length) {
        return Math.floor(this._blob(listing.cluster, listing.blob).length / 4)
      }
    } catch {
      // Fall through to counting directory entries (no cluster data needed).
    }
    if (!this.hasNewNamespaceScheme) {
      const [a, b] = this.namespaceRange('A')
      return b - a
    }
    let count = 0
    const [start, end] = this.userRange
    for (let i = start; i < end; i++) {
      const d = this._direntAt(i)
      if (d.mimeIndex < this.mimeTypes.length && this.mimeTypes[d.mimeIndex].startsWith('text/html')) count++
    }
    return count
  }

  get mediaCount(): number {
    try {
      const counter = this.getMetadata('Counter')
      let total = 0
      for (const part of counter.split(';')) {
        const eq = part.lastIndexOf('=')
        if (eq < 0) continue
        const mime = part.slice(0, eq).trim()
        if (/^(image|video|audio)\//.test(mime)) total += Number(part.slice(eq + 1)) || 0
      }
      return total
    } catch {
      return 0
    }
  }

  get metadataKeys(): string[] {
    const [start, end] = this.namespaceRange('M')
    const keys: string[] = []
    for (let i = start; i < end; i++) keys.push(this._direntAt(i).path)
    return keys
  }

  getMetadata(name: string): string {
    return this.getMetadataItem(name).data.data.toString('utf8')
  }

  getMetadataItem(name: string): Item {
    const d = this.findDirent('M', name)
    if (!d) throw new Error(`Cannot find metadata ${name}`)
    return new Entry(this, d).getItem(true)
  }

  get illustrationSizes(): Set<number> {
    const sizes = new Set<number>()
    for (const key of this.metadataKeys) {
      const m = /^Illustration_(\d+)x(\d+)@(\d+)$/.exec(key)
      if (m && m[1] === m[2] && m[3] === '1') sizes.add(Number(m[1]))
    }
    if (sizes.size === 0 && this.faviconDirent()) sizes.add(48)
    return sizes
  }

  getIllustrationItem(size = 48): Item {
    const d = this.findDirent('M', `Illustration_${size}x${size}@1`) ?? (size === 48 ? this.faviconDirent() : null)
    if (!d) throw new Error(`Cannot find illustration item of size ${size}`)
    return new Entry(this, d).getItem(true)
  }

  get hasMainEntry(): boolean {
    return this.mainPage !== NO_MAIN_PAGE && this.mainPage < this.allEntries
  }

  get mainEntry(): Entry {
    if (!this.hasMainEntry) throw new Error('No main entry')
    return new Entry(this, this._direntAt(this.mainPage))
  }

  hasEntryByPath(path: string): boolean {
    return this.lookupPath(path) !== null
  }

  getEntryByPath(path: string): Entry {
    const d = this.lookupPath(path)
    if (!d) throw new Error(`Cannot find entry ${path}`)
    return new Entry(this, d)
  }

  *iterByPath(): Generator<Entry> {
    const [start, end] = this.userRange
    for (let i = start; i < end; i++) yield new Entry(this, this._direntAt(i))
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {}
      this.fd = null
    }
  }

  // ── internals (underscore-prefixed members are used by Entry/Item) ────────

  _entryPath(d: Dirent): string {
    return this.hasNewNamespaceScheme ? d.path : `${d.namespace}/${d.path}`
  }

  _mimeType(index: number): string {
    return this.mimeTypes[index] ?? ''
  }

  _direntAt(index: number): Dirent {
    if (index < 0 || index >= this.allEntries) throw new Error(`Entry index ${index} out of range`)
    const offset = Number(this.readCached(this.pathPtrPos + index * 8, 8).readBigUInt64LE(0))
    return this.parseDirent(offset, index)
  }

  _blob(cluster: number, blob: number): Buffer {
    const blobs = this.loadCluster(cluster)
    if (blob >= blobs.length) throw new Error(`Blob ${blob} out of range in cluster ${cluster}`)
    return blobs[blob]
  }

  private faviconDirent(): Dirent | null {
    return this.hasNewNamespaceScheme ? null : this.findDirent('-', 'favicon')
  }

  private lookupPath(path: string): Dirent | null {
    if (this.hasNewNamespaceScheme) return this.findDirent('C', path)
    const m = /^(.)\/(.*)$/s.exec(path)
    if (m) return this.findDirent(m[1], m[2])
    return this.findDirent('A', path)
  }

  private compare(d: Dirent, ns: string, path: Buffer | null): number {
    if (d.namespace !== ns) return d.namespace < ns ? -1 : 1
    if (path === null) return 0
    return Buffer.compare(Buffer.from(d.path, 'utf8'), path)
  }

  /** [first, end) indexes of a namespace in the path-ordered directory. */
  private namespaceRange(ns: string): [number, number] {
    const lower = (target: string) => {
      let lo = 0
      let hi = this.allEntries
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (this._direntAt(mid).namespace < target) lo = mid + 1
        else hi = mid
      }
      return lo
    }
    return [lower(ns), lower(String.fromCharCode(ns.charCodeAt(0) + 1))]
  }

  private findDirent(ns: string, path: string): Dirent | null {
    const key = Buffer.from(path, 'utf8')
    let lo = 0
    let hi = this.allEntries - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const d = this._direntAt(mid)
      const c = this.compare(d, ns, key)
      if (c === 0) return d
      if (c < 0) lo = mid + 1
      else hi = mid - 1
    }
    return null
  }

  private parseDirent(offset: number, index: number): Dirent {
    let buf = this.readCached(offset, 1024)
    const mimeIndex = buf.readUInt16LE(0)
    const parameterLen = buf.readUInt8(2)
    const namespace = String.fromCharCode(buf[3])
    let cluster = 0
    let blob = 0
    let redirectIndex = 0
    let pos: number
    if (mimeIndex === REDIRECT) {
      redirectIndex = buf.readUInt32LE(8)
      pos = 12
    } else if (mimeIndex === LINKTARGET || mimeIndex === DELETED) {
      pos = 8
    } else {
      cluster = buf.readUInt32LE(8)
      blob = buf.readUInt32LE(12)
      pos = 16
    }
    let pathEnd = buf.indexOf(0, pos)
    let titleEnd = pathEnd >= 0 ? buf.indexOf(0, pathEnd + 1) : -1
    if (pathEnd < 0 || titleEnd < 0) {
      buf = this.read(offset, 64 * 1024 + parameterLen)
      pathEnd = buf.indexOf(0, pos)
      titleEnd = buf.indexOf(0, pathEnd + 1)
      if (pathEnd < 0 || titleEnd < 0) throw new Error(`Corrupt directory entry at offset ${offset}`)
    }
    return {
      index,
      mimeIndex,
      namespace,
      cluster,
      blob,
      redirectIndex,
      path: buf.toString('utf8', pos, pathEnd),
      title: buf.toString('utf8', pathEnd + 1, titleEnd),
    }
  }

  private readMimeList(): string[] {
    const len = Math.max(0, Math.min(64 * 1024, this.pathPtrPos - this.mimeListPos)) || 4096
    const buf = this.read(this.mimeListPos, len)
    const out: string[] = []
    let start = 0
    while (start < buf.length) {
      const end = buf.indexOf(0, start)
      if (end < 0 || end === start) break
      out.push(buf.toString('utf8', start, end))
      start = end + 1
    }
    return out
  }

  private clusterOffset(n: number): number {
    return Number(this.readCached(this.clusterPtrPos + n * 8, 8).readBigUInt64LE(0))
  }

  private clusterEnd(n: number, start: number): number {
    if (n + 1 < this.clusterCount) {
      const next = this.clusterOffset(n + 1)
      if (next > start) return next
    }
    if (!this.sortedClusterOffsets) {
      const all = new Float64Array(this.clusterCount)
      for (let i = 0; i < this.clusterCount; i++) all[i] = this.clusterOffset(i)
      this.sortedClusterOffsets = all.sort()
    }
    const sorted = this.sortedClusterOffsets
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (sorted[mid] <= start) lo = mid + 1
      else hi = mid
    }
    if (lo < sorted.length) return sorted[lo]
    return this.checksumPos > start ? this.checksumPos : this.fileSize
  }

  private loadCluster(n: number): Buffer[] {
    const cached = this.clusters.get(n)
    if (cached) {
      this.clusters.delete(n)
      this.clusters.set(n, cached)
      return cached
    }
    if (n >= this.clusterCount) throw new Error(`Cluster ${n} out of range`)
    const start = this.clusterOffset(n)
    const end = this.clusterEnd(n, start)
    const raw = this.read(start, end - start)
    const info = raw[0]
    const compression = info & 0x0f
    const extended = (info & 0x10) !== 0
    const body = raw.subarray(1)
    let data: Buffer
    if (compression === 0 || compression === 1) data = body
    else if (compression === 2) data = zlib.inflateSync(body)
    else if (compression === 5) {
      const zstd = (zlib as any).zstdDecompressSync as ((b: Buffer) => Buffer) | undefined
      if (!zstd) throw new ZimCompressionError('This Node.js version cannot decompress zstd ZIM clusters (needs Node 22.15+)')
      data = zstd(body)
    } else if (compression === 4) {
      throw new ZimCompressionError(`${this.filename} uses legacy XZ compression, which the built-in ZIM reader does not support`)
    } else {
      throw new ZimCompressionError(`Unsupported ZIM cluster compression type ${compression}`)
    }

    const offSize = extended ? 8 : 4
    const readOff = (i: number) => (extended ? Number(data.readBigUInt64LE(i * offSize)) : data.readUInt32LE(i * offSize))
    const first = readOff(0)
    const count = first / offSize
    const blobs: Buffer[] = []
    for (let i = 0; i < count - 1; i++) blobs.push(data.subarray(readOff(i), readOff(i + 1)))

    this.clusters.set(n, blobs)
    if (this.clusters.size > MAX_CLUSTERS) this.clusters.delete(this.clusters.keys().next().value!)
    return blobs
  }

  private ensureOpen(): number {
    if (this.fd === null) {
      this.fd = openSync(this.filename, 'r')
      this.fileSize = fstatSync(this.fd).size
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS)
    this.idleTimer.unref?.()
    return this.fd
  }

  private read(pos: number, len: number): Buffer {
    const fd = this.ensureOpen()
    const buf = Buffer.allocUnsafe(len)
    let off = 0
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, pos + off)
      if (n === 0) break
      off += n
    }
    return buf.subarray(0, off)
  }

  /** Reads through a small LRU of 64 KiB blocks (directory and pointer lookups hit the same pages). */
  private readCached(pos: number, len: number): Buffer {
    const first = Math.floor(pos / BLOCK_SIZE)
    const last = Math.floor((pos + len - 1) / BLOCK_SIZE)
    const parts: Buffer[] = []
    for (let b = first; b <= last; b++) {
      let block = this.blocks.get(b)
      if (block) {
        this.blocks.delete(b)
      } else {
        block = this.read(b * BLOCK_SIZE, BLOCK_SIZE)
      }
      this.blocks.set(b, block)
      if (this.blocks.size > MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value!)
      parts.push(block)
    }
    const joined = parts.length === 1 ? parts[0] : Buffer.concat(parts)
    const start = pos - first * BLOCK_SIZE
    return joined.subarray(start, start + len)
  }
}
