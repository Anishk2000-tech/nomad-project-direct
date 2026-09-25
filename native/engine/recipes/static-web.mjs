// Static single-page apps that NOMAD ships as nginx images (CyberChef, IT-Tools, Excalidraw,
// Meshtastic Web, MeshCore Web). Natively we take the built web root straight out of the pinned
// image and serve it with the engine's own static server — same files, no nginx, no Docker.
import path from 'node:path'
import { rename, rm, readdir } from 'node:fs/promises'
import { resolveManifest } from '../lib/oci.mjs'
import { EngineError, pathExists } from '../lib/util.mjs'

const APPS = {
  'ghcr.io/gchq/cyberchef': { port: 80 },
  'ghcr.io/corentinth/it-tools': { port: 80, spa: true },
  'excalidraw/excalidraw': { port: 80, spa: true },
  'ghcr.io/meshtastic/web': { port: 8080, spa: true },
  'ghcr.io/axistem-dev/meshcore-web': { port: 443, spa: true, tls: true },
}

// Where nginx/caddy based images keep their document root.
const WEB_ROOTS = [
  'usr/share/nginx/html',
  'usr/share/caddy',
  'var/www/html',
  'srv',
  'app/dist',
  'app/public',
  'app',
  'dist',
  'public',
  'html',
]

export default {
  id: 'static-web',
  title: 'Static web app',
  match: (repo) => Object.hasOwn(APPS, repo),

  async resolve({ ref }) {
    const { digest } = await resolveManifest(ref)
    return { version: digest.slice(7, 19), key: digest, oci: ref }
  },

  async install(ctx, resolved) {
    const staging = path.join(ctx.dir, '_image')
    await ctx.oci(resolved.oci, staging, (rel) =>
      WEB_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`)) ? rel : null
    )
    for (const root of WEB_ROOTS) {
      const candidate = path.join(staging, ...root.split('/'))
      if (await pathExists(path.join(candidate, 'index.html'))) {
        await rename(candidate, path.join(ctx.dir, 'www'))
        await rm(staging, { recursive: true, force: true })
        return
      }
    }
    // CyberChef names its entry page CyberChef_vX.html rather than index.html.
    for (const root of WEB_ROOTS) {
      const candidate = path.join(staging, ...root.split('/'))
      const files = await readdir(candidate).catch(() => [])
      if (files.some((f) => /\.html?$/i.test(f))) {
        await rename(candidate, path.join(ctx.dir, 'www'))
        await rm(staging, { recursive: true, force: true })
        return
      }
    }
    throw new EngineError(500, `Could not find the web root inside ${resolved.oci}`)
  },

  async launch(ctx) {
    const app = APPS[ctx.image.repo] ?? { port: 80 }
    const port = ctx.hostPort(app.port) ?? ctx.firstHostPort() ?? app.port
    const args = [ctx.engineFile('lib/static-server.mjs'), '--root', path.join(ctx.image.dir, 'www'), '--port', String(port)]
    if (app.spa) args.push('--spa')
    if (app.tls) {
      args.push('--tls-cert', ctx.hostPath('/certs/cert.pem'), '--tls-key', ctx.hostPath('/certs/key.pem'), '--tls-generate')
    }
    return { command: ctx.nodePath, args, cwd: ctx.container.dataDir }
  },
}
