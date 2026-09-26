// FlatNotes (Notes). The image is a FastAPI server plus a pre-built Vue client under /app.
// Natively: take /app from the pinned image, install its locked dependencies into a portable
// Python, and run the same uvicorn command the image's entrypoint runs.
import path from 'node:path'
import { resolveManifest } from '../lib/oci.mjs'
import { ensurePython, pipInstall, requirementsFromPipfileLock } from './_helpers.mjs'

export default {
  id: 'flatnotes',
  title: 'FlatNotes',
  match: (repo) => repo === 'dullage/flatnotes',

  async resolve({ ref, tag }) {
    const { digest } = await resolveManifest(ref)
    return { version: String(tag).replace(/^v/, ''), key: digest, oci: ref }
  },

  async install(ctx, resolved) {
    await ctx.oci(resolved.oci, ctx.dir, (rel) => (rel === 'app' || rel.startsWith('app/') ? rel : null))
    const requirements = await requirementsFromPipfileLock(path.join(ctx.dir, 'app', 'Pipfile.lock'))
    const python = await ensurePython(ctx)
    await pipInstall(ctx, python, path.join(ctx.dir, 'site-packages'), requirements)
    ctx.meta.python = python
  },

  async launch(ctx) {
    const port = ctx.hostPort(8080) ?? 8080
    const dataDir = ctx.hostPath('/data')
    return {
      command: ctx.image.meta.python,
      args: ['-m', 'uvicorn', 'main:app', '--app-dir', 'server', '--host', '0.0.0.0', '--port', String(port), '--proxy-headers'],
      env: {
        PYTHONPATH: path.join(ctx.image.dir, 'site-packages'),
        PYTHONUNBUFFERED: '1',
        PYTHONUTF8: '1',
        FLATNOTES_PATH: dataDir,
        FLATNOTES_HOST: '0.0.0.0',
        FLATNOTES_PORT: String(port),
      },
      cwd: path.join(ctx.image.dir, 'app'),
      mkdirs: [dataDir],
    }
  },
}
