#!/usr/bin/env node
// Generate the Windows installer branding from the NOMAD logo:
//   native/installer/windows/nomad.ico     multi-size icon (32-bit DIB entries, 16–256 px)
//   native/installer/windows/welcome.bmp   164×314 welcome/finish panel
//   native/installer/windows/header.bmp    150×57 page header
// Uses sharp from admin/node_modules. Outputs are committed; rerun only when the logo changes.
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const require = createRequire(path.join(repo, 'admin', 'package.json'))
const sharp = require('sharp')
const out = path.join(repo, 'native', 'installer', 'windows')
const logo = path.join(repo, 'admin', 'public', 'favicon-512x512.png')
const fullLogo = path.join(repo, 'admin', 'public', 'project_nomad_logo.webp')
const BG = { r: 247, g: 238, b: 220 } // NOMAD desert tan

async function rgba(size) {
  return sharp(logo).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer()
}

function dibEntry(size, pixels) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR + AND masks
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4 // bottom-up rows
      const dst = (y * size + x) * 4
      xor[dst] = pixels[src + 2]
      xor[dst + 1] = pixels[src + 1]
      xor[dst + 2] = pixels[src]
      xor[dst + 3] = pixels[src + 3]
    }
  }
  const andRow = Math.ceil(size / 32) * 4
  const and = Buffer.alloc(andRow * size) // all zero: alpha channel carries transparency
  header.writeUInt32LE(xor.length + and.length, 20)
  return Buffer.concat([header, xor, and])
}

async function makeIco(sizes) {
  const images = []
  for (const s of sizes) images.push(dibEntry(s, await rgba(s)))
  const dir = Buffer.alloc(6 + 16 * sizes.length)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(sizes.length, 4)
  let offset = dir.length
  sizes.forEach((s, i) => {
    const e = 6 + i * 16
    dir[e] = s >= 256 ? 0 : s
    dir[e + 1] = s >= 256 ? 0 : s
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(images[i].length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += images[i].length
  })
  return Buffer.concat([dir, ...images])
}

/** 24-bit bottom-up BMP (what NSIS's Modern UI expects for its panels). */
function bmp24(width, height, rgb) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const data = Buffer.alloc(rowSize * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = ((height - 1 - y) * width + x) * 3
      const dst = y * rowSize + x * 3
      data[dst] = rgb[src + 2]
      data[dst + 1] = rgb[src + 1]
      data[dst + 2] = rgb[src]
    }
  }
  const header = Buffer.alloc(54)
  header.write('BM', 0)
  header.writeUInt32LE(54 + data.length, 2)
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(width, 18)
  header.writeInt32LE(height, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  header.writeUInt32LE(data.length, 34)
  return Buffer.concat([header, data])
}

async function panel(width, height, logoSize, left, top, source = logo) {
  const logoPng = await sharp(source).resize(logoSize, logoSize, { fit: 'contain', background: { ...BG, alpha: 1 } }).png().toBuffer()
  const raw = await sharp({ create: { width, height, channels: 3, background: BG } })
    .composite([{ input: logoPng, left, top }])
    .removeAlpha()
    .raw()
    .toBuffer()
  return bmp24(width, height, raw)
}

await writeFile(path.join(out, 'nomad.ico'), await makeIco([16, 24, 32, 48, 64, 128, 256]))
await writeFile(path.join(out, 'welcome.bmp'), await panel(164, 314, 144, 10, 36, fullLogo))
await writeFile(path.join(out, 'header.bmp'), await panel(150, 57, 49, 97, 4))
console.log(`Wrote nomad.ico, welcome.bmp and header.bmp to ${out}`)
