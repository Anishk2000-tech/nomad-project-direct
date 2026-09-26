// Supervised child processes with rotating, timestamped log files.
import { spawn } from 'node:child_process'
import { appendFile, rename, stat } from 'node:fs/promises'
import { killTree, pidAlive } from '../engine/lib/proc.mjs'
import { isWin, sleep } from '../engine/lib/util.mjs'

const MAX_LOG_BYTES = 10 * 1024 * 1024

export class RotatingLog {
  constructor(file, { echo = null } = {}) {
    this.file = file
    this.echo = echo
    this.queue = []
    this.busy = null
    this.partial = ''
  }

  line(text) {
    const stamped = `${new Date().toISOString()} ${text}`
    this.queue.push(stamped)
    this.echo?.(stamped)
    this._flush()
  }

  /** Append an already-timestamped line (e.g. from the engine's logger). */
  raw(text) {
    this.queue.push(text)
    this._flush()
  }

  chunk(data) {
    const lines = (this.partial + data.toString('utf8')).split(/\r?\n/)
    this.partial = lines.pop()
    for (const l of lines) if (l.length) this.line(l)
  }

  _flush() {
    if (this.busy) return
    this.busy = (async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0).join('\n') + '\n'
        try {
          await appendFile(this.file, batch)
          if ((await stat(this.file)).size > MAX_LOG_BYTES) await rename(this.file, `${this.file}.1`)
        } catch {}
      }
      this.busy = null
    })()
  }

  async drain() {
    if (this.partial) {
      this.line(this.partial)
      this.partial = ''
    }
    while (this.busy) await this.busy
  }
}

/**
 * A long-running child with optional restart-on-crash (exponential backoff, reset after a
 * healthy minute). stop() kills the whole process tree.
 */
export class ManagedProcess {
  constructor({ name, command, args = [], cwd, env, log, restart = true, onExit, detachedGroup = !isWin }) {
    Object.assign(this, { name, command, args, cwd, env, log, restart, onExit, detachedGroup })
    this.child = null
    this.stopping = false
    this.backoff = 0
    this.timer = null
    this.startedAt = 0
  }

  get pid() {
    return this.child?.pid ?? null
  }

  get running() {
    return !!this.child && pidAlive(this.child.pid)
  }

  start() {
    this.stopping = false
    this.log.line(`[supervisor] starting ${this.name}: ${this.command} ${this.args.join(' ')}`)
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      detached: this.detachedGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.startedAt = Date.now()
    child.stdout.on('data', (d) => this.log.chunk(d))
    child.stderr.on('data', (d) => this.log.chunk(d))
    child.once('error', (err) => this.log.line(`[supervisor] ${this.name} failed to start: ${err.message}`))
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.log.line(`[supervisor] ${this.name} exited (code ${code ?? '-'}${signal ? `, signal ${signal}` : ''})`)
      this.onExit?.(code, signal)
      if (this.stopping || !this.restart) return
      if (Date.now() - this.startedAt > 60000) this.backoff = 0
      const delay = Math.min(60000, 1000 * 2 ** this.backoff)
      this.backoff = Math.min(this.backoff + 1, 6)
      this.log.line(`[supervisor] restarting ${this.name} in ${Math.round(delay / 1000)}s`)
      this.timer = setTimeout(() => {
        this.timer = null
        if (!this.stopping) this.start()
      }, delay)
    })
    return child
  }

  /** Wait for exit, run `graceful()` first if given, then kill the tree after `timeoutMs`. */
  async stop({ graceful = null, timeoutMs = 20000 } = {}) {
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    const child = this.child
    if (!child) return
    const exited = new Promise((r) => child.once('exit', r))
    if (graceful) {
      try {
        await graceful()
      } catch (err) {
        this.log.line(`[supervisor] graceful stop of ${this.name} failed: ${err.message}`)
      }
      const done = await Promise.race([exited.then(() => true), sleep(timeoutMs).then(() => false)])
      if (done) return
    } else if (!isWin) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {}
      const done = await Promise.race([exited.then(() => true), sleep(Math.min(timeoutMs, 10000)).then(() => false)])
      if (done) return
    }
    await killTree(child.pid)
    await Promise.race([exited, sleep(5000)])
  }
}

/** Run a command to completion, logging its output. Rejects on non-zero exit. */
export function runToCompletion({ name, command, args = [], cwd, env, log, timeoutMs = 30 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    log.line(`[supervisor] running ${name}: ${command} ${args.join(' ')}`)
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const onData = (d) => {
      log.chunk(d)
      tail = (tail + d.toString()).slice(-4000)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      log.line(`[supervisor] ${name} timed out`)
      killTree(child.pid)
    }, timeoutMs)
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(tail)
      else reject(new Error(`${name} exited with code ${code}: ${tail.trim().split('\n').slice(-8).join('\n')}`))
    })
  })
}
