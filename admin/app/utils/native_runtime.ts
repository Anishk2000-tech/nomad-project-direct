/**
 * Runtime selection for the Docker-free "native" edition (e.g. the Windows installer).
 *
 * In the native edition the supervisor starts the NOMAD engine (native/engine), which serves the
 * Docker Engine API on 127.0.0.1 and runs apps as native processes. The admin keeps using
 * dockerode unchanged; only the connection differs. NOMAD_RUNTIME=native selects it, and
 * NOMAD_ENGINE_HOST / NOMAD_ENGINE_PORT / NOMAD_ENGINE_TOKEN locate and authenticate it.
 */
import Docker from 'dockerode'

export function isNativeRuntime(): boolean {
  return process.env.NOMAD_RUNTIME === 'native'
}

function engineBaseUrl(): string {
  const host = process.env.NOMAD_ENGINE_HOST || '127.0.0.1'
  const port = Number(process.env.NOMAD_ENGINE_PORT || 2385)
  return `http://${host}:${port}`
}

function engineHeaders(): Record<string, string> {
  const token = process.env.NOMAD_ENGINE_TOKEN
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** The Docker API client for this runtime: the native engine, Docker Desktop, or the Linux socket. */
export function createDockerClient(): Docker {
  if (isNativeRuntime()) {
    const url = new URL(engineBaseUrl())
    return new Docker({
      host: url.hostname,
      port: Number(url.port),
      protocol: 'http',
      headers: engineHeaders(),
    } as Docker.DockerOptions)
  }
  if (process.platform === 'win32') {
    // Windows Docker Desktop uses a named pipe
    return new Docker({ socketPath: '//./pipe/docker_engine' })
  }
  return new Docker({ socketPath: '/var/run/docker.sock' })
}

/** Call a NOMAD-specific engine endpoint (/nomad/...). Native runtime only. */
export async function engineRequest<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${engineBaseUrl()}${path}`, {
    method,
    headers: { ...engineHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(data?.message || `NOMAD engine returned HTTP ${res.status}`)
  return data as T
}

let supportCache: { at: number; results: Record<string, { supported: boolean; reason?: string }> } | null = null

/**
 * Which images the native engine can run. Catalog apps whose image has no native build are
 * hidden from install lists (they stay visible once installed so they can be managed).
 */
export async function getNativeImageSupport(images: string[]): Promise<Record<string, { supported: boolean; reason?: string }>> {
  const unique = [...new Set(images.filter(Boolean))]
  if (supportCache && Date.now() - supportCache.at < 10 * 60 * 1000 && unique.every((i) => i in supportCache!.results)) {
    return supportCache.results
  }
  const { results } = await engineRequest<{ results: Record<string, { supported: boolean; reason?: string }> }>(
    'POST',
    '/nomad/support/check',
    { images: unique }
  )
  supportCache = { at: Date.now(), results: { ...(supportCache?.results ?? {}), ...results } }
  return supportCache.results
}

/**
 * GitHub repository whose releases carry this edition's updates. The Docker edition follows
 * Crosstalk-Solutions/project-nomad; a native build points NOMAD_RELEASES_REPO at the repository
 * that publishes its installers.
 */
export function releasesRepo(): string {
  return process.env.NOMAD_RELEASES_REPO || 'Crosstalk-Solutions/project-nomad'
}

export function releasesApiUrl(): string {
  return `https://api.github.com/repos/${releasesRepo()}/releases`
}
