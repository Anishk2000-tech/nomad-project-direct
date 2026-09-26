// Qdrant vector database (Knowledge Base). Windows: the official MSVC build from GitHub
// releases. Linux: the binary taken from the qdrant/qdrant image itself.
import { resolveManifest } from '../lib/oci.mjs'
import { exe, isWin } from '../lib/util.mjs'
import { githubAssetUrl, requireFile, resolveGithubTag } from './_helpers.mjs'

const REPO = 'qdrant/qdrant'
const WIN_ASSET = 'qdrant-x86_64-pc-windows-msvc.zip'

export default {
  id: 'qdrant',
  title: 'Qdrant',
  match: (repo) => repo === 'qdrant/qdrant',

  async resolve({ tag, ref }) {
    if (isWin) {
      const release = await resolveGithubTag(REPO, tag, { assetFor: () => WIN_ASSET })
      return { version: release.replace(/^v/, ''), key: `${release}/${WIN_ASSET}`, url: githubAssetUrl(REPO, release, WIN_ASSET) }
    }
    const { digest } = await resolveManifest(ref)
    return { version: String(tag).replace(/^v/, ''), key: digest, oci: ref }
  },

  async install(ctx, resolved) {
    if (resolved.url) {
      const archive = await ctx.fetch(resolved.url, resolved.key.replace('/', '_'))
      await ctx.extract(archive, ctx.dir)
      return
    }
    await ctx.oci(resolved.oci, ctx.dir, (rel) => (rel === 'qdrant/qdrant' ? 'qdrant' : null))
  },

  async launch(ctx) {
    const bin = await requireFile(ctx.image.dir, [exe('qdrant')], 'qdrant')
    const env = {
      QDRANT__STORAGE__STORAGE_PATH: ctx.hostPath('/qdrant/storage'),
      QDRANT__STORAGE__SNAPSHOTS_PATH: ctx.hostPath('/qdrant/snapshots'),
      QDRANT__SERVICE__HOST: '0.0.0.0',
      QDRANT__SERVICE__HTTP_PORT: String(ctx.hostPort(6333) ?? 6333),
      QDRANT__SERVICE__GRPC_PORT: String(ctx.hostPort(6334) ?? 6334),
      QDRANT__TELEMETRY_DISABLED: 'true',
    }
    return { command: bin, args: [], env, cwd: ctx.container.dataDir, mkdirs: [env.QDRANT__STORAGE__STORAGE_PATH] }
  },
}
