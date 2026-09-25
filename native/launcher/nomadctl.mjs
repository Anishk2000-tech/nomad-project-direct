#!/usr/bin/env node
// Control utility for a native NOMAD install.
//   nomadctl stop     graceful shutdown (used as the Windows service's stop command)
//   nomadctl status   show component and app status
//   nomadctl wait     wait until the dashboard answers (--timeout seconds, default 300)
//   nomadctl open     open the NOMAD dashboard in the default browser
//   nomadctl logs     open the log viewer
import path from 'node:path'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { pidAlive } from '../engine/lib/proc.mjs'
import { isWin, readJson, sleep } from '../engine/lib/util.mjs'
import { parseArgs, resolvePaths } from './config.mjs'

const args = parseArgs(process.argv.slice(3))
const command = process.argv[2] || 'status'
const paths = resolvePaths(args)
const cfg = (await readJson(paths.configFile)) || {}
const enginePort = cfg.engine?.port ?? 2385
const webUrl = cfg.url || `http://localhost:${cfg.http?.port ?? 8080}`

async function engine(method, p) {
  const res = await fetch(`http://127.0.0.1:${enginePort}${p}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.engine?.token ?? ''}` },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`engine returned HTTP ${res.status}`)
  return res.json()
}

function openUrl(url) {
  const [cmd, argv] = isWin ? ['cmd.exe', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
  spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

async function supervisorPid() {
  try {
    return Number((await readFile(path.join(paths.runDir, 'supervisor.pid'), 'utf8')).trim())
  } catch {
    return null
  }
}

if (command === 'stop') {
  const pid = await supervisorPid()
  try {
    await engine('POST', '/nomad/shutdown')
    console.log('Shutdown requested; waiting for NOMAD to stop...')
  } catch (err) {
    console.log(`Could not reach the NOMAD engine (${err.message}).`)
    if (pid && pidAlive(pid) && !isWin) process.kill(pid, 'SIGTERM')
  }
  const deadline = Date.now() + 110000
  while (pid && pidAlive(pid) && Date.now() < deadline) await sleep(500)
  console.log(pid && pidAlive(pid) ? 'NOMAD is still stopping (timed out waiting).' : 'NOMAD stopped.')
} else if (command === 'status') {
  let web = 'not responding'
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.http?.port ?? 8080}/api/health`, { signal: AbortSignal.timeout(5000) })
    web = res.ok ? 'ok' : `HTTP ${res.status}`
  } catch {}
  console.log(`Dashboard: ${webUrl} (${web})`)
  console.log(`Data folder: ${paths.home}`)
  try {
    const st = await engine('GET', '/nomad/status')
    console.log(`Engine: ${st.engineVersion}`)
    for (const c of st.containers) console.log(`  ${c.name.padEnd(28)} ${c.state.padEnd(10)} ${c.status}`)
    if (!st.containers.length) console.log('  (no apps installed yet)')
  } catch (err) {
    console.log(`Engine: not running (${err.message})`)
  }
} else if (command === 'wait') {
  // Block until the dashboard answers (used by the installer after starting the service).
  const timeoutSec = Number(args.timeout || 300)
  const deadline = Date.now() + timeoutSec * 1000
  let ok = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.http?.port ?? 8080}/api/health`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        ok = true
        break
      }
    } catch {}
    await sleep(2000)
  }
  console.log(ok ? `Project NOMAD is running at ${webUrl}` : `Project NOMAD did not respond within ${timeoutSec}s — see ${path.join(paths.logsDir, 'supervisor.log')}`)
  process.exit(ok ? 0 : 1)
} else if (command === 'open') {
  openUrl(webUrl)
} else if (command === 'logs') {
  openUrl(`http://localhost:${cfg.logsUi?.port ?? 9999}`)
} else {
  console.log('Usage: nomadctl <stop|status|wait|open|logs> [--home <data dir>] [--timeout <seconds>]')
  process.exit(2)
}
