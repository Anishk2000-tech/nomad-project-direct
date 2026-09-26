// Shared helpers for the NOMAD native engine. Dependency-free on purpose: the engine
// runs from the bundled node.exe before (and independently of) the admin app.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export const isWin = process.platform === 'win32'

export function exe(name) {
  return isWin && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

export function randomHex(bytes = 32) {
  return randomBytes(bytes).toString('hex')
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function nowIso() {
  return new Date().toISOString()
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

export async function pathExists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return fallback
    throw err
  }
}

/**
 * Write JSON atomically (tmp file + rename). On Windows a rename onto a file another process
 * has open can fail transiently with EPERM/EBUSY, so retry a few times before giving up.
 */
export async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${randomHex(4)}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2))
  await renameWithRetry(tmp, file)
}

export async function renameWithRetry(from, to, attempts = 10) {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await rm(from, { force: true }).catch(() => {})
        throw err
      }
      await sleep(50 * (i + 1))
    }
  }
}

export async function removeWithRetry(target, attempts = 10) {
  for (let i = 0; ; i++) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (err) {
      if (i >= attempts || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(err.code)) throw err
      await sleep(100 * (i + 1))
    }
  }
}

/** Compare dotted versions ("1.16.3" vs "1.16.10"); non-numeric parts compare as strings. */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/)
  const pb = String(b).replace(/^v/, '').split(/[.-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0'
    const y = pb[i] ?? '0'
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1000)))
  return `${(bytes / Math.pow(1000, i)).toFixed(i === 0 ? 0 : 2)}${units[i]}`
}

/** Human "Up 5 minutes" / "Exited (0) 2 hours ago" strings, as `docker ps` prints them. */
export function humanDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 1) return 'Less than a second'
  if (s < 60) return `${s} seconds`
  const m = Math.floor(s / 60)
  if (m < 60) return m === 1 ? 'About a minute' : `${m} minutes`
  const h = Math.floor(m / 60)
  if (h < 48) return h === 1 ? 'About an hour' : `${h} hours`
  const d = Math.floor(h / 24)
  if (d < 14) return `${d} days`
  return `${Math.floor(d / 7)} weeks`
}

export class Logger {
  /** `sink(line, level)` receives formatted lines; default writes to stdout/stderr. */
  constructor(scope, level = process.env.NOMAD_LOG_LEVEL || 'info', sink = null) {
    this.scope = scope
    this.levels = { debug: 10, info: 20, warn: 30, error: 40 }
    this.threshold = this.levels[level] ?? 20
    this.sink = sink
  }

  child(scope) {
    const l = new Logger(`${this.scope}:${scope}`, 'info', this.sink)
    l.threshold = this.threshold
    return l
  }

  _log(level, args) {
    if (this.levels[level] < this.threshold) return
    const msg = args
      .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
    const line = `${nowIso()} [${level.toUpperCase()}] [${this.scope}] ${msg}`
    if (this.sink) this.sink(line, level)
    else if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
    else process.stdout.write(line + '\n')
  }

  debug(...a) {
    this._log('debug', a)
  }
  info(...a) {
    this._log('info', a)
  }
  warn(...a) {
    this._log('warn', a)
  }
  error(...a) {
    this._log('error', a)
  }
}

/** Error carrying an HTTP status so the API layer can map it to a Docker-style response. */
export class EngineError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
