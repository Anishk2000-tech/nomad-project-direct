#!/usr/bin/env node
// Tiny static file server used to run NOMAD's static web apps natively (in place of nginx).
//   node static-server.mjs --root <dir> --port <n> [--spa] [--index <file>]
//                          [--tls-cert <pem> --tls-key <pem> [--tls-generate]]
import http from 'node:http'
import https from 'node:https'
import { createReadStream } from 'node:fs'
import { readFile, stat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { ensureSelfSignedCert } from './selfsigned.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
}

function parseArgs() {
  const a = process.argv.slice(2)
  const o = { spa: false, tlsGenerate: false }
  for (let i = 0; i < a.length; i++) {
    const k = a[i]
    if (k === '--spa') o.spa = true
    else if (k === '--tls-generate') o.tlsGenerate = true
    else if (k.startsWith('--')) o[k.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = a[++i]
  }
  return o
}

async function pickIndex(root, preferred) {
  if (preferred) return preferred
  try {
    await stat(path.join(root, 'index.html'))
    return 'index.html'
  } catch {}
  const html = (await readdir(root)).filter((f) => /\.html?$/i.test(f)).sort()
  return html[0] || 'index.html'
}

async function main() {
  const opts = parseArgs()
  const root = path.resolve(opts.root || '.')
  const port = Number(opts.port || 8080)
  const index = await pickIndex(root, opts.index)

  async function resolveFile(urlPath) {
    let rel
    try {
      rel = decodeURIComponent(urlPath.split('?')[0])
    } catch {
      return null
    }
    const target = path.resolve(root, '.' + path.posix.normalize('/' + rel))
    if (target !== root && !target.startsWith(root + path.sep)) return null
    try {
      const st = await stat(target)
      if (st.isDirectory()) {
        const idx = path.join(target, 'index.html')
        const ist = await stat(idx).catch(() => null)
        if (ist?.isFile()) return { file: idx, size: ist.size, mtime: ist.mtime }
        if (target === root) {
          const rst = await stat(path.join(root, index)).catch(() => null)
          if (rst) return { file: path.join(root, index), size: rst.size, mtime: rst.mtime }
        }
        return null
      }
      return { file: target, size: st.size, mtime: st.mtime }
    } catch {
      return null
    }
  }

  const handler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    let found = await resolveFile(req.url || '/')
    const looksLikeAsset = /\.[a-z0-9]+$/i.test((req.url || '').split('?')[0])
    if (!found && opts.spa && !looksLikeAsset) found = await resolveFile('/' + index)
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    const ext = path.extname(found.file).toLowerCase()
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Last-Modified': found.mtime.toUTCString(),
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
    if (range && found.size > 0) {
      const start = range[1] ? Number(range[1]) : Math.max(0, found.size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), found.size - 1) : found.size - 1
      if (start > end || start >= found.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${found.size}` }).end()
        return
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${found.size}`, 'Content-Length': end - start + 1 })
      if (req.method === 'HEAD') return res.end()
      createReadStream(found.file, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { ...headers, 'Content-Length': found.size })
    if (req.method === 'HEAD') return res.end()
    createReadStream(found.file).on('error', () => res.destroy()).pipe(res)
  }

  let server
  if (opts.tlsCert && opts.tlsKey) {
    if (opts.tlsGenerate) {
      const dir = path.dirname(opts.tlsCert)
      await ensureSelfSignedCert(dir, 'Project NOMAD', {
        certFile: path.basename(opts.tlsCert),
        keyFile: path.basename(opts.tlsKey),
      })
    }
    server = https.createServer({ cert: await readFile(opts.tlsCert), key: await readFile(opts.tlsKey) }, handler)
  } else {
    server = http.createServer(handler)
  }
  server.listen(port, '0.0.0.0', () => {
    console.log(`Serving ${root} on ${opts.tlsCert ? 'https' : 'http'}://0.0.0.0:${port} (index: ${index}${opts.spa ? ', spa' : ''})`)
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exit(1)
})
