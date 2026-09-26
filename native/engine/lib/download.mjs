// HTTP helpers built on Node's global fetch (undici). Downloads are resumable: bytes land in
// "<dest>.part" and a retry continues with a Range request when the server supports it, so a
// multi-GB package (e.g. Ollama's CUDA bundle) survives a flaky connection.
import { createWriteStream } from 'node:fs'
import { stat, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ensureDir, renameWithRetry, sleep, EngineError } from './util.mjs'

const USER_AGENT = 'ProjectNOMAD-NativeEngine/1.0 (+https://www.projectnomad.us)'

function withDefaults(headers = {}) {
  return { 'User-Agent': USER_AGENT, ...headers }
}

export function githubHeaders(extra = {}) {
  const h = { Accept: 'application/vnd.github+json', ...extra }
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return h
}

export async function fetchWithTimeout(url, { timeout = 30000, headers, method = 'GET', signal } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error(`Request to ${url} timed out`)), timeout)
  const onAbort = () => ctrl.abort(signal.reason)
  signal?.addEventListener?.('abort', onAbort)
  try {
    return await fetch(url, { method, headers: withDefaults(headers), redirect: 'follow', signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new EngineError(res.status === 404 ? 404 : 502, `GET ${url} failed: HTTP ${res.status} ${body.slice(0, 200)}`)
    err.httpStatus = res.status
    throw err
  }
  return res.json()
}

export async function fetchText(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts)
  if (!res.ok) {
    const err = new EngineError(502, `GET ${url} failed: HTTP ${res.status}`)
    err.httpStatus = res.status
    throw err
  }
  return res.text()
}

/** True if the URL answers a HEAD (or 1-byte ranged GET) with a 2xx after redirects. */
export async function urlExists(url, opts = {}) {
  try {
    let res = await fetchWithTimeout(url, { ...opts, method: 'HEAD', timeout: opts.timeout ?? 15000 })
    if (res.status === 405 || res.status === 403) {
      res = await fetchWithTimeout(url, { ...opts, headers: { ...(opts.headers || {}), Range: 'bytes=0-0' } })
      await res.body?.cancel().catch(() => {})
    }
    return res.ok
  } catch {
    return false
  }
}

/**
 * Download `url` to `dest`. Calls onProgress({ current, total }) at most ~4x/second.
 * Resumes a previous partial download when possible. Verifies sha256 when provided.
 */
export async function downloadFile(url, dest, { onProgress, headers = {}, sha256, retries = 4, signal } = {}) {
  await ensureDir(path.dirname(dest))
  const part = `${dest}.part`
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('Download aborted')
    try {
      let offset = 0
      try {
        offset = (await stat(part)).size
      } catch {}

      const reqHeaders = { ...headers }
      if (offset > 0) reqHeaders.Range = `bytes=${offset}-`
      const res = await fetch(url, {
        headers: withDefaults(reqHeaders),
        redirect: 'follow',
        signal,
      })

      if (res.status === 416) {
        // Range not satisfiable: the part file is already complete (or bogus). Start over.
        await rm(part, { force: true })
        continue
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const err = new EngineError(res.status === 404 ? 404 : 502, `Download failed (${res.status}) for ${url} ${body.slice(0, 200)}`)
        err.httpStatus = res.status
        if (res.status === 404 || res.status === 403 || res.status === 401) throw Object.assign(err, { fatal: true })
        throw err
      }

      const resumed = res.status === 206 && offset > 0
      if (!resumed) offset = 0
      const len = Number(res.headers.get('content-length') || 0)
      const total = len > 0 ? len + offset : 0

      let current = offset
      let lastEmit = 0
      const body = Readable.fromWeb(res.body)
      body.on('data', (chunk) => {
        current += chunk.length
        const now = Date.now()
        if (onProgress && now - lastEmit > 250) {
          lastEmit = now
          onProgress({ current, total })
        }
      })
      await pipeline(body, createWriteStream(part, { flags: resumed ? 'a' : 'w' }))
      onProgress?.({ current, total: total || current })

      if (total && current < total) throw new Error(`Connection closed early (${current}/${total} bytes)`)

      if (sha256) {
        const actual = await hashFile(part)
        if (actual.toLowerCase() !== sha256.toLowerCase()) {
          await rm(part, { force: true })
          throw Object.assign(new EngineError(502, `Checksum mismatch for ${url}: expected ${sha256}, got ${actual}`), {
            fatal: true,
          })
        }
      }
      await renameWithRetry(part, dest)
      return dest
    } catch (err) {
      lastError = err
      if (err.fatal || signal?.aborted) throw err
      await sleep(Math.min(30000, 1000 * 2 ** attempt))
    }
  }
  throw lastError
}

export async function hashFile(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}
