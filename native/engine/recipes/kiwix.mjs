// Kiwix Serve (Information Library). Official kiwix-tools builds are published on
// download.kiwix.org for Windows (x86_64) and Linux; we pick the build matching the image tag.
import { fetchText } from '../lib/download.mjs'
import { compareVersions, EngineError, exe, isWin } from '../lib/util.mjs'
import { flattenSingleRoot, requireFile } from './_helpers.mjs'

const MIRRORS = [
  'https://download.kiwix.org/release/kiwix-tools/',
  'https://mirror.download.kiwix.org/release/kiwix-tools/',
]

/** Build flavours to look for, best first (32-bit Windows builds also run on 64-bit Windows). */
function platformTags() {
  if (isWin) return [{ plat: 'win-x86_64', ext: 'zip' }, { plat: 'win-i686', ext: 'zip' }]
  return [{ plat: process.arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64', ext: 'tar.gz' }]
}

export default {
  id: 'kiwix-serve',
  title: 'Kiwix Serve',
  match: (repo) => repo === 'ghcr.io/kiwix/kiwix-serve' || repo === 'kiwix/kiwix-serve',

  async resolve({ tag }) {
    let listing = null
    let base = null
    for (const m of MIRRORS) {
      try {
        listing = await fetchText(m, { timeout: 30000 })
        base = m
        break
      } catch {}
    }
    if (!listing) throw new EngineError(502, 'Could not reach download.kiwix.org to fetch Kiwix. Check the internet connection.')

    let plat, ext, builds = []
    for (const candidate of platformTags()) {
      const re = new RegExp(`kiwix-tools_${candidate.plat}-(\\d+\\.\\d+\\.\\d+(?:-\\d+)?)\\.${candidate.ext.replace('.', '\\.')}`, 'g')
      builds = [...new Set([...listing.matchAll(re)].map((m) => m[1]))]
      if (builds.length) {
        ;({ plat, ext } = candidate)
        break
      }
    }
    if (!builds.length) throw new EngineError(404, `No kiwix-tools build for ${platformTags()[0].plat} is published`)

    const want = String(tag || '').replace(/^v/, '')
    const byVersionDesc = (a, b) => compareVersions(b, a)
    const exact = builds.filter((v) => v === want || v.startsWith(`${want}-`)).sort(byVersionDesc)
    const [maj, min] = want.split('.')
    const sameMinor = builds.filter((v) => v.startsWith(`${maj}.${min}.`)).sort(byVersionDesc)
    const version = exact[0] || sameMinor[0] || builds.sort(byVersionDesc)[0]
    const file = `kiwix-tools_${plat}-${version}.${ext}`
    return { version, key: file, url: base + file }
  },

  async install(ctx, resolved) {
    const archive = await ctx.fetch(resolved.url, resolved.key)
    await ctx.extract(archive, ctx.dir)
    await flattenSingleRoot(ctx.dir)
  },

  async launch(ctx) {
    const bin = await requireFile(ctx.image.dir, [exe('kiwix-serve')], 'kiwix-serve')
    const cmd = ctx.cmd.length ? ctx.cmd : ['--library', '/data/kiwix-library.xml', '--monitorLibrary']
    // Docker passes --address=all so kiwix listens on IPv4+IPv6 inside the container. Natively,
    // kiwix-serve's default already listens on every interface, and releases older than 3.7
    // reject "all" as an address, so leave the flag out.
    const args = ctx.translateArgs(cmd.filter((a) => a !== '--address=all'))
    if (!args.some((a) => a === '-p' || a.startsWith('--port'))) args.push(`--port=${ctx.hostPort(8080) ?? 8080}`)
    return { command: bin, args, cwd: ctx.container.dataDir }
  },
}
