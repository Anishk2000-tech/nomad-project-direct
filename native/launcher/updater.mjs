// Native stand-in for the Docker edition's updater sidecar. The admin writes
// <home>/update/update-request (same JSON protocol as the sidecar); we download the matching
// Windows installer from the releases repository and run it silently. The installer stops this
// service, replaces the program files and starts it again; on the next start we report the
// result through update-status.
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { downloadFile, fetchJson, githubHeaders } from '../engine/lib/download.mjs'
import { ensureDir, isWin, readJson, writeJsonAtomic } from '../engine/lib/util.mjs'

const execFileAsync = promisify(execFile)
const TASK_NAME = 'ProjectNOMAD-Update'

export function startUpdater({ paths, cfg, log, currentVersion }) {
  const dir = paths.updateDir
  const requestFile = path.join(dir, 'update-request')
  const statusFile = path.join(dir, 'update-status')
  const logFile = path.join(dir, 'update-log')
  const pendingFile = path.join(dir, 'pending-update.json')
  let busy = false

  const status = (stage, progress, message) =>
    writeJsonAtomic(statusFile, { stage, progress, message, timestamp: new Date().toISOString() })
  const ulog = async (msg) => {
    const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}\n`
    await appendFile(logFile, line).catch(() => {})
    log.line(`[updater] ${msg}`)
  }

  async function reportPreviousUpdate() {
    const pending = await readJson(pendingFile)
    if (!pending) return
    await rm(pendingFile, { force: true })
    const want = String(pending.version || '').replace(/^(windows-)?v/i, '')
    if (want && currentVersion && want === String(currentVersion).replace(/^(windows-)?v/i, '')) {
      await ulog(`Now running ${currentVersion} — update complete`)
      await status('complete', 100, 'System update completed successfully')
    } else {
      await ulog(`Update to ${want} did not take effect (running ${currentVersion ?? 'unknown'})`)
      await status('error', 0, 'The update installer did not complete - check logs')
    }
  }

  async function perform(request) {
    await writeFile(logFile, '')
    const tag = request.target_tag || 'latest'
    await ulog(`Update request received (target: ${tag})`)
    await status('starting', 0, 'System update initiated')
    if (!isWin) {
      await ulog('Automatic updates are only available in the Windows edition')
      await status('error', 0, 'Automatic updates are only available in the Windows edition')
      return
    }

    // Native releases may be tagged vX.Y.Z or windows-vX.Y.Z; accept either for the requested version.
    const base = `https://api.github.com/repos/${cfg.releasesRepo}/releases`
    let release
    try {
      if (tag === 'latest') {
        release = await fetchJson(`${base}/latest`, { headers: githubHeaders(), timeout: 30000 })
      } else {
        const version = tag.replace(/^(windows-)?v/i, '')
        const list = await fetchJson(`${base}?per_page=100`, { headers: githubHeaders(), timeout: 30000 })
        release = list.find((r) => !r.draft && r.tag_name.replace(/^(windows-)?v/i, '') === version)
        if (!release) throw new Error(`no release for version ${version}`)
      }
    } catch (err) {
      await ulog(`Could not read release ${tag} from ${cfg.releasesRepo}: ${err.message}`)
      await status('error', 0, 'Could not find the release on GitHub - check logs')
      return
    }
    const asset = (release.assets || []).find((a) => /setup.*\.exe$/i.test(a.name) && /nomad/i.test(a.name))
    if (!asset) {
      await ulog(`Release ${release.tag_name} has no Windows installer asset`)
      await status('error', 0, 'This release has no Windows installer yet')
      return
    }

    await status('pulling', 20, `Downloading ${asset.name}...`)
    await ulog(`Downloading ${asset.browser_download_url}`)
    const installer = path.join(dir, asset.name)
    try {
      await downloadFile(asset.browser_download_url, installer, {
        onProgress: ({ current, total }) => {
          if (total) status('pulling', 20 + Math.round((current / total) * 40), `Downloading ${asset.name}...`).catch(() => {})
        },
      })
    } catch (err) {
      await ulog(`Download failed: ${err.message}`)
      await status('error', 0, 'Failed to download the update - check logs')
      return
    }
    await status('pulled', 60, 'Installer downloaded')

    await writeJsonAtomic(pendingFile, { version: release.tag_name, requestedAt: new Date().toISOString() })
    await status('recreating', 70, 'Installing the update - NOMAD will restart in a moment...')
    await ulog(`Launching ${asset.name} (silent). NOMAD will restart.`)
    // A scheduled task runs the installer outside this service's process tree, so it survives
    // the installer stopping the service.
    const tr = `"${installer}" /S /UPDATE`
    await execFileAsync('schtasks.exe', ['/Create', '/TN', TASK_NAME, '/TR', tr, '/SC', 'ONCE', '/ST', '23:59', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F'], { windowsHide: true })
    await execFileAsync('schtasks.exe', ['/Run', '/TN', TASK_NAME], { windowsHide: true })
  }

  async function poll() {
    if (busy || !existsSync(requestFile)) return
    busy = true
    try {
      const request = JSON.parse(await readFile(requestFile, 'utf8').catch(() => '{}') || '{}')
      await rm(requestFile, { force: true })
      await perform(request)
    } catch (err) {
      await ulog(`Update failed: ${err.message}`)
      await status('error', 0, 'Update failed - check logs')
    } finally {
      busy = false
    }
  }

  let timer
  ensureDir(dir).then(async () => {
    await reportPreviousUpdate()
    if (isWin) await execFileAsync('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { windowsHide: true }).catch(() => {})
    timer = setInterval(poll, 3000)
    timer.unref()
  })
  return { stop: () => clearInterval(timer) }
}
