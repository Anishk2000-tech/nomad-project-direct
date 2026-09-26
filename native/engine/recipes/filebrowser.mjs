// File Browser. A single Go binary with official Windows and Linux builds on GitHub.
import { exe, isWin } from '../lib/util.mjs'
import { githubAssetUrl, requireFile, resolveGithubTag } from './_helpers.mjs'

const REPO = 'filebrowser/filebrowser'

function assetName() {
  if (isWin) return 'windows-amd64-filebrowser.zip'
  return process.arch === 'arm64' ? 'linux-arm64-filebrowser.tar.gz' : 'linux-amd64-filebrowser.tar.gz'
}

export default {
  id: 'filebrowser',
  title: 'File Browser',
  match: (repo) => repo === 'filebrowser/filebrowser',

  async resolve({ tag }) {
    const asset = assetName()
    const release = await resolveGithubTag(REPO, tag, { assetFor: () => asset })
    return { version: release.replace(/^v/, ''), key: `${release}/${asset}`, url: githubAssetUrl(REPO, release, asset) }
  },

  async install(ctx, resolved) {
    const archive = await ctx.fetch(resolved.url, resolved.key.replace('/', '_'))
    await ctx.extract(archive, ctx.dir)
  },

  async launch(ctx) {
    const bin = await requireFile(ctx.image.dir, [exe('filebrowser')], 'filebrowser')
    const args = ctx.translateArgs(ctx.cmd)
    if (!args.includes('--port') && !args.some((a) => a.startsWith('--port=') || a === '-p')) {
      args.push('--port', String(ctx.hostPort(80) ?? 8080))
    }
    if (!args.includes('--address') && !args.some((a) => a.startsWith('--address=') || a === '-a')) {
      args.push('--address', '0.0.0.0')
    }
    return { command: bin, args, cwd: ctx.container.dataDir }
  },
}
