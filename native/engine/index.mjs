// NOMAD native engine entry point. Used in-process by the Windows service supervisor, or
// standalone for development:  node native/engine/index.mjs --home <dir> --storage <dir> [--port 2385]
//                                [--seed <folder of bundled downloads>]
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ImageStore } from './images.mjs'
import { ContainerManager } from './containers.mjs'
import { createApiServer, ENGINE_VERSION } from './api.mjs'
import { createLogsUiServer } from './logs-ui.mjs'
import { ensureDir, Logger } from './lib/util.mjs'

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * Start the engine. Returns { images, containers, close() }.
 *   home          engine state folder (images, containers, caches)
 *   storageRoot   NOMAD storage folder; bind mounts must stay inside it
 *   token         shared secret required on every API request ('' disables auth — dev only)
 *   logsUi        { port, systemLogs: [{ name, file }] } — optional read-only log viewer
 */
export async function startEngine({
  home,
  storageRoot,
  port = 2385,
  host = '127.0.0.1',
  token = '',
  restrictBinds = true,
  logger = new Logger('engine'),
  logsUi = null,
  onShutdownRequest = null,
  restore = true,
  seedDir = null,
}) {
  await ensureDir(home)
  const images = new ImageStore({ home, logger, seedDir })
  await images.load()
  const containers = new ContainerManager({
    home,
    images,
    logger,
    storageRoot,
    restrictBinds,
    nodePath: process.execPath,
    engineDir: ENGINE_DIR,
  })
  await containers.load()

  const engine = { images, containers, token, logger, home, storageRoot, onShutdownRequest }
  const server = createApiServer(engine)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  logger.info(`NOMAD native engine ${ENGINE_VERSION} listening on http://${host}:${port}`)

  let uiServer = null
  if (logsUi?.port) {
    uiServer = createLogsUiServer({ containers, systemLogs: logsUi.systemLogs || [], logger })
    await new Promise((resolve) => {
      uiServer.once('error', (err) => {
        logger.warn(`Log viewer not started on port ${logsUi.port}: ${err.message}`)
        uiServer = null
        resolve()
      })
      uiServer.listen(logsUi.port, logsUi.host || '0.0.0.0', resolve)
    })
  }

  if (restore) await containers.restore()

  return {
    images,
    containers,
    async close() {
      await containers.shutdown()
      await new Promise((r) => server.close(r))
      if (uiServer) await new Promise((r) => uiServer.close(r))
      server.closeAllConnections?.()
    },
  }
}

// Standalone mode.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
  )
  const home = path.resolve(args.home || './nomad-native-home')
  const engine = await startEngine({
    home,
    storageRoot: path.resolve(args.storage || path.join(home, 'storage')),
    port: Number(args.port || 2385),
    token: args.token ?? process.env.NOMAD_ENGINE_TOKEN ?? '',
    logsUi: args['logs-port'] ? { port: Number(args['logs-port']) } : null,
    seedDir: args.seed ? path.resolve(args.seed) : null,
  })
  const stop = async () => {
    await engine.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
