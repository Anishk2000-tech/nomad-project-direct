// Kolibri (Education Platform). Kolibri is a pure-Python wheel on PyPI that officially supports
// Windows, so we install the exact version the image pins into a portable Python runtime.
import path from 'node:path'
import { fetchJson } from '../lib/download.mjs'
import { EngineError } from '../lib/util.mjs'
import { ensurePython, pipInstall } from './_helpers.mjs'

export default {
  id: 'kolibri',
  title: 'Kolibri',
  match: (repo) => repo === 'learningequality/kolibri',

  async resolve({ tag }) {
    const version = String(tag).replace(/^v/, '')
    if (!/^\d+\.\d+/.test(version)) {
      const info = await fetchJson('https://pypi.org/pypi/kolibri/json')
      return { version: info.info.version, key: `kolibri==${info.info.version}` }
    }
    try {
      await fetchJson(`https://pypi.org/pypi/kolibri/${version}/json`)
    } catch (err) {
      throw new EngineError(err.status === 404 ? 404 : 502, `Kolibri ${version} is not available on PyPI (${err.message})`)
    }
    return { version, key: `kolibri==${version}` }
  },

  async install(ctx, resolved) {
    const python = await ensurePython(ctx)
    await pipInstall(ctx, python, path.join(ctx.dir, 'site-packages'), [resolved.key])
    ctx.meta.python = python
  },

  async launch(ctx) {
    const python = ctx.image.meta.python
    const home = ctx.hostPath('/kolibri')
    const port = ctx.hostPort(8080) ?? 8080
    const zipPort = ctx.env.KOLIBRI_ZIP_CONTENT_PORT || String(ctx.hostPort(8081) ?? 8081)
    return {
      command: python,
      args: ['-m', 'kolibri', 'start', '--foreground', `--port=${port}`, `--zip-port=${zipPort}`],
      env: {
        PYTHONPATH: path.join(ctx.image.dir, 'site-packages'),
        PYTHONUNBUFFERED: '1',
        PYTHONUTF8: '1',
        KOLIBRI_HOME: home,
        KOLIBRI_HTTP_PORT: String(port),
        KOLIBRI_ZIP_CONTENT_PORT: zipPort,
      },
      cwd: ctx.container.dataDir,
      mkdirs: [home],
    }
  },
}
