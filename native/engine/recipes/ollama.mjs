// Ollama (AI Assistant). Windows: the official portable zip (ollama.exe + CUDA runners) from
// GitHub releases, plus the ROCm add-on when the image tag asks for it or an AMD GPU is present.
// Linux: the binary and CPU/GPU libraries taken from the ollama/ollama image.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { resolveManifest } from '../lib/oci.mjs'
import { exe, isWin } from '../lib/util.mjs'
import { githubAssetUrl, requireFile, resolveGithubTag } from './_helpers.mjs'

const execFileAsync = promisify(execFile)
const REPO = 'ollama/ollama'
const WIN_ASSET = 'ollama-windows-amd64.zip'
const WIN_ROCM_ASSET = 'ollama-windows-amd64-rocm.zip'

async function hasAmdGpuOnWindows() {
  if (!isWin) return false
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join "`n"'],
      { windowsHide: true, timeout: 20000 }
    )
    return /\b(AMD|Radeon)\b/i.test(stdout)
  } catch {
    return false
  }
}

async function hasNvidiaGpu() {
  try {
    await execFileAsync('nvidia-smi', ['-L'], { windowsHide: true, timeout: 10000 })
    return true
  } catch {
    return false
  }
}

export default {
  id: 'ollama',
  title: 'Ollama',
  match: (repo) => repo === 'ollama/ollama',

  async resolve({ tag, ref }) {
    const wantsRocm = /rocm/i.test(String(tag))
    const versionTag = /^\d/.test(String(tag).replace(/^v/, '')) ? String(tag).replace(/-rocm$/i, '') : 'latest'
    if (isWin) {
      const release = await resolveGithubTag(REPO, versionTag, { assetFor: () => WIN_ASSET })
      const rocm = wantsRocm || (await hasAmdGpuOnWindows())
      const assets = [WIN_ASSET, ...(rocm ? [WIN_ROCM_ASSET] : [])]
      return {
        version: release.replace(/^v/, ''),
        key: `${release}/${assets.join('+')}`,
        urls: assets.map((a) => ({ url: githubAssetUrl(REPO, release, a), name: `${release}_${a}` })),
      }
    }
    const { digest } = await resolveManifest(ref)
    return { version: String(tag), key: digest, oci: ref, withGpuLibs: await hasNvidiaGpu() }
  },

  async install(ctx, resolved) {
    if (resolved.urls) {
      for (const { url, name } of resolved.urls) {
        const archive = await ctx.fetch(url, name)
        await ctx.extract(archive, ctx.dir)
      }
      return
    }
    // Keep the CPU runner libraries always; the multi-GB CUDA/ROCm trees only when usable.
    await ctx.oci(resolved.oci, ctx.dir, (rel) => {
      if (rel === 'usr/bin/ollama') return 'bin/ollama'
      if (!rel.startsWith('usr/lib/ollama/')) return null
      const sub = rel.slice('usr/lib/ollama/'.length)
      if (!resolved.withGpuLibs && sub.includes('/')) return null
      return `lib/ollama/${sub}`
    })
  },

  async launch(ctx) {
    const bin = await requireFile(ctx.image.dir, [exe('ollama')], 'ollama')
    const modelsDir = path.join(ctx.hostPath('/root/.ollama'), 'models')
    const env = {
      OLLAMA_HOST: `0.0.0.0:${ctx.hostPort(11434) ?? 11434}`,
      OLLAMA_MODELS: modelsDir,
      // Ollama's default origin allowlist covers localhost; LAN clients go through the admin.
    }
    return { command: bin, args: ['serve'], env, cwd: path.dirname(bin), mkdirs: [modelsDir] }
  },
}
