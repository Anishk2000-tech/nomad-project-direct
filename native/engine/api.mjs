// Docker Engine API (the subset Project NOMAD uses) served over HTTP on 127.0.0.1, so the admin's
// dockerode client works unchanged against the native engine. Requests must carry the engine
// token (Authorization: Bearer ...) because this API can start processes as the service account.
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { EngineError, isWin, removeWithRetry } from './lib/util.mjs'
import { ensureSelfSignedCert } from './lib/selfsigned.mjs'
import { findRecipe, supportInfo } from './recipes/index.mjs'
import { normalizeRef } from './images.mjs'

const execFileAsync = promisify(execFile)
export const ENGINE_VERSION = '1.0.0'
const API_VERSION = '1.43'

let osNameCache = null
async function osPrettyName() {
  if (osNameCache) return osNameCache
  if (isWin) {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).Caption'],
        { windowsHide: true, timeout: 15000 }
      )
      osNameCache = stdout.trim() || `Windows ${os.release()}`
    } catch {
      osNameCache = `Windows ${os.release()}`
    }
  } else {
    try {
      const text = await readFile('/etc/os-release', 'utf8')
      osNameCache = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text)?.[1] || 'Linux'
    } catch {
      osNameCache = 'Linux'
    }
  }
  return osNameCache
}

let nvidiaCache = { at: 0, value: false }
async function hasNvidia() {
  if (Date.now() - nvidiaCache.at < 10 * 60 * 1000) return nvidiaCache.value
  const value = await execFileAsync('nvidia-smi', ['-L'], { windowsHide: true, timeout: 10000 })
    .then(({ stdout }) => /GPU \d+:/.test(stdout))
    .catch(() => false)
  nvidiaCache = { at: Date.now(), value }
  return value
}

function bool(v) {
  return v === '1' || v === 'true' || v === 'True' || v === true
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new EngineError(400, 'invalid JSON body')
  }
}

function send(res, status, body) {
  if (res.headersSent) return res.end()
  if (body === undefined || status === 204 || status === 304) {
    res.writeHead(status, { 'Api-Version': API_VERSION }).end()
    return
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Api-Version': API_VERSION,
  })
  res.end(text)
}

function tokenOk(req, token) {
  if (!token) return true
  const header = req.headers.authorization || ''
  const given = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-nomad-engine-token'] || ''
  const a = Buffer.from(String(given))
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createApiServer(engine) {
  const { images, containers, token, logger, home } = engine
  const log = logger.child('api')
  const volumesDir = path.join(home, 'volumes')

  async function info() {
    const all = containers.list({ all: true })
    const running = all.filter((c) => c.State === 'running').length
    const nvidia = await hasNvidia()
    return {
      ID: 'nomad-native',
      Containers: all.length,
      ContainersRunning: running,
      ContainersPaused: 0,
      ContainersStopped: all.length - running,
      Images: images.list().length,
      Driver: 'nomad-native',
      DriverStatus: [],
      Name: os.hostname(),
      OperatingSystem: await osPrettyName(),
      OSType: isWin ? 'windows' : 'linux',
      OSVersion: os.version?.() || os.release(),
      KernelVersion: os.release(),
      Architecture: process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch,
      NCPU: os.cpus().length,
      MemTotal: os.totalmem(),
      ServerVersion: `nomad-native-${ENGINE_VERSION}`,
      DockerRootDir: home,
      DefaultRuntime: 'native',
      // NOMAD checks for an "nvidia" runtime to decide whether a GPU is usable. Natively the GPU
      // is available whenever the NVIDIA driver is installed, so report it the same way.
      Runtimes: { native: { path: 'nomad-engine' }, ...(nvidia ? { nvidia: { path: 'nvidia-smi' } } : {}) },
      NomadNative: { engineVersion: ENGINE_VERSION, storageRoot: engine.storageRoot },
    }
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://engine')
    const q = Object.fromEntries(url.searchParams)
    let p = url.pathname.replace(/^\/v1\.\d+/, '')
    const m = req.method
    let match

    if (p === '/_ping') return send(res, 200, 'OK')
    if (p === '/version' && m === 'GET') {
      return send(res, 200, {
        Version: `nomad-native-${ENGINE_VERSION}`,
        ApiVersion: API_VERSION,
        MinAPIVersion: '1.24',
        Os: isWin ? 'windows' : 'linux',
        Arch: process.arch === 'x64' ? 'amd64' : process.arch,
        KernelVersion: os.release(),
        Components: [{ Name: 'Engine', Version: `nomad-native-${ENGINE_VERSION}` }],
      })
    }
    if (p === '/info' && m === 'GET') return send(res, 200, await info())

    // ── containers ──
    if (p === '/containers/json' && m === 'GET') return send(res, 200, containers.list({ all: bool(q.all) }))
    if (p === '/containers/create' && m === 'POST') {
      const body = await readBody(req)
      return send(res, 201, await containers.create(q.name, body))
    }
    if ((match = /^\/containers\/([^/]+)\/(\w+)$/.exec(p))) {
      const [, id, action] = match
      if (action === 'json' && m === 'GET') return send(res, 200, containers.inspect(id))
      if (action === 'start' && m === 'POST') {
        const r = await containers.start(id)
        return send(res, r.notModified ? 304 : 204)
      }
      if (action === 'stop' && m === 'POST') {
        const r = await containers.stop(id)
        return send(res, r.notModified ? 304 : 204)
      }
      if (action === 'restart' && m === 'POST') {
        await containers.restart(id)
        return send(res, 204)
      }
      if (action === 'kill' && m === 'POST') {
        await containers.stop(id, { markStopped: false })
        return send(res, 204)
      }
      if (action === 'rename' && m === 'POST') {
        if (!q.name) throw new EngineError(400, 'name is required')
        await containers.rename(id, q.name)
        return send(res, 204)
      }
      if (action === 'update' && m === 'POST') return send(res, 200, await containers.update(id, await readBody(req)))
      if (action === 'wait' && m === 'POST') {
        const c = containers.get(id)
        return send(res, 200, await containers.wait(c.Id))
      }
      if (action === 'logs' && m === 'GET') {
        const opts = {
          stdout: bool(q.stdout),
          stderr: bool(q.stderr),
          since: Number(q.since || 0),
          until: Number(q.until || 0),
          tail: q.tail ?? 'all',
          timestamps: bool(q.timestamps),
        }
        const c = containers.get(id)
        const buf = await containers.logs(c.Id, opts)
        if (bool(q.follow)) {
          res.writeHead(200, { 'Content-Type': c.Config.Tty ? 'application/vnd.docker.raw-stream' : 'application/vnd.docker.multiplexed-stream' })
          res.write(buf)
          return containers.follow(c.Id, res, opts)
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length })
        return res.end(buf)
      }
      if (action === 'stats' && m === 'GET') {
        if (q.stream === undefined || bool(q.stream)) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          let open = true
          res.on('close', () => (open = false))
          while (open) {
            res.write(JSON.stringify(await containers.stats(id)) + '\n')
            await new Promise((r) => setTimeout(r, 1000))
          }
          return
        }
        return send(res, 200, await containers.stats(id))
      }
      if (action === 'attach' && m === 'POST') {
        const c = containers.get(id)
        res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' })
        return containers.follow(c.Id, res, { stdout: bool(q.stdout ?? '1'), stderr: bool(q.stderr ?? '1') })
      }
      if (action === 'exec' && m === 'POST') return send(res, 201, containers.execCreate(id, await readBody(req)))
    }
    if ((match = /^\/containers\/([^/]+)$/.exec(p)) && m === 'DELETE') {
      await containers.remove(match[1], { force: bool(q.force) })
      return send(res, 204)
    }

    // ── exec ──
    if ((match = /^\/exec\/([^/]+)\/start$/.exec(p)) && m === 'POST') {
      await readBody(req)
      return containers.execStart(match[1], res)
    }
    if ((match = /^\/exec\/([^/]+)\/json$/.exec(p)) && m === 'GET') return send(res, 200, containers.execInspect(match[1]))

    // ── images ──
    if (p === '/images/create' && m === 'POST') {
      // dockerode's followProgress() ignores {"error": ...} lines, so a failure reported inside a
      // 200 stream looks like success to NOMAD. By default we therefore hold the response until
      // the pull finishes and answer with a real HTTP error carrying the reason. Pass
      // ?nomadStream=1 to get live Docker-style progress lines instead.
      if (bool(q.nomadStream)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        const write = (obj) => {
          if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n')
        }
        try {
          await images.pull(q.fromImage, q.tag, write)
        } catch (err) {
          log.warn(`Pull of ${q.fromImage}:${q.tag} failed: ${err.message}`)
          write({ errorDetail: { message: err.message }, error: err.message })
        }
        return res.end()
      }
      const lines = []
      try {
        await images.pull(q.fromImage, q.tag, (obj) => lines.push(JSON.stringify(obj)))
      } catch (err) {
        log.warn(`Pull of ${q.fromImage}:${q.tag} failed: ${err.message}`)
        return send(res, 500, { message: err.message })
      }
      const body = lines.join('\n') + '\n'
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      return res.end(body)
    }
    if (p === '/images/json' && m === 'GET') return send(res, 200, images.list().map((i) => images.summary(i)))
    if (p === '/images/prune' && m === 'POST') {
      const removed = await images.prune((img) => containers.imageInUse(img))
      return send(res, 200, { ImagesDeleted: removed.map((id) => ({ Deleted: id })), SpaceReclaimed: 0 })
    }
    if ((match = /^\/images\/(.+)\/json$/.exec(p)) && m === 'GET') {
      return send(res, 200, images.inspect(images.get(decodeURIComponent(match[1]))))
    }
    if ((match = /^\/images\/(.+)$/.exec(p)) && m === 'DELETE') {
      const name = decodeURIComponent(match[1])
      return send(res, 200, await images.remove(name, { inUse: (img) => containers.imageInUse(img), force: bool(q.force) }))
    }

    // ── volumes (named volumes are plain folders; NOMAD's catalog only uses bind mounts) ──
    if (p === '/volumes' && m === 'GET') {
      const names = await readdir(volumesDir).catch(() => [])
      return send(res, 200, {
        Volumes: names.map((n) => ({ Name: n, Driver: 'local', Mountpoint: path.join(volumesDir, n), Labels: {}, Scope: 'local' })),
        Warnings: null,
      })
    }
    if ((match = /^\/volumes\/([^/]+)$/.exec(p)) && m === 'DELETE') {
      const dir = path.join(volumesDir, match[1].replace(/[^\w.-]/g, '_'))
      const exists = (await readdir(volumesDir).catch(() => [])).includes(path.basename(dir))
      if (!exists) throw new EngineError(404, `no such volume: ${match[1]}`)
      await removeWithRetry(dir)
      return send(res, 204)
    }
    if (p === '/networks' && m === 'GET') return send(res, 200, [{ Name: 'nomad-native', Id: 'nomad-native', Driver: 'native', Scope: 'local' }])

    // ── NOMAD extensions ──
    if (p === '/nomad/status' && m === 'GET') {
      return send(res, 200, {
        engineVersion: ENGINE_VERSION,
        storageRoot: engine.storageRoot,
        containers: containers.list({ all: true }).map((c) => ({ name: c.Names[0].slice(1), state: c.State, status: c.Status, image: c.Image })),
        images: images.list().map((i) => ({ tags: i.RepoTags, recipe: i.Recipe, version: i.Version, size: i.Size })),
        pullsInProgress: [...images.pulls.keys()],
      })
    }
    if (p === '/nomad/support' && m === 'GET') return send(res, 200, supportInfo())
    if (p === '/nomad/support/check' && m === 'POST') {
      const body = await readBody(req)
      const results = {}
      for (const image of Array.isArray(body.images) ? body.images : []) {
        try {
          findRecipe(normalizeRef(String(image)).repo)
          results[image] = { supported: true }
        } catch (err) {
          results[image] = { supported: false, reason: err.message }
        }
      }
      return send(res, 200, { results })
    }
    if (p === '/nomad/selfsigned' && m === 'POST') {
      const body = await readBody(req)
      const dir = path.resolve(String(body.dir || ''))
      const root = path.resolve(engine.storageRoot || home)
      const norm = (s) => (isWin ? s.toLowerCase() : s)
      if (!norm(dir).startsWith(norm(root) + path.sep)) throw new EngineError(400, 'certificate folder must be inside the NOMAD storage folder')
      return send(res, 200, await ensureSelfSignedCert(dir, body.commonName || 'Project NOMAD'))
    }
    if (p === '/nomad/shutdown' && m === 'POST') {
      send(res, 202, { message: 'Shutting down' })
      setImmediate(() => engine.onShutdownRequest?.())
      return
    }

    throw new EngineError(404, `page not found: ${m} ${p}`)
  }

  const server = http.createServer(async (req, res) => {
    if (!tokenOk(req, token)) {
      send(res, 401, { message: 'unauthorized: missing or invalid engine token' })
      return
    }
    try {
      await route(req, res)
    } catch (err) {
      const status = err instanceof EngineError ? err.status : 500
      // EngineErrors are expected, user-facing conditions (port in use, unsupported app...);
      // anything else is a bug worth a stack trace.
      if (!(err instanceof EngineError)) log.error(`${req.method} ${req.url}: ${err.stack || err.message}`)
      else if (status >= 500) log.warn(`${req.method} ${req.url}: ${err.message}`)
      else log.debug(`${req.method} ${req.url}: ${status} ${err.message}`)
      if (!res.headersSent) send(res, status, { message: err.message })
      else res.end()
    }
  })
  server.keepAliveTimeout = 5000
  // Long pulls (multi-GB) and waits must not be cut off by Node's default request timeout.
  server.requestTimeout = 0
  server.headersTimeout = 60000
  return server
}
