// Minimal OCI / Docker Registry v2 client. It lets the engine take files straight out of the
// images NOMAD already pins (static web apps, Python sources, Linux binaries for testing)
// without a container runtime: resolve the manifest for our platform, download the layer
// blobs (cached by digest) and apply them in order with whiteouts.
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { downloadFile, fetchWithTimeout } from './download.mjs'
import { extractTarFile } from './archive.mjs'
import { ensureDir, EngineError } from './util.mjs'

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

export function parseImageRef(ref) {
  let rest = ref.trim()
  let digest = null
  const at = rest.indexOf('@')
  if (at >= 0) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
  }
  let tag = null
  const lastColon = rest.lastIndexOf(':')
  if (lastColon > rest.lastIndexOf('/')) {
    tag = rest.slice(lastColon + 1)
    rest = rest.slice(0, lastColon)
  }
  const first = rest.split('/')[0]
  const hasRegistry = rest.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')
  let registry = hasRegistry ? first : 'docker.io'
  let repository = hasRegistry ? rest.slice(first.length + 1) : rest
  if (registry === 'docker.io' && !repository.includes('/')) repository = `library/${repository}`
  const apiHost = registry === 'docker.io' ? 'registry-1.docker.io' : registry
  if (!tag && !digest) tag = 'latest'
  return { registry, apiHost, repository, tag, digest }
}

/** Canonical "repo:tag" as Docker prints it (docker.io/library prefix dropped). */
export function canonicalRepoTag(ref) {
  const r = parseImageRef(ref)
  let repo = r.registry === 'docker.io' ? r.repository.replace(/^library\//, '') : `${r.registry}/${r.repository}`
  return r.digest && !r.tag ? `${repo}@${r.digest}` : `${repo}:${r.tag}`
}

export function canonicalRepo(ref) {
  const r = parseImageRef(ref)
  return r.registry === 'docker.io' ? r.repository.replace(/^library\//, '') : `${r.registry}/${r.repository}`
}

const tokenCache = new Map()

async function authHeaders(r, challenge) {
  const key = `${r.apiHost}/${r.repository}`
  if (!challenge && tokenCache.has(key)) return { Authorization: `Bearer ${tokenCache.get(key)}` }
  if (!challenge) return {}
  const m = /Bearer\s+(.*)/i.exec(challenge)
  if (!m) return {}
  const params = Object.fromEntries(
    [...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v])
  )
  const url = new URL(params.realm)
  if (params.service) url.searchParams.set('service', params.service)
  url.searchParams.set('scope', params.scope || `repository:${r.repository}:pull`)
  const res = await fetchWithTimeout(url.toString())
  if (!res.ok) throw new EngineError(502, `Registry auth failed for ${key}: HTTP ${res.status}`)
  const body = await res.json()
  const token = body.token || body.access_token
  tokenCache.set(key, token)
  return { Authorization: `Bearer ${token}` }
}

async function registryGet(r, pathname, accept) {
  const url = `https://${r.apiHost}/v2/${r.repository}/${pathname}`
  let headers = { Accept: accept, ...(await authHeaders(r)) }
  let res = await fetchWithTimeout(url, { headers, timeout: 60000 })
  if (res.status === 401) {
    headers = { Accept: accept, ...(await authHeaders(r, res.headers.get('www-authenticate'))) }
    res = await fetchWithTimeout(url, { headers, timeout: 60000 })
  }
  return { res, headers, url }
}

function ociArch() {
  return process.arch === 'arm64' ? 'arm64' : 'amd64'
}

/** Resolve the image manifest for linux/<arch>. Returns { manifest, digest, config }. */
export async function resolveManifest(ref, { arch = ociArch() } = {}) {
  const r = parseImageRef(ref)
  const reference = r.digest || r.tag
  let { res } = await registryGet(r, `manifests/${reference}`, MANIFEST_TYPES)
  if (res.status === 404) throw new EngineError(404, `manifest for ${ref} not found`)
  if (res.status === 429) {
    throw new EngineError(
      503,
      `The image registry for ${ref} is rate-limiting downloads from this network (HTTP 429). Wait an hour or two and try again.`
    )
  }
  if (!res.ok) throw new EngineError(502, `Registry error fetching manifest for ${ref}: HTTP ${res.status}`)
  let digest = res.headers.get('docker-content-digest')
  let manifest = await res.json()

  if (manifest.manifests) {
    const pick =
      manifest.manifests.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === arch) ||
      manifest.manifests.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64')
    if (!pick) throw new EngineError(404, `No linux/${arch} image for ${ref}`)
    ;({ res } = await registryGet(r, `manifests/${pick.digest}`, MANIFEST_TYPES))
    if (!res.ok) throw new EngineError(502, `Registry error fetching platform manifest for ${ref}: HTTP ${res.status}`)
    manifest = await res.json()
    digest = digest || pick.digest
  }
  const cfgRes = await registryGet(r, `blobs/${manifest.config.digest}`, '*/*')
  const config = cfgRes.res.ok ? await cfgRes.res.json() : null
  return { manifest, digest, config, ref: r }
}

/**
 * Download every layer of `ref` into `cacheDir` and extract the parts selected by `map`
 * (archive path → destination-relative path, or null to skip) into `destDir`.
 */
export async function extractImage(ref, destDir, { cacheDir, map, filter, onProgress, arch } = {}) {
  const { manifest, digest, config, ref: r } = await resolveManifest(ref, { arch })
  await ensureDir(cacheDir)
  const layers = manifest.layers || []
  const total = layers.reduce((s, l) => s + (l.size || 0), 0)
  let doneBytes = 0
  for (const [i, layer] of layers.entries()) {
    const blobFile = path.join(cacheDir, layer.digest.replace(':', '_'))
    let cached = false
    try {
      cached = (await stat(blobFile)).size === layer.size
    } catch {}
    if (!cached) {
      const url = `https://${r.apiHost}/v2/${r.repository}/blobs/${layer.digest}`
      const headers = await authHeaders(r)
      await downloadFile(url, blobFile, {
        headers,
        sha256: layer.digest.startsWith('sha256:') ? layer.digest.slice(7) : undefined,
        onProgress: ({ current }) =>
          onProgress?.({ phase: 'download', layer: i + 1, layers: layers.length, current: doneBytes + current, total }),
      })
    }
    doneBytes += layer.size || 0
    onProgress?.({ phase: 'extract', layer: i + 1, layers: layers.length, current: doneBytes, total })
    await extractTarFile(blobFile, destDir, { map, filter, whiteouts: true })
  }
  return { digest, config, size: total }
}
