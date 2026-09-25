// Bundled MariaDB (MySQL-compatible) server: first-run initialisation, startup, database/user
// provisioning, and clean shutdown. Listens on 127.0.0.1 only.
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile, readdir } from 'node:fs/promises'
import { ensureDir, isWin, sleep } from '../engine/lib/util.mjs'
import { waitForPort } from '../engine/lib/proc.mjs'
import { findRuntimeExe, slash } from './config.mjs'
import { ManagedProcess, runToCompletion } from './process.mjs'

/** Unix socket paths are capped at ~107 bytes, so keep it short (Linux only; Windows uses TCP). */
function socketPath(paths) {
  const tag = createHash('sha256').update(paths.home).digest('hex').slice(0, 10)
  return path.join(os.tmpdir(), `nomad-mysqld-${tag}.sock`)
}

function iniFor(paths, cfg) {
  const lines = [
    '[mysqld]',
    `datadir=${slash(paths.mysqlDir)}`,
    `port=${cfg.database.port}`,
    'bind-address=127.0.0.1',
    'character-set-server=utf8mb4',
    'collation-server=utf8mb4_unicode_ci',
    'innodb_buffer_pool_size=256M',
    'max_connections=250',
    'max_allowed_packet=64M',
    'innodb_ft_min_token_size=3',
  ]
  if (!isWin) {
    lines.push(`socket=${socketPath(paths)}`, `pid-file=${slash(path.join(paths.runDir, 'mysqld.pid'))}`)
  }
  lines.push('', '[client]', `port=${cfg.database.port}`)
  return lines.join('\n') + '\n'
}

async function isInitialized(dir) {
  return existsSync(path.join(dir, 'mysql')) && (await readdir(dir).catch(() => [])).length > 0
}

export async function startMariaDb({ paths, cfg, log, requireApp }) {
  const mariadbd = findRuntimeExe(paths, ['mariadb/bin/mariadbd.exe', 'mariadb/bin/mysqld.exe'], 'mariadbd')
  const installDb = findRuntimeExe(
    paths,
    ['mariadb/bin/mariadb-install-db.exe', 'mariadb/bin/mysql_install_db.exe'],
    'mariadb-install-db'
  )
  const ini = path.join(paths.configDir, 'my.ini')
  await ensureDir(paths.runDir)
  await writeFile(ini, iniFor(paths, cfg))
  const runningAsRoot = !isWin && process.getuid?.() === 0

  if (!(await isInitialized(paths.mysqlDir))) {
    log.line('[supervisor] initialising MariaDB data folder (first run)')
    if (isWin) {
      // mariadb-install-db.exe requires the data folder to not exist yet.
      await runToCompletion({
        name: 'mariadb-install-db',
        command: installDb,
        args: [`--datadir=${paths.mysqlDir}`, `--password=${cfg.database.rootPassword}`, `--port=${cfg.database.port}`],
        log,
      })
    } else {
      await ensureDir(paths.mysqlDir)
      await runToCompletion({
        name: 'mariadb-install-db',
        command: installDb,
        args: [
          '--no-defaults',
          `--datadir=${paths.mysqlDir}`,
          '--auth-root-authentication-method=normal',
          '--skip-test-db',
          `--user=${os.userInfo().username}`,
        ],
        log,
      })
    }
  }

  const proc = new ManagedProcess({
    name: 'mariadb',
    command: mariadbd,
    args: [`--defaults-file=${ini}`, ...(isWin ? ['--console'] : []), ...(runningAsRoot ? ['--user=root'] : [])],
    cwd: paths.mysqlDir,
    env: { ...process.env },
    log,
  })
  proc.start()
  const up = await waitForPort(cfg.database.port, { timeoutMs: 180000, isAlive: () => proc.running })
  if (!up) throw new Error('MariaDB did not start (see logs/mariadb.log)')

  const mysql = requireApp('mysql2/promise')
  const rootConn = async (password) =>
    mysql.createConnection(
      isWin
        ? { host: '127.0.0.1', port: cfg.database.port, user: 'root', password }
        : { socketPath: socketPath(paths), user: 'root', password }
    )

  let conn
  for (let attempt = 0; ; attempt++) {
    try {
      conn = await rootConn(cfg.database.rootPassword)
      break
    } catch (err) {
      if (err.code === 'ER_ACCESS_DENIED_ERROR' && !isWin) {
        // Fresh Linux initialisation: root has no password yet.
        conn = await rootConn(undefined)
        await conn.query('ALTER USER ?@? IDENTIFIED BY ?', ['root', 'localhost', cfg.database.rootPassword])
        break
      }
      if (attempt >= 30) throw err
      await sleep(1000)
    }
  }

  const { name, user, password } = cfg.database
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  for (const host of ['localhost', '127.0.0.1']) {
    await conn.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?', [user, host, password])
    await conn.query('ALTER USER ?@? IDENTIFIED BY ?', [user, host, password])
    await conn.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO ?@?`, [user, host])
  }
  await conn.query('FLUSH PRIVILEGES')
  await conn.end()
  log.line('[supervisor] MariaDB ready')

  return {
    proc,
    async stop() {
      await proc.stop({
        timeoutMs: 60000,
        graceful: async () => {
          const c = await rootConn(cfg.database.rootPassword)
          await c.query('SHUTDOWN').catch(() => {})
          await c.end().catch(() => {})
        },
      })
    },
  }
}
