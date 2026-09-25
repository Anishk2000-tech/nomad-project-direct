#!/usr/bin/env node
// Project NOMAD native supervisor — the program the "Project NOMAD" Windows service runs.
//
// Starts, in order: MariaDB → Redis → the native engine (runs the apps) → database migrations and
// seeding → background job workers → the admin web server; keeps them running (restarting
// crashed processes) and shuts everything down cleanly on service stop.
//
//   node supervisor.mjs --install-dir <dir> --home <data dir>
import path from 'node:path'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { lstat, readlink, rm, symlink, rename, writeFile } from 'node:fs/promises'
import { startEngine } from '../engine/index.mjs'
import { ensureDir, isWin, Logger, sleep } from '../engine/lib/util.mjs'
import { isPortFree } from '../engine/lib/proc.mjs'
import { loadConfig, parseArgs, resolvePaths, findRuntimeExe, slash } from './config.mjs'
import { ManagedProcess, RotatingLog, runToCompletion } from './process.mjs'
import { startMariaDb } from './mariadb.mjs'
import { startRedis } from './redis.mjs'
import { startDiskInfoCollector } from './diskinfo.mjs'
import { startUpdater } from './updater.mjs'

const args = parseArgs()
const paths = resolvePaths(args)
const consoleMode = !!args.console || process.stdout.isTTY

for (const d of [paths.home, paths.configDir, paths.storageDir, paths.logsDir, paths.updateDir, paths.runDir, paths.engineDir]) {
  await ensureDir(d)
}

const supLog = new RotatingLog(path.join(paths.logsDir, 'supervisor.log'), { echo: consoleMode ? (l) => console.log(l) : null })
const childLog = (name) => new RotatingLog(path.join(paths.logsDir, `${name}.log`), { echo: consoleMode && args.verbose ? (l) => console.log(`[${name}] ${l}`) : null })
// The engine logs into the supervisor log (echoed to the console when run interactively).
const engineLogger = new Logger('engine', args['log-level'] || 'info', (line) => {
  supLog.raw(line)
  if (consoleMode) console.log(line)
})

const cfg = await loadConfig(paths)
const requireApp = createRequire(path.join(paths.appDir, 'package.json'))
supLog.line(`[supervisor] Project NOMAD ${cfg.appVersion ?? ''} starting (install: ${paths.installDir}, data: ${paths.home})`)

let shuttingDown = false
const state = { mariadb: null, redis: null, engine: null, worker: null, server: null, disk: null, updater: null }

/**
 * <app>/storage must point at <home>/storage: the admin resolves all content (ZIMs, maps, uploads,
 * models) relative to its working directory. A directory junction needs no special rights.
 */
async function ensureStorageLink() {
  const link = path.join(paths.appDir, 'storage')
  try {
    const st = await lstat(link)
    if (st.isSymbolicLink()) {
      const target = await readlink(link)
      if (path.resolve(paths.appDir, target).toLowerCase() === path.resolve(paths.storageDir).toLowerCase()) return
      await rm(link, { force: true })
    } else if (st.isDirectory()) {
      // A real folder (e.g. left by an older build): keep its contents by moving it aside.
      const aside = `${link}.old-${Date.now()}`
      await rename(link, aside)
      supLog.line(`[supervisor] moved unexpected ${link} to ${aside}`)
    }
  } catch {}
  await symlink(paths.storageDir, link, isWin ? 'junction' : 'dir')
  supLog.line(`[supervisor] linked ${link} → ${paths.storageDir}`)
}

function adminEnv() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(cfg.http.port),
    HOST: cfg.http.host,
    URL: cfg.url,
    APP_KEY: cfg.appKey,
    LOG_LEVEL: cfg.logLevel,
    DB_HOST: '127.0.0.1',
    DB_PORT: String(cfg.database.port),
    DB_USER: cfg.database.user,
    DB_PASSWORD: cfg.database.password,
    DB_DATABASE: cfg.database.name,
    DB_SSL: 'false',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: String(cfg.redis.port),
    NOMAD_STORAGE_PATH: slash(paths.storageDir),
    NOMAD_RUNTIME: 'native',
    NOMAD_ENGINE_HOST: '127.0.0.1',
    NOMAD_ENGINE_PORT: String(cfg.engine.port),
    NOMAD_ENGINE_TOKEN: cfg.engine.token,
    NOMAD_UPDATE_SHARED_DIR: paths.updateDir,
    NOMAD_RELEASES_REPO: cfg.releasesRepo,
    PMTILES_BINARY_PATH: findRuntimeExe(paths, ['pmtiles/pmtiles.exe', 'pmtiles/pmtiles'], 'pmtiles'),
  }
  if (isWin) env.NOMAD_ZIM_READER = 'js'
  return env
}

async function startAll() {
  await ensureStorageLink()
  await ensureDir(path.join(paths.storageDir, 'logs'))
  await ensureDir(path.join(paths.storageDir, 'kb_uploads'))

  for (const [name, port] of [
    ['database', cfg.database.port],
    ['redis', cfg.redis.port],
    ['engine', cfg.engine.port],
    ['web', cfg.http.port],
  ]) {
    if (!(await isPortFree(port))) {
      supLog.line(`[supervisor] WARNING: port ${port} (${name}) is already in use — NOMAD may fail to start. Change it in ${paths.configFile}.`)
    }
  }

  state.mariadb = await startMariaDb({ paths, cfg, log: childLog('mariadb'), requireApp })
  state.redis = await startRedis({ paths, cfg, log: childLog('redis') })

  state.engine = await startEngine({
    home: paths.engineDir,
    storageRoot: paths.storageDir,
    port: cfg.engine.port,
    token: cfg.engine.token,
    logger: engineLogger,
    logsUi: {
      port: cfg.logsUi.port,
      systemLogs: [
        { name: 'admin (web server)', file: path.join(paths.logsDir, 'admin.log') },
        { name: 'workers (jobs)', file: path.join(paths.logsDir, 'worker.log') },
        { name: 'supervisor', file: path.join(paths.logsDir, 'supervisor.log') },
        { name: 'database (MariaDB)', file: path.join(paths.logsDir, 'mariadb.log') },
        { name: 'redis', file: path.join(paths.logsDir, 'redis.log') },
        { name: 'migrations', file: path.join(paths.logsDir, 'migrations.log') },
      ],
    },
    onShutdownRequest: () => shutdown('engine API request'),
  })

  const env = adminEnv()
  const node = process.execPath
  const migrationsLog = childLog('migrations')
  for (let attempt = 1; ; attempt++) {
    try {
      await runToCompletion({ name: 'migrations', command: node, args: ['ace', 'migration:run', '--force'], cwd: paths.appDir, env, log: migrationsLog })
      await runToCompletion({ name: 'seed', command: node, args: ['ace', 'db:seed'], cwd: paths.appDir, env, log: migrationsLog })
      break
    } catch (err) {
      supLog.line(`[supervisor] database setup attempt ${attempt} failed: ${err.message}`)
      if (attempt >= 3) throw err
      await sleep(5000)
    }
  }

  state.worker = new ManagedProcess({ name: 'worker', command: node, args: ['ace', 'queue:work', '--all'], cwd: paths.appDir, env, log: childLog('worker') })
  state.worker.start()
  state.server = new ManagedProcess({ name: 'admin', command: node, args: ['bin/server.js'], cwd: paths.appDir, env, log: childLog('admin') })
  state.server.start()

  state.disk = startDiskInfoCollector({ storageDir: paths.storageDir, log: supLog })
  state.updater = startUpdater({ paths, cfg, log: supLog, currentVersion: cfg.appVersion })

  // Report readiness once the web UI answers.
  const deadline = Date.now() + 180000
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.http.port}/api/health`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        supLog.line(`[supervisor] Project NOMAD is ready at ${cfg.url}`)
        await writeFile(path.join(paths.runDir, 'ready'), new Date().toISOString())
        return
      }
    } catch {}
    await sleep(1000)
  }
  supLog.line('[supervisor] WARNING: the web UI did not answer within 3 minutes (see logs/admin.log)')
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  supLog.line(`[supervisor] shutting down (${reason})`)
  await rm(path.join(paths.runDir, 'ready'), { force: true }).catch(() => {})
  state.disk?.stop()
  state.updater?.stop()
  await Promise.all([state.server?.stop({ timeoutMs: 10000 }), state.worker?.stop({ timeoutMs: 10000 })])
  await state.engine?.close().catch((err) => supLog.line(`[supervisor] engine close: ${err.message}`))
  await state.redis?.stop().catch((err) => supLog.line(`[supervisor] redis stop: ${err.message}`))
  await state.mariadb?.stop().catch((err) => supLog.line(`[supervisor] mariadb stop: ${err.message}`))
  supLog.line('[supervisor] stopped')
  await supLog.drain()
  process.exit(exitCode)
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => shutdown(sig))
process.on('uncaughtException', (err) => supLog.line(`[supervisor] uncaught exception: ${err.stack || err.message}`))
process.on('unhandledRejection', (err) => supLog.line(`[supervisor] unhandled rejection: ${err?.stack || err}`))

await writeFile(path.join(paths.runDir, 'supervisor.pid'), String(process.pid))
try {
  await startAll()
} catch (err) {
  supLog.line(`[supervisor] FATAL: ${err.stack || err.message}`)
  // Non-zero exit lets the Windows service manager apply its restart-on-failure policy.
  await shutdown('startup failure', 1)
}
