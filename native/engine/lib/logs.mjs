// Per-container log files in JSON-lines form ({t, s, m}) so the Docker logs API can be served
// faithfully: stdout/stderr separation, since/until windows, tail, timestamps. Files rotate at
// 10 MB (one previous generation kept).
import { appendFile, readFile, rename, stat, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const MAX_BYTES = 10 * 1024 * 1024

export class LogWriter {
  constructor(file) {
    this.file = file
    this.partial = { 1: '', 2: '' }
    this.queue = []
    this.flushing = null
    this.listeners = new Set()
  }

  /** Feed raw bytes from stream 1 (stdout) or 2 (stderr). */
  write(stream, data) {
    const text = this.partial[stream] + data.toString('utf8')
    const lines = text.split(/\r?\n/)
    this.partial[stream] = lines.pop()
    // Guard against a process that never emits newlines.
    if (this.partial[stream].length > 16384) {
      lines.push(this.partial[stream])
      this.partial[stream] = ''
    }
    for (const line of lines) this._push(stream, line)
  }

  /** Record an engine-generated line (e.g. "restarting after crash") on stderr. */
  note(message) {
    this._push(2, message)
  }

  _push(stream, message) {
    const rec = { t: new Date().toISOString(), s: stream, m: message }
    this.queue.push(JSON.stringify(rec))
    for (const fn of this.listeners) {
      try {
        fn(rec)
      } catch {}
    }
    this._schedule()
  }

  flushPartial() {
    for (const s of [1, 2]) {
      if (this.partial[s]) {
        this._push(s, this.partial[s])
        this.partial[s] = ''
      }
    }
  }

  _schedule() {
    if (this.flushing) return
    this.flushing = (async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, this.queue.length).join('\n') + '\n'
        try {
          await appendFile(this.file, batch)
          const { size } = await stat(this.file)
          if (size > MAX_BYTES) await rename(this.file, `${this.file}.1`)
        } catch {
          // Logging must never take the engine down.
        }
      }
      this.flushing = null
    })()
  }

  async drain() {
    while (this.flushing) await this.flushing
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

async function readRecords(file) {
  const out = []
  for (const f of [`${file}.1`, file]) {
    if (!existsSync(f)) continue
    const text = await readFile(f, 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch {}
    }
  }
  return out
}

/** Docker's 8-byte multiplex header: [stream, 0, 0, 0, size(uint32 BE)]. */
export function muxFrame(stream, payload) {
  const body = Buffer.from(payload, 'utf8')
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

export function formatRecord(rec, { tty, timestamps }) {
  const text = `${timestamps ? rec.t + ' ' : ''}${rec.m}\n`
  return tty ? Buffer.from(text, 'utf8') : muxFrame(rec.s, text)
}

/**
 * Query logs like GET /containers/{id}/logs. `since`/`until` are unix seconds (0 = unbounded),
 * `tail` is a line count or 'all'.
 */
export async function queryLogs(file, { stdout = true, stderr = true, since = 0, until = 0, tail = 'all', timestamps = false, tty = false } = {}) {
  let recs = await readRecords(file)
  recs = recs.filter((r) => (r.s === 1 ? stdout : stderr))
  if (since > 0) recs = recs.filter((r) => Date.parse(r.t) / 1000 >= since)
  if (until > 0) recs = recs.filter((r) => Date.parse(r.t) / 1000 <= until)
  const n = tail === 'all' || tail === undefined || tail === null ? NaN : Number(tail)
  if (Number.isFinite(n) && n >= 0) recs = recs.slice(Math.max(0, recs.length - n))
  return Buffer.concat(recs.map((r) => formatRecord(r, { tty, timestamps })))
}

export async function removeLogs(file) {
  await rm(file, { force: true })
  await rm(`${file}.1`, { force: true })
}
