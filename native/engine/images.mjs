// Image store. An "image" is an installed native package for one image reference, stored as
//   <home>/images/<id>/image.json   (Docker-like metadata + recipe bookkeeping)
//   <home>/images/<id>/rootfs/      (the unpacked package)
// Tags point at the newest pull; an older package stays on disk ("dangling") while a container
// still uses it, exactly like Docker keeps superseded layers, so updates never delete files a
// running process has open (Windows refuses that anyway).
import path from 'node:path'
import { readdir, rename, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { downloadFile } from './lib/download.mjs'
import { extractArchive } from './lib/archive.mjs'
import { extractImage, parseImageRef, canonicalRepo, canonicalRepoTag } from './lib/oci.mjs'
import { findRecipe, getRecipe } from './recipes/index.mjs'
import {
  EngineError,
  ensureDir,
  formatBytes,
  nowIso,
  pathExists,
  randomHex,
  readJson,
  removeWithRetry,
  writeJsonAtomic,
} from './lib/util.mjs'

async function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries = []
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) total += (await stat(p).catch(() => ({ size: 0 }))).size
    }
  }
  return total
}

/** Split a pull request's fromImage/tag into a normalized reference. Tags may be digests. */
export function normalizeRef(fromImage, tag) {
  let ref = fromImage
  if (tag) ref = tag.startsWith('sha256:') ? `${fromImage}@${tag}` : `${fromImage}:${tag}`
  const parsed = parseImageRef(ref)
  const repo = canonicalRepo(ref)
  return { ref, repo, tag: parsed.digest ? parsed.digest : parsed.tag, repoTag: canonicalRepoTag(ref), digest: parsed.digest }
}

export class ImageStore {
  constructor({ home, logger }) {
    this.home = home
    this.dir = path.join(home, 'images')
    this.cacheDir = path.join(home, 'cache')
    this.log = logger.child('images')
    this.images = new Map()
    this.pulls = new Map()
  }

  async load() {
    await ensureDir(this.dir)
    for (const name of await readdir(this.dir).catch(() => [])) {
      if (name.startsWith('.')) {
        // Leftover staging directory from an interrupted pull.
        await removeWithRetry(path.join(this.dir, name)).catch(() => {})
        continue
      }
      const meta = await readJson(path.join(this.dir, name, 'image.json'))
      if (meta?.Id) this.images.set(meta.Id, { ...meta, dir: path.join(this.dir, name) })
    }
    this.log.info(`Loaded ${this.images.size} image(s)`)
  }

  list() {
    return [...this.images.values()]
  }

  /** Find by "repo:tag", "repo@digest", full/short id, or bare repo (implies :latest). */
  find(nameOrId) {
    if (!nameOrId) return null
    const needle = String(nameOrId)
    const id = needle.replace(/^sha256:/, '')
    for (const img of this.images.values()) {
      if (img.Id === `sha256:${id}` || (id.length >= 6 && /^[0-9a-f]+$/.test(id) && img.Id.startsWith(`sha256:${id}`))) return img
    }
    let norm
    try {
      norm = normalizeRef(needle)
    } catch {
      return null
    }
    for (const img of this.images.values()) {
      if (img.RepoTags?.includes(norm.repoTag)) return img
      if (norm.digest && img.RepoDigests?.some((d) => d === `${norm.repo}@${norm.digest}`)) return img
    }
    return null
  }

  get(nameOrId) {
    const img = this.find(nameOrId)
    if (!img) throw new EngineError(404, `No such image: ${nameOrId}`)
    return img
  }

  rootfs(img) {
    return img.LocalDir || path.join(img.dir, 'rootfs')
  }

  inspect(img) {
    return {
      Id: img.Id,
      RepoTags: img.RepoTags || [],
      RepoDigests: img.RepoDigests || [],
      Created: img.Created,
      Size: img.Size || 0,
      VirtualSize: img.Size || 0,
      Architecture: process.arch === 'arm64' ? 'arm64' : 'amd64',
      Os: process.platform === 'win32' ? 'windows' : 'linux',
      Config: { Env: [], Cmd: null, Labels: { 'io.project-nomad.native.recipe': img.Recipe, 'io.project-nomad.native.version': img.Version } },
      Metadata: { LastTagTime: img.Created },
      NomadNative: { recipe: img.Recipe, version: img.Version, key: img.Key, dir: this.rootfs(img) },
    }
  }

  summary(img) {
    return {
      Id: img.Id,
      ParentId: '',
      RepoTags: img.RepoTags?.length ? img.RepoTags : ['<none>:<none>'],
      RepoDigests: img.RepoDigests || [],
      Created: Math.floor(Date.parse(img.Created) / 1000),
      Size: img.Size || 0,
      SharedSize: -1,
      VirtualSize: img.Size || 0,
      Labels: {},
      Containers: -1,
    }
  }

  /**
   * Pull (install) an image. `emit(obj)` receives Docker-style JSON progress messages.
   * Concurrent pulls of the same reference share one operation.
   */
  pull(fromImage, tag, emit = () => {}) {
    const norm = normalizeRef(fromImage, tag)
    const key = norm.repoTag
    if (this.pulls.has(key)) {
      const listeners = this.pulls.get(key).listeners
      listeners.add(emit)
      return this.pulls.get(key).promise.finally(() => listeners.delete(emit))
    }
    const listeners = new Set([emit])
    const broadcast = (obj) => {
      for (const fn of listeners) {
        try {
          fn(obj)
        } catch {}
      }
    }
    const promise = this._pull(norm, broadcast).finally(() => this.pulls.delete(key))
    this.pulls.set(key, { promise, listeners })
    return promise
  }

  async _pull(norm, emit) {
    const started = Date.now()
    const recipe = findRecipe(norm.repo)
    const shortId = (norm.tag || 'latest').slice(0, 19)
    emit({ status: `Pulling from ${norm.repo}`, id: shortId })

    const override = process.env[`NOMAD_ENGINE_OVERRIDE_${recipe.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]
    let resolved
    if (override) {
      resolved = { version: 'local', key: `local:${override}`, local: override }
    } else {
      emit({ status: 'Resolving native build', id: shortId })
      resolved = await recipe.resolve({ repo: norm.repo, tag: norm.tag, ref: norm.ref })
    }

    const existing = this.find(norm.repoTag) || (norm.digest ? this.find(norm.ref) : null)
    if (existing && existing.Key === resolved.key && existing.Recipe === recipe.id && (await pathExists(this.rootfs(existing)))) {
      emit({ status: `Status: Image is up to date for ${norm.repoTag}` })
      return existing
    }

    const id = `sha256:${createHash('sha256').update(`${norm.repoTag}\n${recipe.id}\n${resolved.key}`).digest('hex')}`
    const staging = path.join(this.dir, `.staging-${randomHex(6)}`)
    const rootfs = path.join(staging, 'rootfs')
    await ensureDir(rootfs)
    const meta = {}

    const layerId = resolved.version ? String(resolved.version).slice(0, 12) : shortId
    const progress = (status, current, total) =>
      emit({
        status,
        id: layerId,
        ...(total ? { progressDetail: { current, total }, progress: `${formatBytes(current)}/${formatBytes(total)}` } : {}),
      })

    const ctx = {
      dir: rootfs,
      meta,
      repo: norm.repo,
      tag: norm.tag,
      engineHome: this.home,
      cacheDir: path.join(this.cacheDir, 'downloads'),
      log: this.log,
      progress: (status) => progress(status),
      download: async (url, dest, opts = {}) => {
        const t = Date.now()
        let bytes = 0
        await downloadFile(url, dest, {
          ...opts,
          onProgress: ({ current, total }) => {
            bytes = current
            progress('Downloading', current, total)
          },
        })
        const secs = (Date.now() - t) / 1000
        this.log.info(`Downloaded ${url} (${formatBytes(bytes)} in ${secs.toFixed(0)}s, ${formatBytes(bytes / Math.max(secs, 0.001))}/s)`)
        return dest
      },
      // Download into the shared cache (reused across re-pulls) and return the file path.
      fetch: async (url, name, opts = {}) => {
        const dest = path.join(this.cacheDir, 'downloads', name.replace(/[^\w.+-]/g, '_'))
        if (!(await pathExists(dest))) await ctx.download(url, dest, opts)
        return dest
      },
      extract: async (file, dest, opts = {}) => {
        progress('Extracting')
        await extractArchive(file, dest, opts)
      },
      oci: async (ref, dest, map) => {
        const res = await extractImage(ref, dest, {
          cacheDir: path.join(this.cacheDir, 'blobs'),
          map,
          onProgress: (p) => progress(p.phase === 'download' ? 'Downloading' : 'Extracting', p.current, p.total),
        })
        meta.ociDigest = res.digest
        return res
      },
      run: (cmd, args, opts = {}) =>
        new Promise((resolve, reject) => {
          const child = execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
            if (err) {
              const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-15).join('\n')
              reject(new EngineError(500, `${path.basename(cmd)} failed: ${err.message}\n${tail}`))
            } else resolve({ stdout, stderr })
          })
          child.stdout?.on('data', (d) => {
            const line = d.toString().trim().split('\n').pop()
            if (line) emit({ status: line.slice(0, 200), id: layerId })
          })
        }),
    }

    try {
      if (!resolved.local) await recipe.install(ctx, resolved)
      const size = resolved.local ? 0 : await dirSize(rootfs)
      const record = {
        Id: id,
        RepoTags: norm.digest ? [] : [norm.repoTag],
        RepoDigests: [
          ...(resolved.repoDigests || []),
          ...(norm.digest ? [`${norm.repo}@${norm.digest}`] : []),
          ...(meta.ociDigest && !norm.digest ? [`${norm.repo}@${meta.ociDigest}`] : []),
          ...(!meta.ociDigest && !norm.digest && !resolved.repoDigests
            ? [`${norm.repo}@sha256:${createHash('sha256').update(resolved.key).digest('hex')}`]
            : []),
        ],
        Created: nowIso(),
        Size: size,
        Recipe: recipe.id,
        Repo: norm.repo,
        Version: resolved.version,
        Key: resolved.key,
        LocalDir: resolved.local || null,
        Meta: meta,
      }
      await writeJsonAtomic(path.join(staging, 'image.json'), record)

      const finalDir = path.join(this.dir, id.slice(7, 19))
      if (await pathExists(finalDir)) {
        const inUse = this.images.get(id)
        if (inUse) this.images.delete(id)
        await removeWithRetry(finalDir)
      }
      await rename(staging, finalDir)

      // Move tags off older images of the same reference (they become dangling).
      for (const img of this.images.values()) {
        if (img.Id !== id && img.RepoTags?.includes(norm.repoTag)) {
          img.RepoTags = img.RepoTags.filter((t) => t !== norm.repoTag)
          if (!img.RepoTags.length) img.Dangling = true
          await writeJsonAtomic(path.join(img.dir, 'image.json'), { ...img, dir: undefined })
        }
      }
      const loaded = { ...record, dir: finalDir }
      this.images.set(id, loaded)
      emit({ status: 'Digest: ' + (record.RepoDigests[0]?.split('@')[1] ?? id) })
      emit({ status: `Status: Downloaded newer image for ${norm.repoTag}` })
      this.log.info(`Pulled ${norm.repoTag} → ${recipe.id} ${resolved.version} in ${((Date.now() - started) / 1000).toFixed(0)}s`)
      return loaded
    } catch (err) {
      await removeWithRetry(staging).catch(() => {})
      throw err
    }
  }

  async remove(nameOrId, { inUse = () => false, force = false } = {}) {
    const img = this.get(nameOrId)
    if (inUse(img) && !force) {
      throw new EngineError(409, `conflict: unable to remove image ${nameOrId} - image is being used by a container`)
    }
    this.images.delete(img.Id)
    await removeWithRetry(img.dir)
    return [{ Untagged: img.RepoTags?.[0] ?? img.Id }, { Deleted: img.Id }]
  }

  /** Delete superseded (dangling) images that no container references. */
  async prune(inUse) {
    const removed = []
    for (const img of [...this.images.values()]) {
      if (img.Dangling && !inUse(img)) {
        await this.remove(img.Id, { inUse }).catch(() => {})
        removed.push(img.Id)
      }
    }
    return removed
  }

  recipeFor(img) {
    return getRecipe(img.Recipe)
  }
}

