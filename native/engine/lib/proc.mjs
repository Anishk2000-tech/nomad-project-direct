// Process helpers: tree kill, port probing, and CPU/memory sampling on Windows and Linux.
import { spawn, execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import { promisify } from 'node:util'
import { isWin, sleep } from './util.mjs'

const execFileAsync = promisify(execFile)

export function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * Terminate a process and all of its descendants. On Windows `taskkill /T` walks the tree
 * (Ollama, for example, spawns runner subprocesses that would otherwise hold the GPU and port).
 * On POSIX, children are started in their own process group, so signalling -pid reaches them.
 */
export async function killTree(pid, { graceMs = 8000 } = {}) {
  if (!pid || !pidAlive(pid)) return
  if (isWin) {
    // Without /F taskkill only posts WM_CLOSE, which console apps ignore, so a graceful attempt
    // buys nothing; go straight to a forced tree kill.
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
    for (let i = 0; i < 50 && pidAlive(pid); i++) await sleep(100)
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && pidAlive(pid)) await sleep(100)
  if (pidAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
}

function tryListen(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', (err) => resolve(err.code !== 'EADDRINUSE' && err.code !== 'EACCES'))
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)))
  })
}

function tryConnect(port, host) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    const done = (v) => {
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(500, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** True when nothing is listening on `port` (checked for all-interfaces and loopback). */
export async function isPortFree(port) {
  if (await tryConnect(port, '127.0.0.1')) return false
  if (!(await tryListen(port, '0.0.0.0'))) return false
  if (!(await tryListen(port, '127.0.0.1'))) return false
  return true
}

export async function waitForPort(port, { host = '127.0.0.1', timeoutMs = 60000, isAlive } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await tryConnect(port, host)) return true
    if (isAlive && !isAlive()) return false
    await sleep(300)
  }
  return false
}

// ── Resource sampling ──────────────────────────────────────────────────────────

async function linuxTreePids(rootPid) {
  const out = await execFileAsync('ps', ['-e', '-o', 'pid=,ppid=']).catch(() => ({ stdout: '' }))
  const children = new Map()
  for (const line of out.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!pid) continue
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const all = []
  const stack = [rootPid]
  while (stack.length) {
    const p = stack.pop()
    all.push(p)
    stack.push(...(children.get(p) || []))
  }
  return all
}

async function linuxSample(rootPid) {
  const pids = await linuxTreePids(rootPid)
  const ticksPerSec = 100
  const pageSize = 4096
  let cpuTicks = 0
  let rss = 0
  for (const pid of pids) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      cpuTicks += Number(fields[11]) + Number(fields[12])
      rss += Number(fields[21]) * pageSize
    } catch {}
  }
  return { cpuNs: (cpuTicks / ticksPerSec) * 1e9, memBytes: rss }
}

const WIN_SAMPLE_PS = `
param([int[]]$Roots)
function Snap {
  $procs = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize
  $kids = @{}
  foreach ($p in $procs) { if (-not $kids.ContainsKey([int]$p.ParentProcessId)) { $kids[[int]$p.ParentProcessId] = @() }; $kids[[int]$p.ParentProcessId] += $p }
  $byId = @{}; foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }
  $res = @{}
  foreach ($r in $Roots) {
    $cpu = [double]0; $mem = [double]0; $stack = New-Object System.Collections.Stack
    if ($byId.ContainsKey($r)) { $stack.Push($byId[$r]) }
    while ($stack.Count -gt 0) {
      $p = $stack.Pop(); $cpu += [double]$p.KernelModeTime + [double]$p.UserModeTime; $mem += [double]$p.WorkingSetSize
      if ($kids.ContainsKey([int]$p.ProcessId)) { foreach ($c in $kids[[int]$p.ProcessId]) { if ($c.ProcessId -ne $p.ProcessId) { $stack.Push($c) } } }
    }
    $res["$r"] = @{ cpu = $cpu; mem = $mem }
  }
  return $res
}
$a = Snap; Start-Sleep -Milliseconds 1000; $b = Snap
@{ a = $a; b = $b } | ConvertTo-Json -Depth 4 -Compress
`

/**
 * Sample CPU and memory for each root PID's process tree over ~1 second.
 * Returns Map<pid, { cpuNsDelta, cpuTotalNs, memBytes, systemNsDelta }>.
 */
export async function sampleProcessTrees(pids) {
  const result = new Map()
  const live = pids.filter(pidAlive)
  if (!live.length) return result
  const ncpu = os.cpus().length || 1

  if (isWin) {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& {${WIN_SAMPLE_PS}} -Roots ${live.join(',')}`],
        { windowsHide: true, timeout: 20000 }
      )
      const data = JSON.parse(stdout)
      for (const pid of live) {
        const a = data.a?.[String(pid)]
        const b = data.b?.[String(pid)]
        if (!a || !b) continue
        // Win32_Process CPU times are in 100ns units.
        result.set(pid, {
          cpuNsDelta: (b.cpu - a.cpu) * 100,
          cpuTotalNs: b.cpu * 100,
          memBytes: b.mem,
          systemNsDelta: 1e9 * ncpu,
        })
      }
    } catch {
      // PowerShell/WMI unavailable: report nothing rather than fail the request.
    }
    return result
  }

  const before = new Map()
  for (const pid of live) before.set(pid, await linuxSample(pid))
  await sleep(1000)
  for (const pid of live) {
    const a = before.get(pid)
    const b = await linuxSample(pid)
    result.set(pid, {
      cpuNsDelta: b.cpuNs - a.cpuNs,
      cpuTotalNs: b.cpuNs,
      memBytes: b.memBytes,
      systemNsDelta: 1e9 * ncpu,
    })
  }
  return result
}

/** Command line of a live process ('' when unknown). Used to confirm a stale PID is still ours. */
export async function processCommandLine(pid) {
  if (!pidAlive(pid)) return ''
  if (isWin) {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
        { windowsHide: true, timeout: 15000 }
      )
      return stdout.trim()
    } catch {
      return ''
    }
  }
  try {
    return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').join(' ').trim()
  } catch {
    return ''
  }
}

/**
 * True when the live process `pid` was started with `command` and `args` (as recorded when we
 * launched it). Guards orphan reaping against PID reuse after a reboot.
 */
export async function isSameProcess(pid, command, args = []) {
  const cmdline = (await processCommandLine(pid)).toLowerCase().replace(/\\/g, '/')
  if (!cmdline || !command) return false
  const norm = (s) => String(s).toLowerCase().replace(/\\/g, '/')
  const base = norm(command).split('/').pop()
  if (!cmdline.includes(base)) return false
  return args.slice(0, 3).every((a) => cmdline.includes(norm(a)))
}

/** Spawn a long-running child in a way that lets killTree() reach its whole tree. */
export function spawnManaged(command, args, { cwd, env, onStdout, onStderr }) {
  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d) => onStdout?.(d))
  child.stderr?.on('data', (d) => onStderr?.(d))
  return child
}
