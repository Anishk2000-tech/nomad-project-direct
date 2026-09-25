// Supervisor configuration: resolves the install and data folders, and creates/loads
// <data>/config/nomad.json (ports, generated secrets) on first run.
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { ensureDir, isWin, readJson, writeJsonAtomic } from '../engine/lib/util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function secret(bytes = 24) {
  // URL/ini/shell-safe alphabet.
  return randomBytes(bytes).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, bytes)
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1)
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i]
    else out[a.slice(2)] = true
  }
  return out
}

/**
 * Folder layout. The install folder holds read-only program files; the data folder (the
 * "NOMAD home", chosen in the installer) holds everything that changes.
 *   <install>/runtime/{node,mariadb,redis,pmtiles}   bundled third-party runtimes
 *   <install>/app                                     built admin app (+ node_modules)
 *   <install>/native/{engine,launcher}                this code
 *   <home>/{config,storage,mysql,redis,engine,logs,update,run}
 */
export function resolvePaths(args = parseArgs()) {
  const installDir = path.resolve(args['install-dir'] || process.env.NOMAD_INSTALL_DIR || path.join(HERE, '..', '..'))
  // The installer records the data folder the user chose in <install>/data-location.txt.
  let recorded = null
  try {
    recorded = readFileSync(path.join(installDir, 'data-location.txt'), 'utf8').replace(/^\uFEFF/, '').trim() || null
  } catch {}
  const home = path.resolve(
    args.home || process.env.NOMAD_HOME || recorded || (isWin ? 'C:\\ProjectNOMAD' : path.join(installDir, 'nomad-home'))
  )
  const appDir = path.resolve(args['app-dir'] || process.env.NOMAD_APP_DIR || path.join(installDir, 'app'))
  return {
    installDir,
    home,
    appDir,
    runtimeDir: path.join(installDir, 'runtime'),
    configDir: path.join(home, 'config'),
    configFile: path.join(home, 'config', 'nomad.json'),
    storageDir: path.join(home, 'storage'),
    mysqlDir: path.join(home, 'mysql'),
    redisDir: path.join(home, 'redis'),
    engineDir: path.join(home, 'engine'),
    logsDir: path.join(home, 'logs'),
    updateDir: path.join(home, 'update'),
    runDir: path.join(home, 'run'),
  }
}

function buildInfo(installDir) {
  const file = path.join(installDir, 'build-info.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

const DEFAULTS = {
  http: { port: 8080, host: '0.0.0.0' },
  database: { port: 3316, name: 'nomad', user: 'nomad' },
  redis: { port: 6389 },
  engine: { port: 2385 },
  logsUi: { port: 9999 },
  logLevel: 'info',
}

export async function loadConfig(paths) {
  await ensureDir(paths.configDir)
  const existing = (await readJson(paths.configFile)) || {}
  const info = buildInfo(paths.installDir)
  const cfg = {
    version: 1,
    ...DEFAULTS,
    ...existing,
    http: { ...DEFAULTS.http, ...(existing.http || {}) },
    database: { ...DEFAULTS.database, ...(existing.database || {}) },
    redis: { ...DEFAULTS.redis, ...(existing.redis || {}) },
    engine: { ...DEFAULTS.engine, ...(existing.engine || {}) },
    logsUi: { ...DEFAULTS.logsUi, ...(existing.logsUi || {}) },
  }
  // Secrets are generated once, on first run, and kept for the life of the install.
  if (!cfg.appKey) cfg.appKey = secret(32)
  if (!cfg.database.password) cfg.database.password = secret(24)
  if (!cfg.database.rootPassword) cfg.database.rootPassword = secret(24)
  if (!cfg.engine.token) cfg.engine.token = secret(40)
  if (!cfg.releasesRepo) cfg.releasesRepo = info.releasesRepo || 'Crosstalk-Solutions/project-nomad'
  if (!cfg.url) cfg.url = `http://localhost:${cfg.http.port}`
  if (JSON.stringify(existing) !== JSON.stringify(cfg)) await writeJsonAtomic(paths.configFile, cfg)
  cfg.appVersion = info.version || null
  return cfg
}

/** Locate a bundled runtime executable, falling back to PATH (development on Linux). */
export function findRuntimeExe(paths, relCandidates, pathName) {
  for (const rel of relCandidates) {
    const p = path.join(paths.runtimeDir, ...rel.split('/'))
    if (existsSync(p)) return p
  }
  return pathName
}

/** Forward-slash path (safe inside ini files, env values and URLs on Windows). */
export function slash(p) {
  return p.replace(/\\/g, '/')
}
