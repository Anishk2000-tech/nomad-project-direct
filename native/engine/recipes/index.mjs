// Recipe registry. A recipe teaches the engine how to "pull" an image NOMAD references (download
// the equivalent native build) and how to "run" a container of it (build a process command line
// from the container's Cmd/Env/Binds/PortBindings). Contract:
//
//   id, title
//   match(repo) → boolean                 repo is canonical, e.g. "qdrant/qdrant", "ghcr.io/kiwix/kiwix-serve"
//   resolve({ repo, tag, ref }) → { version, key, ... }   `key` identifies the exact content; a pull whose
//                                                          key is unchanged is a no-op ("Image is up to date")
//   install(ctx, resolved)                 populate ctx.dir (see images.mjs for ctx helpers)
//   launch(ctx) → { command, args, env, cwd, mkdirs? }   (see containers.mjs for ctx helpers)
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import kiwix from './kiwix.mjs'
import qdrant from './qdrant.mjs'
import ollama from './ollama.mjs'
import staticWeb from './static-web.mjs'
import filebrowser from './filebrowser.mjs'
import kolibri from './kolibri.mjs'
import flatnotes from './flatnotes.mjs'
import { unsupported } from './_helpers.mjs'

const SYSBENCH_SCRIPT = fileURLToPath(new URL('../builtin/sysbench.mjs', import.meta.url))

const sysbench = {
  id: 'sysbench',
  title: 'sysbench (JavaScript port)',
  builtin: true,
  match: (repo) => /(^|\/)(nomad-)?sysbench$/.test(repo),
  async resolve() {
    const digest = createHash('sha256').update(await readFile(SYSBENCH_SCRIPT)).digest('hex')
    // The native digest is listed first so NOMAD reports it (not the upstream image digest)
    // as the benchmark's provenance.
    return { version: 'js', key: digest, repoDigests: [`nomad-native/sysbench-js@sha256:${digest}`] }
  },
  async install() {},
  async launch(ctx) {
    const cmd = ctx.cmd.length ? ctx.cmd : ['sysbench', '--help']
    return {
      command: ctx.nodePath,
      args: [SYSBENCH_SCRIPT, ...cmd],
      env: { SYSBENCH_WORKDIR: ctx.container.dataDir },
      cwd: ctx.container.dataDir,
    }
  },
}

// Apps that have no native build for this platform, with a short reason shown to the user.
const UNSUPPORTED = {
  'vaultwarden/server': 'Vaultwarden has no Windows build',
  'ghcr.io/stirling-tools/s-pdf': 'Stirling PDF is not yet packaged for the native edition',
  'linuxserver/calibre-web': 'Calibre-Web is not yet packaged for the native edition',
  'ghcr.io/sysadminsmedia/homebox': 'Homebox is not yet packaged for the native edition',
  'jellyfin/jellyfin': 'install Jellyfin for Windows from jellyfin.org and add it as a custom link',
  'treehouses/kolibri': 'use "Education Platform (Gen 2)" instead',
}

export const RECIPES = [kiwix, qdrant, ollama, staticWeb, filebrowser, kolibri, flatnotes, sysbench]

export function findRecipe(repo) {
  const recipe = RECIPES.find((r) => r.match(repo))
  if (recipe) return recipe
  if (UNSUPPORTED[repo]) throw unsupported(repo, UNSUPPORTED[repo])
  throw unsupported(repo, 'only the apps in the NOMAD catalog can be installed without Docker')
}

export function getRecipe(id) {
  return RECIPES.find((r) => r.id === id) ?? null
}

export function supportInfo() {
  return {
    supported: RECIPES.map((r) => r.id),
    unsupported: UNSUPPORTED,
  }
}

/** True if `repo` can be pulled natively (used by the admin to hide unsupported catalog apps). */
export function isSupported(repo) {
  return RECIPES.some((r) => r.match(repo))
}
