/**
 * ZIM archive access for NOMAD. Uses the native `@openzim/libzim` binding when it loads (the
 * Docker image builds it for Linux) and falls back to the pure-TypeScript reader in
 * ./zim_reader.ts otherwise — the Windows native edition, where no libzim binary exists.
 * Set NOMAD_ZIM_READER=js to force the fallback.
 */
import { Archive as JsArchive } from './zim_reader.js'

export interface ZimBlob {
  data: Buffer
  size: number | bigint
}

export interface ZimItem {
  path: string
  title: string
  mimetype: string
  data: ZimBlob
}

export interface ZimEntry {
  path: string
  title: string
  isRedirect: boolean
  item: ZimItem
}

export interface ZimArchive {
  uuid: string
  filesize: bigint | number
  articleCount: number
  mediaCount: number
  illustrationSizes: Set<number>
  getMetadata(name: string): string
  getIllustrationItem(size?: number): ZimItem
  iterByPath(): Iterable<ZimEntry>
}

type ArchiveCtor = new (path: string) => ZimArchive

async function loadArchiveImpl(): Promise<{ impl: ArchiveCtor; kind: 'native' | 'js' }> {
  if (process.env.NOMAD_ZIM_READER === 'js') return { impl: JsArchive, kind: 'js' }
  try {
    // A variable specifier keeps TypeScript from requiring the optional native package.
    const specifier = '@openzim/libzim'
    const mod = await import(specifier)
    if (typeof mod.Archive === 'function') return { impl: mod.Archive as ArchiveCtor, kind: 'native' }
  } catch {
    // Binding not built for this platform — use the JS reader.
  }
  return { impl: JsArchive, kind: 'js' }
}

const loaded = await loadArchiveImpl()

/** Which implementation is active ('native' libzim or the 'js' fallback). */
export const zimReaderKind = loaded.kind

export const Archive: ArchiveCtor = loaded.impl
export type Archive = ZimArchive
