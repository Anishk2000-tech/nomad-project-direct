#!/usr/bin/env node
// Shrink a staged app folder before packaging by deleting files that are never loaded at
// runtime: source maps, TypeScript declarations, changelogs/readmes and CI folders. Licenses are
// kept. Only file-name patterns are used (no directory guessing) so behaviour can't change.
//   node native/scripts/prune-app.mjs --dir <stage>/app
import path from 'node:path'
import { readdir, rm, stat } from 'node:fs/promises'

const dirArg = process.argv[process.argv.indexOf('--dir') + 1]
if (!dirArg || process.argv.indexOf('--dir') < 0) {
  console.error('usage: prune-app.mjs --dir <folder>')
  process.exit(2)
}
const root = path.resolve(dirArg)

const FILE_PATTERNS = [
  /\.map$/i,
  /\.d\.[cm]?ts$/i,
  /\.tsbuildinfo$/i,
  /^(changelog|history|changes)(\.[a-z]+)?$/i,
  /^readme(\.[a-z]+)?$/i,
  /^contributing(\.[a-z]+)?$/i,
  /^\.(eslintrc|prettierrc|editorconfig|npmignore|travis\.yml|nycrc)(\.[a-z]+)?$/i,
]
const DIR_NAMES = new Set(['.github', '.vscode', '.idea'])

let files = 0
let bytes = 0
async function walk(dir, inNodeModules) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      if (inNodeModules && DIR_NAMES.has(e.name)) {
        await rm(p, { recursive: true, force: true })
        continue
      }
      await walk(p, inNodeModules || e.name === 'node_modules')
    } else if (e.isFile()) {
      // Outside node_modules only drop source maps (the compiled app's own .js.map files).
      const match = inNodeModules ? FILE_PATTERNS.some((re) => re.test(e.name)) : /\.map$/i.test(e.name)
      if (match) {
        bytes += (await stat(p)).size
        files++
        await rm(p, { force: true })
      }
    }
  }
}

await walk(root, false)
console.log(`Pruned ${files} files (${(bytes / 1024 / 1024).toFixed(1)} MB) from ${root}`)
