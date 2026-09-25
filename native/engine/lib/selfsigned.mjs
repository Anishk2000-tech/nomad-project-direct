// Pure-JS self-signed X.509 certificate generation (RSA-2048, SHA-256), replacing
// `openssl req -x509 ...`, which Windows doesn't ship. Produces PEM cert + PKCS#8 key.
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto'
import { mkdir, writeFile, chmod, access } from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'

function len(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body])
const seq = (...items) => tlv(0x30, Buffer.concat(items))
const set = (...items) => tlv(0x31, Buffer.concat(items))

function int(buf) {
  let b = Buffer.from(buf)
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b])
  return tlv(0x02, b)
}

function oid(str) {
  const parts = str.split('.').map(Number)
  const out = [40 * parts[0] + parts[1]]
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f]
    let v = p >> 7
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80)
      v >>= 7
    }
    out.push(...stack)
  }
  return tlv(0x06, Buffer.from(out))
}

function time(date) {
  const pad = (n) => String(n).padStart(2, '0')
  const y = date.getUTCFullYear()
  const body = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  return y < 2050 ? tlv(0x17, Buffer.from(String(y).slice(2) + body)) : tlv(0x18, Buffer.from(String(y) + body))
}

const name = (cn) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))))

function ipBytes(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number))
  const full = ip.includes('::') ? expandV6(ip) : ip
  return Buffer.from(full.split(':').flatMap((h) => [parseInt(h, 16) >> 8, parseInt(h, 16) & 0xff]))
}

function expandV6(ip) {
  const [a, b] = ip.split('::')
  const left = a ? a.split(':') : []
  const right = b ? b.split(':') : []
  return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].join(':')
}

export function createSelfSignedCert({ commonName = 'Project NOMAD', dnsNames = ['nomad', 'localhost'], ipAddresses = ['127.0.0.1'], days = 3650 } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const sigAlg = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]))
  const notBefore = new Date(Date.now() - 60_000)
  const notAfter = new Date(notBefore.getTime() + days * 86400_000)

  const altNames = seq(
    ...dnsNames.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))),
    ...ipAddresses.filter((ip) => net.isIP(ip)).map((ip) => tlv(0x87, ipBytes(ip)))
  )
  const extensions = tlv(
    0xa3,
    seq(
      seq(oid('2.5.29.19'), tlv(0x04, seq())), // basicConstraints: CA=false
      seq(oid('2.5.29.17'), tlv(0x04, altNames))
    )
  )

  const serial = randomBytes(16)
  serial[0] &= 0x7f
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(serial),
    sigAlg,
    name(commonName),
    seq(time(notBefore), time(notAfter)),
    name(commonName),
    spki,
    extensions
  )
  const signature = sign('sha256', tbs, privateKey)
  const cert = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])))

  const pem = (label, der) =>
    `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`
  return {
    cert: pem('CERTIFICATE', cert),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }
}

/** Write cert.pem/key.pem into `dir` unless both already exist. Mirrors DockerService._ensureSelfSignedCert. */
export async function ensureSelfSignedCert(dir, commonName, { certFile = 'cert.pem', keyFile = 'key.pem' } = {}) {
  const certPath = path.join(dir, certFile)
  const keyPath = path.join(dir, keyFile)
  const exists = async (p) => access(p).then(() => true, () => false)
  if ((await exists(certPath)) && (await exists(keyPath))) return { certPath, keyPath, created: false }
  await mkdir(dir, { recursive: true })
  const { cert, key } = createSelfSignedCert({ commonName })
  await writeFile(keyPath, key)
  await writeFile(certPath, cert)
  await chmod(keyPath, 0o600).catch(() => {})
  return { certPath, keyPath, created: true }
}
