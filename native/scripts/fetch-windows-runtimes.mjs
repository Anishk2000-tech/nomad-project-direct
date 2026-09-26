#!/usr/bin/env node
// Download the official Windows builds bundled with the native edition into a staged folder:
//   runtime/node     Node.js (same version as the one building the app, so native modules match)
//   runtime/mariadb  MariaDB LTS (MySQL-compatible database)
//   runtime/redis    Redis for Windows (job queues)
//   runtime/pmtiles  go-pmtiles (offline map extracts)
//   runtime/seed     kiwix-tools for Windows, so the Information Library installs offline
//   service/ProjectNOMAD.exe   WinSW service wrapper
// plus LICENSE.txt / licenses/ with the third-party notices.
//
//   node native/scripts/fetch-windows-runtimes.mjs --out <stage dir>
//        [--mariadb-series 11.4] [--pmtiles 1.30.2] [--winsw v2.12.0] [--node v22.x.y]
//        [--kiwix 3.8.1 (default: the version pinned in the service seeder)]
import path from 'node:path'
import { cp, mkdir, readdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { downloadFile, fetchJson, fetchText, githubHeaders, hashFile } from '../engine/lib/download.mjs'
import { extractArchive } from '../engine/lib/archive.mjs'
import { compareVersions, pathExists } from '../engine/lib/util.mjs'
import { fetchKiwixListing, pickKiwixBuild } from '../engine/recipes/kiwix.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
)
if (!args.out) {
  console.error('usage: fetch-windows-runtimes.mjs --out <stage dir>')
  process.exit(2)
}
const out = path.resolve(args.out)
const cache = path.resolve(args.cache || path.join(out, '..', 'download-cache'))
const runtime = path.join(out, 'runtime')
const licenses = path.join(out, 'licenses')
const versions = {}

async function fetchTo(url, name, sha256) {
  const dest = path.join(cache, name)
  if (await pathExists(dest)) {
    if (!sha256 || (await hashFile(dest)) === sha256.toLowerCase()) return dest
    await rm(dest, { force: true })
  }
  console.log(`  downloading ${url}`)
  let last = 0
  await downloadFile(url, dest, {
    sha256,
    onProgress: ({ current, total }) => {
      const pct = total ? Math.floor((current / total) * 100) : 0
      if (pct >= last + 20) {
        last = pct
        console.log(`    ${pct}% of ${(total / 1e6).toFixed(0)} MB`)
      }
    },
  })
  return dest
}

async function extractFlat(archive, dest) {
  const tmp = `${dest}.tmp`
  await rm(tmp, { recursive: true, force: true })
  await extractArchive(archive, tmp)
  let root = tmp
  const entries = await readdir(tmp, { withFileTypes: true })
  if (entries.length === 1 && entries[0].isDirectory()) root = path.join(tmp, entries[0].name)
  await rm(dest, { recursive: true, force: true })
  await cp(root, dest, { recursive: true })
  await rm(tmp, { recursive: true, force: true })
}

async function removeMatching(dir, test) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name)
    if (test(e, p)) await rm(p, { recursive: true, force: true })
    else if (e.isDirectory()) await removeMatching(p, test)
  }
}

async function latestGithubRelease(repoName, filter) {
  const releases = await fetchJson(`https://api.github.com/repos/${repoName}/releases?per_page=100`, { headers: githubHeaders() })
  return releases.filter((r) => !r.draft && !r.prerelease && filter(r)).sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0]
}

// ── Node.js ────────────────────────────────────────────────────────────────
async function node() {
  const v = args.node || process.version
  console.log(`Node.js ${v}`)
  const name = `node-${v}-win-x64.zip`
  const sums = await fetchText(`https://nodejs.org/dist/${v}/SHASUMS256.txt`)
  const sha = sums.split('\n').find((l) => l.endsWith(`  ${name}`))?.split(/\s+/)[0]
  const zip = await fetchTo(`https://nodejs.org/dist/${v}/${name}`, name, sha)
  const tmp = path.join(cache, 'node-extract')
  await extractFlat(zip, tmp)
  const dest = path.join(runtime, 'node')
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  await copyFile(path.join(tmp, 'node.exe'), path.join(dest, 'node.exe'))
  await copyFile(path.join(tmp, 'LICENSE'), path.join(licenses, 'nodejs-LICENSE.txt'))
  versions.node = v
}

// ── MariaDB ────────────────────────────────────────────────────────────────
async function mariadb() {
  const series = args['mariadb-series'] || '11.4'
  console.log(`MariaDB ${series}.x`)
  let file = null
  try {
    const data = await fetchJson(`https://downloads.mariadb.org/rest-api/mariadb/${series}/`)
    const releases = Object.values(data.releases || {}).sort((a, b) => compareVersions(b.release_id, a.release_id))
    for (const r of releases) {
      const f = (r.files || []).find((x) => /winx64\.zip$/i.test(x.file_name) && !/debug/i.test(x.file_name))
      if (f) {
        file = { version: r.release_id, name: f.file_name, url: f.file_download_url, sha256: f.checksum?.sha256sum }
        break
      }
    }
  } catch (err) {
    console.log(`  MariaDB REST API unavailable (${err.message}); falling back to archive.mariadb.org`)
  }
  if (!file) {
    const listing = await fetchText('https://archive.mariadb.org/')
    const vs = [...listing.matchAll(new RegExp(`mariadb-(${series.replace('.', '\\.')}\\.\\d+)/`, 'g'))].map((m) => m[1])
    const version = vs.sort(compareVersions).pop()
    file = {
      version,
      name: `mariadb-${version}-winx64.zip`,
      url: `https://archive.mariadb.org/mariadb-${version}/winx64-packages/mariadb-${version}-winx64.zip`,
    }
  }
  const zip = await fetchTo(file.url, file.name, file.sha256)
  const dest = path.join(runtime, 'mariadb')
  await extractFlat(zip, dest)
  // Drop what a server doesn't need at runtime: test suites, headers, static libs, debug symbols.
  for (const d of ['mysql-test', 'sql-bench', 'include']) await rm(path.join(dest, d), { recursive: true, force: true })
  await removeMatching(dest, (e) => e.isFile() && /\.(pdb|lib)$/i.test(e.name))
  if (!(await pathExists(path.join(dest, 'bin', 'mariadbd.exe'))) && !(await pathExists(path.join(dest, 'bin', 'mysqld.exe')))) {
    throw new Error('MariaDB archive has no bin/mariadbd.exe')
  }
  for (const f of ['COPYING', 'README.md', 'THIRDPARTY']) {
    if (await pathExists(path.join(dest, f))) await copyFile(path.join(dest, f), path.join(licenses, `mariadb-${f}.txt`))
  }
  versions.mariadb = file.version
}

// ── Redis ──────────────────────────────────────────────────────────────────
async function redis() {
  console.log('Redis for Windows')
  let pick = null
  try {
    // Prefer the newest 7.2.x (BSD-licensed); then any 7.x; the MSYS2 build without the service wrapper.
    const assetFor = (r) => r.assets.find((a) => /windows-x64-msys2\.zip$/i.test(a.name) && !/service/i.test(a.name))
    const rel =
      (await latestGithubRelease('redis-windows/redis-windows', (r) => /^v?7\.2\./.test(r.tag_name) && assetFor(r))) ||
      (await latestGithubRelease('redis-windows/redis-windows', (r) => /^v?7\./.test(r.tag_name) && assetFor(r)))
    if (rel) pick = { version: rel.tag_name, url: assetFor(rel).browser_download_url, name: assetFor(rel).name, source: 'redis-windows/redis-windows' }
  } catch (err) {
    console.log(`  redis-windows lookup failed: ${err.message}`)
  }
  if (!pick) {
    pick = {
      version: '5.0.14.1',
      url: 'https://github.com/tporadowski/redis/releases/download/v5.0.14.1/Redis-x64-5.0.14.1.zip',
      name: 'Redis-x64-5.0.14.1.zip',
      source: 'tporadowski/redis',
    }
  }
  const zip = await fetchTo(pick.url, pick.name)
  const dest = path.join(runtime, 'redis')
  await extractFlat(zip, dest)
  await removeMatching(dest, (e) => e.isFile() && /\.(pdb)$/i.test(e.name))
  if (!(await pathExists(path.join(dest, 'redis-server.exe')))) throw new Error(`${pick.name} has no redis-server.exe`)
  for (const f of await readdir(dest)) {
    if (/^(license|copying|00-release)/i.test(f)) await copyFile(path.join(dest, f), path.join(licenses, `redis-${f}${/\.\w+$/.test(f) ? '' : '.txt'}`))
  }
  versions.redis = `${pick.version} (${pick.source})`
}

// ── go-pmtiles ─────────────────────────────────────────────────────────────
async function pmtiles() {
  const v = String(args.pmtiles || '1.30.2').replace(/^v/, '')
  console.log(`go-pmtiles ${v}`)
  const name = `go-pmtiles_${v}_Windows_x86_64.zip`
  const zip = await fetchTo(`https://github.com/protomaps/go-pmtiles/releases/download/v${v}/${name}`, name)
  const tmp = path.join(cache, 'pmtiles-extract')
  await extractFlat(zip, tmp)
  const dest = path.join(runtime, 'pmtiles')
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  await copyFile(path.join(tmp, 'pmtiles.exe'), path.join(dest, 'pmtiles.exe'))
  if (await pathExists(path.join(tmp, 'LICENSE'))) await copyFile(path.join(tmp, 'LICENSE'), path.join(licenses, 'go-pmtiles-LICENSE.txt'))
  versions.pmtiles = v
}

// ── kiwix-tools ────────────────────────────────────────────────────────────
// The Information Library is NOMAD's core app, so the installer ships the kiwix-tools build for
// the pinned kiwix-serve version; the engine uses it instead of downloading (download.kiwix.org
// hands out mirrors that can be very slow), which also lets it install with no internet.
async function kiwixTools() {
  const seeder = await readFile(path.join(repo, 'admin', 'database', 'seeders', 'service_seeder.ts'), 'utf8')
  const want = String(args.kiwix || seeder.match(/kiwix-serve:v?(\d+\.\d+\.\d+)/)?.[1] || '').replace(/^v/, '')
  if (!want) throw new Error('Could not find the kiwix-serve version in service_seeder.ts (pass --kiwix)')
  console.log(`kiwix-tools ${want}`)
  const { base, listing } = await fetchKiwixListing()
  const build = pickKiwixBuild(listing, want, { win: true, exactOnly: true })
  if (!build) throw new Error(`No Windows kiwix-tools build for ${want} on ${base}`)
  const zip = await fetchTo(base + build.file, build.file)
  const seed = path.join(runtime, 'seed')
  await rm(seed, { recursive: true, force: true })
  await mkdir(seed, { recursive: true })
  await copyFile(zip, path.join(seed, build.file))
  for (const ref of [want, 'main']) {
    const lic = await fetchText(`https://raw.githubusercontent.com/kiwix/kiwix-tools/${ref}/COPYING`).catch(() => null)
    if (lic) {
      await writeFile(path.join(licenses, 'kiwix-tools-COPYING.txt'), lic)
      break
    }
  }
  versions.kiwixTools = build.version
}

// ── WinSW ──────────────────────────────────────────────────────────────────
async function winsw() {
  const tag = args.winsw || 'v2.12.0'
  console.log(`WinSW ${tag}`)
  const dest = path.join(out, 'service')
  await mkdir(dest, { recursive: true })
  let lastErr
  for (const asset of ['WinSW.NET461.exe', 'WinSW-net461.exe', 'WinSW-x64.exe']) {
    try {
      const file = await fetchTo(`https://github.com/winsw/winsw/releases/download/${tag}/${asset}`, `winsw-${tag}-${asset}`)
      await copyFile(file, path.join(dest, 'ProjectNOMAD.exe'))
      versions.winsw = `${tag} (${asset})`
      const lic = await fetchText(`https://raw.githubusercontent.com/winsw/winsw/${tag}/LICENSE.txt`).catch(() => null)
      if (lic) await writeFile(path.join(licenses, 'winsw-LICENSE.txt'), lic)
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

// ── Visual C++ Redistributable ─────────────────────────────────────────────
// Native Windows builds of the apps (Qdrant, Ollama, Kiwix, ...) are compiled with MSVC and need
// the VC++ 2015-2022 runtime, which a fresh Windows install may lack. Microsoft permits
// redistributing vc_redist.x64.exe; the installer runs it silently. Kept outside the staged
// program files (<out>/../redist) because it's only needed during setup.
async function vcredist() {
  console.log('Visual C++ 2015-2022 Redistributable (x64)')
  const dest = path.join(out, '..', 'redist')
  await mkdir(dest, { recursive: true })
  const file = await fetchTo('https://aka.ms/vs/17/release/vc_redist.x64.exe', 'vc_redist.x64.exe')
  await copyFile(file, path.join(dest, 'vc_redist.x64.exe'))
  versions.vcredist = 'latest (aka.ms/vs/17/release)'
}

await mkdir(runtime, { recursive: true })
await mkdir(licenses, { recursive: true })
await mkdir(cache, { recursive: true })
for (const step of [node, mariadb, redis, pmtiles, kiwixTools, winsw, vcredist]) await step()

// LICENSE.txt shown by the installer: NOMAD's license followed by the bundled components.
const apache = await readFile(path.join(repo, 'LICENSE'), 'utf8')
const notice = [
  'Project NOMAD is licensed under the Apache License 2.0 (below).',
  '',
  'This Windows edition also bundles the following third-party software, each under its own',
  'license (full texts in the "licenses" folder of the installation):',
  `  - Node.js ${versions.node} (MIT)`,
  `  - MariaDB Server ${versions.mariadb} (GPL-2.0; source: https://mariadb.org/download/)`,
  `  - Redis for Windows ${versions.redis} (see licenses folder)`,
  `  - go-pmtiles ${versions.pmtiles} (BSD-3-Clause)`,
  `  - kiwix-tools ${versions.kiwixTools} (GPL-3.0; source: https://github.com/kiwix/kiwix-tools)`,
  `  - WinSW ${versions.winsw} (MIT)`,
  'Other apps you install from the dashboard (Ollama, Qdrant, Kolibri, ...) are downloaded',
  'from their official publishers and are covered by their own licenses.',
  '',
  '-------------------------------------------------------------------------------',
  '',
  apache,
].join('\r\n')
await writeFile(path.join(out, 'LICENSE.txt'), notice.replace(/\r?\n/g, '\r\n'))
await writeFile(path.join(runtime, 'versions.json'), JSON.stringify(versions, null, 2))

console.log('Runtimes ready:', versions)
