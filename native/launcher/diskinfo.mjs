// Native replacement for the Docker edition's disk-collector sidecar: periodically writes
// <storage>/nomad-disk-info.json in the same shape (lsblk-style block devices + filesystem
// usage) so the admin's Storage panel works unchanged.
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, statfs } from 'node:fs/promises'
import { isWin, writeJsonAtomic } from '../engine/lib/util.mjs'

const execFileAsync = promisify(execFile)

const WIN_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$phys = @{}; foreach ($p in Get-PhysicalDisk) { $phys[[string]$p.DeviceId] = $p }
$disks = foreach ($d in Get-Disk) {
  $p = $phys[[string]$d.Number]
  [pscustomobject]@{ number = $d.Number; model = $d.FriendlyName; serial = $d.SerialNumber; size = $d.Size;
    bus = [string]$d.BusType; media = if ($p) { [string]$p.MediaType } else { '' } }
}
$parts = foreach ($p in Get-Partition) { if ($p.DriveLetter) { [pscustomobject]@{ disk = $p.DiskNumber; letter = [string]$p.DriveLetter; size = $p.Size } } }
@{ disks = @($disks); parts = @($parts) } | ConvertTo-Json -Depth 4 -Compress
`

async function collectWindows() {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], {
    windowsHide: true,
    timeout: 60000,
  })
  const data = JSON.parse(stdout || '{}')
  const disks = [].concat(data.disks || [])
  const parts = [].concat(data.parts || [])
  const blockdevices = disks.map((d) => ({
    name: `disk${d.number}`,
    size: String(d.size ?? 0),
    type: 'disk',
    model: d.model || null,
    serial: d.serial ? String(d.serial).trim() : null,
    vendor: null,
    rota: /hdd/i.test(d.media || ''),
    tran: (d.bus || '').toLowerCase() || null,
    children: parts
      .filter((p) => p.disk === d.number)
      .map((p) => ({ name: `${p.letter}:`, size: String(p.size ?? 0), type: 'part', model: null, serial: null, vendor: null, rota: null, tran: null })),
  }))
  const fsSize = []
  for (const p of parts) {
    try {
      const s = await statfs(`${p.letter}:\\`)
      const size = s.blocks * s.bsize
      const available = s.bavail * s.bsize
      const used = size - s.bfree * s.bsize
      fsSize.push({ fs: `${p.letter}:`, size, used, available, use: size ? Math.round((used / size) * 1000) / 10 : 0, mount: `${p.letter}:` })
    } catch {}
  }
  return { diskLayout: { blockdevices }, fsSize }
}

async function collectLinux() {
  let blockdevices = []
  try {
    const { stdout } = await execFileAsync('lsblk', ['--json', '-b', '-o', 'NAME,SIZE,TYPE,MODEL,SERIAL,VENDOR,ROTA,TRAN'])
    blockdevices = JSON.parse(stdout).blockdevices || []
  } catch {}
  const fsSize = []
  const seen = new Set()
  const mounts = (await readFile('/proc/self/mounts', 'utf8').catch(() => '')).split('\n')
  for (const line of mounts) {
    const [dev, mount, fstype] = line.split(' ')
    if (!dev?.startsWith('/dev/') || seen.has(dev)) continue
    if (/^(tmpfs|devtmpfs|squashfs|overlay)$/.test(fstype)) continue
    try {
      const s = await statfs(mount)
      const size = s.blocks * s.bsize
      const used = size - s.bfree * s.bsize
      fsSize.push({ fs: dev, size, used, available: s.bavail * s.bsize, use: size ? Math.round((used / size) * 1000) / 10 : 0, mount })
      seen.add(dev)
    } catch {}
  }
  return { diskLayout: { blockdevices }, fsSize }
}

export function startDiskInfoCollector({ storageDir, log, intervalMs = 120000 }) {
  const file = path.join(storageDir, 'nomad-disk-info.json')
  let stopped = false
  const run = async () => {
    try {
      const info = isWin ? await collectWindows() : await collectLinux()
      await writeJsonAtomic(file, info)
    } catch (err) {
      log.line(`[supervisor] disk info collection failed: ${err.message}`)
    }
  }
  run()
  const timer = setInterval(() => !stopped && run(), intervalMs)
  timer.unref()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
