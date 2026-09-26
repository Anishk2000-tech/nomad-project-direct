// Bundled Redis (BullMQ job queues). Loopback-only, append-only persistence, and the
// "noeviction" policy BullMQ requires. The config uses only relative paths so it works with
// every Windows Redis build (native MSVC or MSYS2/Cygwin based).
import path from 'node:path'
import net from 'node:net'
import { writeFile } from 'node:fs/promises'
import { ensureDir } from '../engine/lib/util.mjs'
import { waitForPort } from '../engine/lib/proc.mjs'
import { findRuntimeExe } from './config.mjs'
import { ManagedProcess } from './process.mjs'

function sendCommand(port, parts) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    let data = ''
    sock.setTimeout(10000, () => sock.destroy(new Error('Redis command timed out')))
    sock.on('connect', () => {
      sock.write(`*${parts.length}\r\n` + parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join(''))
    })
    sock.on('data', (d) => {
      data += d.toString()
      const eol = data.indexOf('\r\n')
      if (eol < 0) return
      // Bulk string ($<len>\r\n<payload>\r\n): wait for the whole payload.
      if (data[0] === '$') {
        const len = Number(data.slice(1, eol))
        if (len >= 0 && Buffer.byteLength(data) < eol + 2 + len) return
        sock.end()
        resolve(data.slice(eol + 2).trim())
        return
      }
      sock.end()
      resolve(data.trim())
    })
    sock.on('close', () => resolve(data.trim()))
    sock.on('error', reject)
  })
}

export async function startRedis({ paths, cfg, log }) {
  const exe = findRuntimeExe(paths, ['redis/redis-server.exe'], 'redis-server')
  await ensureDir(paths.redisDir)
  const conf = [
    `port ${cfg.redis.port}`,
    'bind 127.0.0.1',
    'protected-mode yes',
    'dir ./',
    'appendonly yes',
    'appendfsync everysec',
    'save 900 1',
    'save 300 100',
    'maxmemory-policy noeviction',
    'daemonize no',
    'loglevel notice',
  ].join('\n')
  await writeFile(path.join(paths.redisDir, 'redis.conf'), conf + '\n')

  const proc = new ManagedProcess({
    name: 'redis',
    command: exe,
    args: ['redis.conf'],
    cwd: paths.redisDir,
    env: { ...process.env },
    log,
  })
  proc.start()
  const up = await waitForPort(cfg.redis.port, { timeoutMs: 60000, isAlive: () => proc.running })
  if (!up) throw new Error('Redis did not start (see logs/redis.log)')
  const pong = await sendCommand(cfg.redis.port, ['PING'])
  if (!/PONG/.test(pong)) throw new Error(`Unexpected Redis PING reply: ${pong}`)
  const info = await sendCommand(cfg.redis.port, ['INFO', 'server']).catch(() => '')
  log.line(`[supervisor] Redis ready (${/redis_version:([^\r\n]+)/.exec(info)?.[1] ?? 'unknown version'})`)

  return {
    proc,
    async stop() {
      await proc.stop({ timeoutMs: 30000, graceful: () => sendCommand(cfg.redis.port, ['SHUTDOWN', 'SAVE']) })
    },
  }
}
