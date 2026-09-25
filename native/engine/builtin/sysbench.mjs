#!/usr/bin/env node
// A JavaScript implementation of the sysbench tests NOMAD's benchmark runs (cpu, memory,
// fileio seqrd/seqwr), printing sysbench 1.0-style reports so the admin's parsers work unchanged.
// sysbench has no maintained Windows build; numbers from this port are useful for comparing
// machines running NOMAD natively but are NOT comparable to real sysbench results.
//
// Usage mirrors the sysbench CLI, plus `sh -c "<cmd> && <cmd>"` chains as the admin sends them.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { open, rm, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function parseArgs(argv) {
  const opts = {}
  const pos = []
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    if (m) opts[m[1]] = m[2]
    else if (a.startsWith('--')) opts[a.slice(2)] = 'on'
    else pos.push(a)
  }
  return { opts, pos }
}

function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(String(s).trim())
  if (!m) return Number(s)
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()]
  return Math.round(Number(m[1]) * mult)
}

const fmt = (n, d = 2) => Number(n).toFixed(d)

function header(threads) {
  console.log('sysbench 1.0.20-nomad-js (JavaScript port for Project NOMAD native)')
  console.log('')
  console.log('Running the test with following options:')
  console.log(`Number of threads: ${threads}`)
  console.log('Initializing random number generator from current time')
  console.log('')
}

function latencyReport(lat, totalTime, events, threads) {
  lat.sort((a, b) => a - b)
  const sum = lat.reduce((s, v) => s + v, 0)
  const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : 0
  console.log('General statistics:')
  console.log(`    total time:                          ${fmt(totalTime, 4)}s`)
  console.log(`    total number of events:              ${events}`)
  console.log('')
  console.log('Latency (ms):')
  console.log(`         min:                                    ${fmt(lat[0] ?? 0)}`)
  console.log(`         avg:                                    ${fmt(lat.length ? sum / lat.length : 0)}`)
  console.log(`         max:                                    ${fmt(lat[lat.length - 1] ?? 0)}`)
  console.log(`         95th percentile:                        ${fmt(p95)}`)
  console.log(`         sum:                                    ${fmt(sum)}`)
  console.log('')
  console.log('Threads fairness:')
  console.log(`    events (avg/stddev):           ${fmt(events / threads, 4)}/0.00`)
  console.log(`    execution time (avg/stddev):   ${fmt(totalTime, 4)}/0.00`)
}

// ── Worker bodies ──────────────────────────────────────────────────────────────

function cpuWorker({ maxPrime, deadline }) {
  // Same algorithm as sysbench's cpu test: trial division of every number up to max-prime.
  let events = 0
  const lat = []
  while (Date.now() < deadline) {
    const t0 = performance.now()
    let n = 0
    for (let c = 3; c < maxPrime; c++) {
      const t = Math.sqrt(c)
      let l = 2
      for (; l <= t; l++) if (c % l === 0) break
      if (l > t) n++
    }
    if (n < 0) console.log(n) // keep the loop observable to the JIT
    events++
    if (lat.length < 200000) lat.push(performance.now() - t0)
  }
  return { events, lat }
}

function memoryWorker({ blockSize, totalBytes, deadline }) {
  // Sequential writes of blockSize chunks into a 1 MiB buffer, like sysbench memory (write).
  const buf = new Uint32Array((1024 * 1024) / 4)
  const words = Math.max(1, blockSize / 4)
  let ops = 0
  let bytes = 0
  let pos = 0
  const lat = []
  while (bytes < totalBytes && Date.now() < deadline) {
    const t0 = performance.now()
    for (let i = 0; i < 1024; i++) {
      if (pos + words > buf.length) pos = 0
      buf.fill(ops & 0xffff, pos, pos + words)
      pos += words
      ops++
      bytes += blockSize
    }
    if ((ops & 0xffff) === 0 && lat.length < 100000) lat.push((performance.now() - t0) / 1024)
  }
  return { events: ops, bytes, lat }
}

if (!isMainThread) {
  const { kind, args } = workerData
  const res = kind === 'cpu' ? cpuWorker(args) : memoryWorker(args)
  parentPort.postMessage(res)
}

function runWorkers(kind, threads, argsFor) {
  const url = new URL(import.meta.url)
  return Promise.all(
    Array.from({ length: threads }, (_, i) =>
      new Promise((resolve, reject) => {
        const w = new Worker(url, { workerData: { kind, args: argsFor(i) } })
        w.once('message', resolve)
        w.once('error', reject)
      })
    )
  )
}

async function cpuTest(opts) {
  const threads = Number(opts.threads || 1)
  const time = Number(opts.time || 10)
  const maxPrime = Number(opts['cpu-max-prime'] || 10000)
  header(threads)
  console.log('Prime numbers limit: ' + maxPrime)
  console.log('')
  console.log('Initializing worker threads...')
  console.log('')
  console.log('Threads started!')
  console.log('')
  const t0 = Date.now()
  const results = await runWorkers('cpu', threads, () => ({ maxPrime, deadline: t0 + time * 1000 }))
  const total = (Date.now() - t0) / 1000
  const events = results.reduce((s, r) => s + r.events, 0)
  console.log('CPU speed:')
  console.log(`    events per second: ${fmt(events / total)}`)
  console.log('')
  latencyReport(results.flatMap((r) => r.lat), total, events, threads)
}

async function memoryTest(opts) {
  const threads = Number(opts.threads || 1)
  const blockSize = parseSize(opts['memory-block-size'] || '1K')
  const totalBytes = parseSize(opts['memory-total-size'] || '100G')
  const time = Number(opts.time || 10)
  header(threads)
  console.log('Running memory speed test with the following options:')
  console.log(`  block size: ${blockSize / 1024}KiB`)
  console.log(`  total size: ${Math.round(totalBytes / 1024 / 1024)}MiB`)
  console.log('  operation: write')
  console.log('  scope: global')
  console.log('')
  console.log('Initializing worker threads...')
  console.log('')
  console.log('Threads started!')
  console.log('')
  const t0 = Date.now()
  const results = await runWorkers('memory', threads, () => ({
    blockSize,
    totalBytes: totalBytes / threads,
    deadline: t0 + time * 1000,
  }))
  const total = (Date.now() - t0) / 1000
  const ops = results.reduce((s, r) => s + r.events, 0)
  const bytes = results.reduce((s, r) => s + r.bytes, 0)
  console.log(`Total operations: ${ops} (${fmt(ops / total)} per second)`)
  console.log('')
  console.log(`${fmt(bytes / 1024 / 1024)} MiB transferred (${fmt(bytes / 1024 / 1024 / total)} MiB/sec)`)
  console.log('')
  latencyReport(results.flatMap((r) => r.lat), total, ops, threads)
}

function fileNames(opts) {
  const num = Number(opts['file-num'] || 128)
  return Array.from({ length: num }, (_, i) => path.resolve(`test_file.${i}`))
}

async function filePrepare(opts) {
  const total = parseSize(opts['file-total-size'] || '2G')
  const files = fileNames(opts)
  const per = Math.floor(total / files.length)
  console.log(`${files.length} files, ${Math.round(per / 1024)}Kb each, ${Math.round(total / 1024 / 1024)}Mb total`)
  console.log(`Creating files for the test...`)
  const block = Buffer.alloc(1024 * 1024, 0x5a)
  let written = 0
  for (const f of files) {
    const fh = await open(f, 'w')
    for (let off = 0; off < per; off += block.length) {
      const n = Math.min(block.length, per - off)
      await fh.write(block, 0, n, off)
    }
    await fh.sync()
    await fh.close()
    written += per
  }
  console.log(`${written} bytes written`)
}

async function fileRun(opts) {
  const mode = opts['file-test-mode'] || 'seqrd'
  const time = Number(opts.time || 10)
  const blockSize = parseSize(opts['file-block-size'] || '16K')
  const files = fileNames(opts)
  header(1)
  console.log(`Extra file open flags: ${opts['file-extra-flags'] || '(none)'}`)
  console.log(`${files.length} files, ${Math.round(parseSize(opts['file-total-size'] || '2G') / files.length / 1024 / 1024)}MiB each`)
  console.log(`Block size ${blockSize / 1024}KiB`)
  console.log(`Using synchronous I/O mode`)
  console.log(mode === 'seqwr' ? 'Doing sequential write (creation) test' : 'Doing sequential read test')
  console.log('Initializing worker threads...')
  console.log('')
  console.log('Threads started!')
  console.log('')

  const buf = Buffer.alloc(blockSize, 0xa5)
  const deadline = Date.now() + time * 1000
  const t0 = Date.now()
  let reads = 0
  let writes = 0
  let bytesRead = 0
  let bytesWritten = 0
  let fsyncs = 0
  const lat = []
  outer: while (Date.now() < deadline) {
    for (const f of files) {
      const fh = await open(f, mode === 'seqwr' ? 'r+' : 'r')
      const { size } = await fh.stat()
      for (let off = 0; off < size; off += blockSize) {
        const s = performance.now()
        if (mode === 'seqwr') {
          await fh.write(buf, 0, blockSize, off)
          writes++
          bytesWritten += blockSize
        } else {
          const { bytesRead: n } = await fh.read(buf, 0, blockSize, off)
          reads++
          bytesRead += n
        }
        if (lat.length < 200000) lat.push(performance.now() - s)
        if (Date.now() >= deadline) {
          if (mode === 'seqwr') {
            await fh.sync()
            fsyncs++
          }
          await fh.close()
          break outer
        }
      }
      if (mode === 'seqwr') {
        await fh.sync()
        fsyncs++
      }
      await fh.close()
    }
  }
  const total = (Date.now() - t0) / 1000
  console.log('')
  console.log('File operations:')
  console.log(`    reads/s:                      ${fmt(reads / total)}`)
  console.log(`    writes/s:                     ${fmt(writes / total)}`)
  console.log(`    fsyncs/s:                     ${fmt(fsyncs / total)}`)
  console.log('')
  console.log('Throughput:')
  console.log(`    read, MiB/s:                  ${fmt(bytesRead / 1024 / 1024 / total)}`)
  console.log(`    written, MiB/s:               ${fmt(bytesWritten / 1024 / 1024 / total)}`)
  console.log('')
  latencyReport(lat, total, reads + writes + fsyncs, 1)
}

async function fileCleanup(opts) {
  console.log('Removing test files...')
  for (const f of fileNames(opts)) await rm(f, { force: true })
}

async function runOne(argv) {
  const { opts, pos } = parseArgs(argv)
  if (pos[0] === 'sysbench') pos.shift()
  const [test, command = 'run'] = pos
  if (test === 'cpu' && command === 'run') return cpuTest(opts)
  if (test === 'memory' && command === 'run') return memoryTest(opts)
  if (test === 'fileio') {
    if (command === 'prepare') return filePrepare(opts)
    if (command === 'run') return fileRun(opts)
    if (command === 'cleanup') return fileCleanup(opts)
  }
  throw new Error(`Unsupported sysbench invocation: ${argv.join(' ')}`)
}

function splitShell(cmd) {
  const out = []
  let cur = ''
  let quote = null
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (/\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

async function main() {
  let argv = process.argv.slice(2)
  const workdir = process.env.SYSBENCH_WORKDIR || os.tmpdir()
  await mkdir(workdir, { recursive: true })
  process.chdir(workdir)
  if ((argv[0] === 'sh' || argv[0] === '/bin/sh') && argv[1] === '-c') {
    for (const part of argv.slice(2).join(' ').split('&&')) {
      await runOne(splitShell(part.trim()))
    }
    return
  }
  await runOne(argv)
}

if (isMainThread) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`)
    process.exit(1)
  })
}
