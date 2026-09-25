// Kiwix Serve (Information Library). Official kiwix-tools builds are published on
// download.kiwix.org for Windows (x86_64) and Linux; we pick the build matching the image tag.
// The Windows installer bundles the build for the pinned version (seedDir), so the library
// installs without reaching download.kiwix.org.
import { readdir } from 'node:fs/promises'
import { fetchText } from '../lib/download.mjs'
import { compareVersions, EngineError, exe, isWin } from '../lib/util.mjs'
import { flattenSingleRoot, requireFile } from './_helpers.mjs'

export const KIWIX_MIRRORS = [
  'https://download.kiwix.org/release/kiwix-tools/',
  'https://mirror.download.kiwix.org/release/kiwix-tools/',
]

/** Build flavours to look for, best first (32-bit Windows builds also run on 64-bit Windows). */
export function kiwixPlatforms(win = isWin) {
  if (win) return [{ plat: 'win-x86_64', ext: 'zip' }, { plat: 'win-i686', ext: 'zip' }]
  return [{ plat: process.arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64', ext: 'tar.gz' }]
}

/** The release listing from the first mirror that answers. */
export async function fetchKiwixListing() {
  for (const base of KIWIX_MIRRORS) {
    try {
      return { base, listing: await fetchText(base, { timeout: 30000 }) }
    } catch {}
  }
  throw new EngineError(502, 'Could not reach download.kiwix.org to fetch Kiwix. Check the internet connection.')
}

/**
 * Pick the kiwix-tools build for version `want` from file names (a mirror listing or a folder):
 * the newest rebuild of that exact version, else the newest of the same minor, else the newest.
 * With `exactOnly`, only builds of exactly `want` qualify.
 */
export function pickKiwixBuild(names, want, { win = isWin, exactOnly = false } = {}) {
  const text = Array.isArray(names) ? names.join('\n') : names
  const byVersionDesc = (a, b) => compareVersions(b, a)
  for (const { plat, ext } of kiwixPlatforms(win)) {
    const re = new RegExp(`kiwix-tools_${plat}-(\\d+\\.\\d+\\.\\d+(?:-\\d+)?)\\.${ext.replace('.', '\\.')}`, 'g')
    const builds = [...new Set([...text.matchAll(re)].map((m) => m[1]))]
    if (!builds.length) continue
    const exact = builds.filter((v) => v === want || v.startsWith(`${want}-`)).sort(byVersionDesc)
    const [maj, min] = String(want).split('.')
    const sameMinor = builds.filter((v) => v.startsWith(`${maj}.${min}.`)).sort(byVersionDesc)
    const version = exactOnly ? exact[0] : exact[0] || sameMinor[0] || builds.sort(byVersionDesc)[0]
    if (version) return { version, file: `kiwix-tools_${plat}-${version}.${ext}` }
  }
  return null
}

export default {
  id: 'kiwix-serve',
  title: 'Kiwix Serve',
  match: (repo) => repo === 'ghcr.io/kiwix/kiwix-serve' || repo === 'kiwix/kiwix-serve',

  async resolve({ tag, seedDir }) {
    const want = String(tag || '').replace(/^v/, '')
    if (seedDir && want) {
      const bundled = pickKiwixBuild(await readdir(seedDir).catch(() => []), want, { exactOnly: true })
      if (bundled) return { version: bundled.version, key: bundled.file, url: KIWIX_MIRRORS[0] + bundled.file }
    }
    const { base, listing } = await fetchKiwixListing()
    const build = pickKiwixBuild(listing, want)
    if (!build) throw new EngineError(404, `No kiwix-tools build for ${kiwixPlatforms()[0].plat} is published`)
    return { version: build.version, key: build.file, url: base + build.file }
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
