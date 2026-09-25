// Shared building blocks for recipes: GitHub release resolution, executable discovery,
// archive flattening and a portable Python runtime for Python-based apps.
import { readdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fetchJson, githubHeaders, urlExists } from '../lib/download.mjs'
import { compareVersions, ensureDir, EngineError, exe, isWin, pathExists } from '../lib/util.mjs'

const execFileAsync = promisify(execFile)

export function unsupported(repo, reason) {
  return new EngineError(
    404,
    `"${repo}" is not available in the native (Docker-free) edition of Project NOMAD${reason ? `: ${reason}` : ''}.`
  )
}

/** Stable (non-draft, non-prerelease) releases of a GitHub repo, newest first (max ~300). */
export async function githubReleases(repo) {
  const all = []
  for (let page = 1; page <= 3; page++) {
    const batch = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers: githubHeaders(),
    })
    all.push(...batch)
    if (batch.length < 100) break
  }
  return all.filter((r) => !r.draft && !r.prerelease)
}

/**
 * Resolve a Docker-style tag to a concrete GitHub release tag.
 *   exact "v1.16.3" / "1.16.3"  → that tag (with or without the leading v, whichever exists)
 *   floating "v1.16" / "v2"     → highest stable release with that prefix
 *   "latest" / "rocm" / ""      → newest stable release
 * `probe` (optional) is a list of candidate tags to try with HEAD requests when the GitHub API
 * is unreachable or rate-limited.
 */
export async function resolveGithubTag(repo, tag, { assetFor, vPrefix = true } = {}) {
  const clean = String(tag || '').replace(/^v/, '')
  const isExact = /^\d+\.\d+\.\d+/.test(clean)
  const wantPrefix = /^\d+(\.\d+)?$/.test(clean) ? clean : null

  if (isExact && assetFor) {
    for (const t of vPrefix ? [`v${clean}`, clean] : [clean, `v${clean}`]) {
      if (await urlExists(githubAssetUrl(repo, t, assetFor(t)))) return t
    }
  }

  let releases
  try {
    releases = await githubReleases(repo)
  } catch (err) {
    if (isExact) return vPrefix ? `v${clean}` : clean
    throw new EngineError(502, `Could not list releases for ${repo} (${err.message}). Check the internet connection and try again.`)
  }
  const tags = releases.map((r) => r.tag_name)
  if (isExact) {
    const hit = tags.find((t) => t.replace(/^v/, '') === clean)
    if (hit) return hit
    throw new EngineError(404, `${repo} has no release ${tag}`)
  }
  const candidates = wantPrefix
    ? tags.filter((t) => {
        const v = t.replace(/^v/, '')
        return v === wantPrefix || v.startsWith(`${wantPrefix}.`)
      })
    : tags
  if (!candidates.length) throw new EngineError(404, `${repo} has no release matching ${tag}`)
  return candidates.sort((a, b) => compareVersions(b, a))[0]
}

export function githubAssetUrl(repo, tag, asset) {
  return `https://github.com/${repo}/releases/download/${tag}/${asset}`
}

/** Breadth-first search for the first file whose basename matches one of `names`. */
export async function findFile(dir, names, maxDepth = 4) {
  const wanted = names.map((n) => n.toLowerCase())
  let level = [dir]
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = []
    for (const d of level) {
      let entries = []
      try {
        entries = await readdir(d, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.isFile() && wanted.includes(e.name.toLowerCase())) return path.join(d, e.name)
      }
      for (const e of entries) if (e.isDirectory()) next.push(path.join(d, e.name))
    }
    level = next
  }
  return null
}

export async function requireFile(dir, names, what) {
  const found = await findFile(dir, names)
  if (!found) throw new EngineError(500, `${what} not found in the installed package (${dir}). Try reinstalling the app.`)
  return found
}

/** If `dir` holds exactly one sub-directory and nothing else, hoist its contents up a level. */
export async function flattenSingleRoot(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0].isDirectory()) return
  const inner = path.join(dir, entries[0].name)
  const tmp = path.join(dir, `.hoist-${Date.now()}`)
  await rename(inner, tmp)
  for (const name of await readdir(tmp)) await rename(path.join(tmp, name), path.join(dir, name))
  await rm(tmp, { recursive: true, force: true })
}

// ── Portable Python ─────────────────────────────────────────────────────────────

export const PYTHON_VERSION = process.env.NOMAD_PYTHON_VERSION || '3.12.10'

/**
 * Make sure a Python interpreter exists for Python-based apps and return its path.
 * Windows: the official CPython NuGet package (a full, relocatable interpreter with pip),
 * unpacked once under <engine home>/runtimes. Linux: a venv built from the system python3.
 */
export async function ensurePython(ctx) {
  const root = path.join(ctx.engineHome, 'runtimes', `python-${PYTHON_VERSION}`)
  const pythonExe = isWin ? path.join(root, 'tools', 'python.exe') : path.join(root, 'bin', 'python3')
  if (await pathExists(pythonExe)) return pythonExe

  await ensureDir(path.dirname(root))
  const staging = `${root}.staging-${Date.now()}`
  await rm(staging, { recursive: true, force: true })
  if (isWin) {
    ctx.progress(`Downloading Python ${PYTHON_VERSION} runtime`)
    const pkg = path.join(ctx.cacheDir, `python.${PYTHON_VERSION}.nupkg`)
    await ctx.download(`https://www.nuget.org/api/v2/package/python/${PYTHON_VERSION}`, pkg)
    ctx.progress('Unpacking Python runtime')
    await ctx.extract(pkg, staging)
    const py = path.join(staging, 'tools', 'python.exe')
    const hasPip = await execFileAsync(py, ['-m', 'pip', '--version'], { windowsHide: true })
      .then(() => true)
      .catch(() => false)
    if (!hasPip) await execFileAsync(py, ['-m', 'ensurepip', '--upgrade'], { windowsHide: true, timeout: 600000 })
  } else {
    const system = process.env.NOMAD_SYSTEM_PYTHON || 'python3'
    ctx.progress(`Creating Python environment from ${system}`)
    await execFileAsync(system, ['-m', 'venv', staging], { timeout: 600000 })
  }
  await rename(staging, root)
  return pythonExe
}

/** pip install `requirements` into an isolated `--target` directory. */
export async function pipInstall(ctx, python, target, requirements, { extraArgs = [] } = {}) {
  await ensureDir(target)
  const reqFile = path.join(path.dirname(target), 'requirements.txt')
  await writeFile(reqFile, requirements.join('\n') + '\n')
  ctx.progress(`Installing Python packages (${requirements.length})`)
  const args = [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-warn-script-location',
    '--no-input',
    '--upgrade',
    '--target',
    target,
    '-r',
    reqFile,
    ...extraArgs,
  ]
  await ctx.run(python, args, { timeout: 45 * 60 * 1000 })
}

/** Convert a Pipfile.lock "default" section to pip requirement lines (keeps env markers). */
export async function requirementsFromPipfileLock(lockPath) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  return Object.entries(lock.default || {}).map(([name, spec]) => {
    const extras = spec.extras?.length ? `[${spec.extras.join(',')}]` : ''
    const version = spec.version || ''
    const markers = spec.markers ? `; ${spec.markers}` : ''
    return `${name}${extras}${version}${markers}`
  })
}

export async function isDirectory(p) {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

export { exe, isWin }
