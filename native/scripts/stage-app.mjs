#!/usr/bin/env node
// Assemble the install layout for the native edition (mirrors what the Dockerfile puts in the
// image), used by the Windows installer build and for local end-to-end testing:
//
//   <out>/app/            built admin (node ace build) + production node_modules + docs etc.
//   <out>/native/         engine + launcher
//   <out>/build-info.json version / releases repository
//
//   node native/scripts/stage-app.mjs --out <dir> [--version 1.34.1] [--releases-repo owner/repo]
//                                     [--skip-build] [--skip-install]
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const admin = path.join(repo, 'admin')

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (!a.startsWith('--')) return acc
    const next = arr[i + 1]
    return [...acc, [a.slice(2), next && !next.startsWith('--') ? next : true]]
  }, [])
)
if (!args.out) {
  console.error('usage: stage-app.mjs --out <dir> [--version x.y.z] [--releases-repo owner/repo] [--skip-build] [--skip-install]')
  process.exit(2)
}
const out = path.resolve(args.out)
const rootPkg = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'))
const version = String(args.version || rootPkg.version).replace(/^v/, '')
const isWin = process.platform === 'win32'
const npm = isWin ? 'npm.cmd' : 'npm'

function run(cmd, argv, cwd) {
  console.log(`> ${cmd} ${argv.join(' ')}   (in ${path.relative(repo, cwd) || '.'})`)
  const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit', shell: isWin })
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed with code ${r.status}`)
}

if (!args['skip-build']) {
  run(npm, ['run', 'gen:curated-data'], admin)
  run('node', ['ace', 'build'], admin)
}
if (!existsSync(path.join(admin, 'build', 'bin', 'server.js'))) throw new Error('admin/build is missing — run without --skip-build')

await rm(path.join(out, 'app'), { recursive: true, force: true })
await mkdir(out, { recursive: true })
await cp(path.join(admin, 'build'), path.join(out, 'app'), { recursive: true })
await cp(path.join(admin, 'docs'), path.join(out, 'app', 'docs'), { recursive: true })
await cp(path.join(repo, 'README.md'), path.join(out, 'app', 'README.md'))
await mkdir(path.join(out, 'app', 'assets', 'calibre'), { recursive: true })
await cp(path.join(repo, 'install', 'calibre-empty-library', 'metadata.db'), path.join(out, 'app', 'assets', 'calibre', 'metadata.db'))
await writeFile(path.join(out, 'app', 'version.json'), JSON.stringify({ version }))
// Seed ZIM so the Information Library can be installed without first reaching GitHub.
await mkdir(path.join(out, 'app', 'assets', 'zim'), { recursive: true })
await cp(path.join(repo, 'install', 'wikipedia_en_100_mini_2026-01.zim'), path.join(out, 'app', 'assets', 'zim', 'wikipedia_en_100_mini_2026-01.zim'))

if (!args['skip-install']) {
  // --ignore-scripts: @openzim/libzim's install script can't build on Windows (no libzim binary);
  // NOMAD falls back to its built-in ZIM reader there. Rebuild the modules that need it.
  run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(out, 'app'))
  run(npm, ['rebuild', 'better-sqlite3', 'sharp'], path.join(out, 'app'))
}

await rm(path.join(out, 'native'), { recursive: true, force: true })
for (const part of ['engine', 'launcher']) {
  await cp(path.join(repo, 'native', part), path.join(out, 'native', part), { recursive: true })
}
await writeFile(path.join(out, 'native', 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2))

const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout?.trim() || null
await writeFile(
  path.join(out, 'build-info.json'),
  JSON.stringify(
    {
      version,
      releasesRepo: args['releases-repo'] || 'Crosstalk-Solutions/project-nomad',
      commit,
      builtAt: new Date().toISOString(),
      node: process.version,
    },
    null,
    2
  )
)
console.log(`Staged Project NOMAD ${version} into ${out}`)
