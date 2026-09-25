// Integration test for the native engine, driven through the real dockerode client exactly as
// the admin app uses it. Run: node native/test/engine.test.mjs [--network]
//   --network  also pulls images that need internet access (static web app, Qdrant)
// Env: NOMAD_ENGINE_OVERRIDE_KIWIX_SERVE=<dir with kiwix-serve> enables the Kiwix scenario.
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { startEngine } from '../engine/index.mjs'
import { Logger, sleep } from '../engine/lib/util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const require = createRequire(path.join(repoRoot, 'admin', 'package.json'))
const Docker = require('dockerode')
const withNetwork = process.argv.includes('--network')

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

async function httpGet(url, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      return { status: res.status, text: await res.text() }
    } catch (err) {
      lastErr = err
      await sleep(300)
    }
  }
  throw lastErr
}

function pull(docker, ref) {
  return new Promise((resolve, reject) => {
    docker.pull(ref, (err, stream) => {
      if (err) return reject(err)
      docker.modem.followProgress(stream, (e, out) => {
        const inStream = out?.find((o) => o.error)
        if (e || inStream) reject(e || new Error(inStream.error))
        else resolve(out)
      })
    })
  })
}

const results = []
async function step(name, fn) {
  const t0 = Date.now()
  try {
    await fn()
    results.push({ name, ok: true, ms: Date.now() - t0 })
    console.log(`  ✔ ${name} (${Date.now() - t0} ms)`)
  } catch (err) {
    results.push({ name, ok: false, err })
    console.log(`  ✘ ${name}\n      ${err.stack?.split('\n').slice(0, 4).join('\n      ')}`)
  }
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'nomad-engine-test-'))
const home = path.join(tmp, 'engine')
const storage = path.join(tmp, 'storage')
await mkdir(storage, { recursive: true })
const token = 'test-token-123'
const port = await freePort()
const logger = new Logger('engine', process.env.NOMAD_LOG_LEVEL || 'warn')
let engine = await startEngine({ home, storageRoot: storage, port, token, logger })
const docker = new Docker({ host: '127.0.0.1', port, protocol: 'http', headers: { Authorization: `Bearer ${token}` } })

console.log(`Engine test (home=${home})`)

await step('rejects requests without the engine token', async () => {
  const anon = new Docker({ host: '127.0.0.1', port, protocol: 'http' })
  await assert.rejects(anon.info(), /401/)
})

await step('info/version look like a Docker daemon', async () => {
  const info = await docker.info()
  assert.equal(info.Driver, 'nomad-native')
  assert.ok(info.Runtimes.native)
  assert.ok(info.OperatingSystem)
  const v = await docker.version()
  assert.match(v.Version, /nomad-native/)
})

const SYSBENCH_IMAGE = 'ghcr.io/crosstalk-solutions/nomad-sysbench@sha256:1f08e527f5d440135de9bd49006a2c13342cb1e483c59a53774e2db35e8e13f0'

await step('benchmark flow: inspect→pull→create→start→wait→logs→remove', async () => {
  await assert.rejects(docker.getImage(SYSBENCH_IMAGE).inspect(), /404/)
  await pull(docker, SYSBENCH_IMAGE)
  const info = await docker.getImage(SYSBENCH_IMAGE).inspect()
  const digest = info.RepoDigests.find((d) => d.includes('@sha256:')).split('@')[1]
  assert.notEqual(digest, 'sha256:1f08e527f5d440135de9bd49006a2c13342cb1e483c59a53774e2db35e8e13f0', 'native build must not claim the upstream digest')
  const container = await docker.createContainer({
    Image: SYSBENCH_IMAGE,
    Cmd: ['sysbench', 'cpu', '--cpu-max-prime=2000', '--threads=2', '--time=1', 'run'],
    name: `nomad_benchmark_sysbench_${Date.now()}`,
    Tty: true,
    HostConfig: { AutoRemove: false },
  })
  await container.start()
  await container.wait()
  const logs = await container.logs({ stdout: true, stderr: true })
  const output = logs.toString('utf8').replace(/[\x00-\x08]/g, '').trim()
  assert.match(output, /events per second:\s*[\d.]+/)
  await container.remove()
  await assert.rejects(container.inspect(), /404/)
})

await step('sysbench fileio via sh -c chain', async () => {
  const c = await docker.createContainer({
    Image: SYSBENCH_IMAGE,
    Cmd: ['sh', '-c', 'sysbench fileio --file-total-size=8M --file-num=2 prepare && sysbench fileio --file-total-size=8M --file-num=2 --file-test-mode=seqwr --file-extra-flags=direct --time=1 run && sysbench fileio --file-total-size=8M --file-num=2 cleanup'],
    name: `nomad_benchmark_sysbench_fio_${Date.now()}`,
    Tty: true,
  })
  await c.start()
  const w = await c.wait()
  assert.equal(w.StatusCode, 0)
  const out = (await c.logs({ stdout: true, stderr: true })).toString()
  assert.match(out, /written,\s*MiB\/s:\s*[\d.]+/)
  await c.remove({ force: true })
})

await step('lifecycle: start/stop/restart/rename/update/list/stats/logs (non-tty mux)', async () => {
  const c = await docker.createContainer({
    Image: SYSBENCH_IMAGE,
    Cmd: ['sysbench', 'cpu', '--threads=1', '--time=600', 'run'],
    name: 'nomad_lifecycle',
    HostConfig: { RestartPolicy: { Name: 'no' } },
  })
  await c.start()
  await assert.rejects(c.start(), /304|already started/)
  let list = await docker.listContainers({ all: false })
  assert.ok(list.find((x) => x.Names.includes('/nomad_lifecycle')))
  assert.equal(list.find((x) => x.Names.includes('/nomad_lifecycle')).State, 'running')
  const stats = await c.stats({ stream: false })
  assert.ok(stats.memory_stats.usage > 0, 'memory usage reported')
  await c.rename({ name: 'nomad_lifecycle_old' })
  assert.equal((await c.inspect()).Name, '/nomad_lifecycle_old')
  await c.rename({ name: 'nomad_lifecycle' })
  await c.update({ RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } })
  assert.equal((await c.inspect()).HostConfig.RestartPolicy.Name, 'unless-stopped')
  await c.restart()
  assert.equal((await c.inspect()).State.Running, true)
  await c.stop()
  await assert.rejects(c.stop(), /304|already stopped/)
  const st = await c.inspect()
  assert.equal(st.State.Running, false)
  list = await docker.listContainers({ all: true })
  assert.equal(list.find((x) => x.Names.includes('/nomad_lifecycle')).State, 'exited')
  const buf = await c.logs({ stdout: true, stderr: true, tail: 50 })
  assert.equal(buf[0] === 1 || buf[0] === 2, true, 'non-tty logs are multiplexed')
  await assert.rejects(docker.createContainer({ Image: SYSBENCH_IMAGE, name: 'nomad_lifecycle' }), /409|already in use/)
  await c.remove()
})

await step('restart policy: crash loop is restarted with backoff', async () => {
  const c = await docker.createContainer({
    Image: SYSBENCH_IMAGE,
    Cmd: ['sysbench', 'bogus-test', 'run'],
    name: 'nomad_crashloop',
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
  })
  await c.start()
  await sleep(2500)
  const i = await c.inspect()
  assert.ok(i.RestartCount >= 1, `expected restarts, got ${i.RestartCount}`)
  await c.stop().catch(() => {})
  await c.remove({ force: true })
})

await step('port conflict produces Docker\'s "port is already allocated" error', async () => {
  const busyPort = await freePort()
  const blocker = net.createServer().listen(busyPort, '0.0.0.0')
  await new Promise((r) => blocker.once('listening', r))
  await pull(docker, 'ghcr.io/kiwix/kiwix-serve:3.8.1').catch(() => {})
  const img = (await docker.listImages()).find((i) => i.RepoTags.includes('ghcr.io/kiwix/kiwix-serve:3.8.1'))
  const image = img ? 'ghcr.io/kiwix/kiwix-serve:3.8.1' : SYSBENCH_IMAGE
  const c = await docker.createContainer({
    Image: image,
    name: 'nomad_portclash',
    HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: String(busyPort) }] } },
    ExposedPorts: { '8080/tcp': {} },
  })
  await assert.rejects(c.start(), /port is already allocated/)
  blocker.close()
  await c.remove({ force: true })
})

await step('exec: allowlisted command runs, anything else is refused', async () => {
  const c = await docker.createContainer({ Image: SYSBENCH_IMAGE, Cmd: ['sysbench', 'cpu', '--time=30', 'run'], name: 'nomad_exec' })
  await c.start()
  await assert.rejects(c.exec({ Cmd: ['cmd.exe', '/c', 'whoami'], AttachStdout: true }), /403|not permitted/)
  const exec = await c.exec({ Cmd: ['nvidia-smi', '--query-gpu=name', '--format=csv'], AttachStdout: true, AttachStderr: true, Tty: true })
  const stream = await exec.start({ Tty: true })
  await new Promise((resolve) => {
    stream.on('data', () => {})
    stream.on('end', resolve)
  })
  await c.remove({ force: true })
})

await step('unsupported app: pull fails with an explanatory message (as DockerService.pullImage sees it)', async () => {
  const pullImage = async (imageName) => {
    const pullStream = await docker.pull(imageName)
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(pullStream, (error) => (error ? reject(error) : resolve()))
    })
  }
  await assert.rejects(pullImage('vaultwarden/server:1.36.0'), /not available in the native .*Vaultwarden has no Windows build/)
})

await step('binds outside the storage folder are rejected', async () => {
  await assert.rejects(
    docker.createContainer({ Image: SYSBENCH_IMAGE, name: 'nomad_badbind', HostConfig: { Binds: [`${os.tmpdir()}:/data`] } }),
    /outside the NOMAD storage folder/
  )
})

if (process.env.NOMAD_ENGINE_OVERRIDE_KIWIX_SERVE) {
  await step('kiwix: seeded config serves the bundled ZIM from a relative-path library', async () => {
    const zimDir = path.join(storage, 'zim')
    await mkdir(zimDir, { recursive: true })
    const zim = 'wikipedia_en_100_mini_2026-01.zim'
    await copyFile(path.join(repoRoot, 'install', zim), path.join(zimDir, zim))
    await writeFile(
      path.join(zimDir, 'kiwix-library.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<library version="20110515">\n  <book id="f33283c0-0d00-3ceb-20ba-69d9b793a4dd" path="${zim}" title="Wikipedia 100"/>\n</library>\n`
    )
    await pull(docker, 'ghcr.io/kiwix/kiwix-serve:3.8.1')
    const kport = await freePort()
    const c = await docker.createContainer({
      Image: 'ghcr.io/kiwix/kiwix-serve:3.8.1',
      name: 'nomad_kiwix_server',
      Cmd: '--library /data/kiwix-library.xml --monitorLibrary'.split(' '),
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        Binds: [`${storage}/zim:/data`],
        PortBindings: { '8080/tcp': [{ HostPort: String(kport) }] },
      },
      ExposedPorts: { '8080/tcp': {} },
    })
    await c.start()
    const res = await httpGet(`http://127.0.0.1:${kport}/catalog/v2/entries`)
    assert.equal(res.status, 200)
    assert.match(res.text, /f33283c0-0d00-3ceb-20ba-69d9b793a4dd|Wikipedia/)
    // Persistence: an unless-stopped container comes back after an engine restart.
    await engine.close()
    engine = await startEngine({ home, storageRoot: storage, port, token, logger })
    const again = await httpGet(`http://127.0.0.1:${kport}/catalog/v2/entries`, { timeoutMs: 20000 })
    assert.equal(again.status, 200)
    await docker.getContainer('nomad_kiwix_server').remove({ force: true })
  })
}

if (withNetwork) {
  await step('static web app pulled from its image (Excalidraw) and served natively', async () => {
    await pull(docker, 'excalidraw/excalidraw:sha-4bfc5bb')
    const wport = await freePort()
    const c = await docker.createContainer({
      Image: 'excalidraw/excalidraw:sha-4bfc5bb',
      name: 'nomad_excalidraw',
      HostConfig: { PortBindings: { '80/tcp': [{ HostPort: String(wport) }] } },
      ExposedPorts: { '80/tcp': {} },
    })
    await c.start()
    const res = await httpGet(`http://127.0.0.1:${wport}/`)
    assert.equal(res.status, 200)
    assert.match(res.text, /<html/i)
    await c.remove({ force: true })
  })

  await step('qdrant pulled and answering on its HTTP port', async () => {
    await pull(docker, 'qdrant/qdrant:v1.16')
    const qport = await freePort()
    const gport = await freePort()
    const c = await docker.createContainer({
      Image: 'qdrant/qdrant:v1.16',
      name: 'nomad_qdrant',
      HostConfig: {
        Binds: [`${storage}/qdrant:/qdrant/storage`],
        PortBindings: { '6333/tcp': [{ HostPort: String(qport) }], '6334/tcp': [{ HostPort: String(gport) }] },
      },
      Env: ['QDRANT__TELEMETRY_DISABLED=true'],
    })
    await c.start()
    const res = await httpGet(`http://127.0.0.1:${qport}/`, { timeoutMs: 30000 })
    assert.equal(res.status, 200)
    assert.match(res.text, /qdrant/i)
    await c.remove({ force: true })
  })
}

await engine.close()
await rm(tmp, { recursive: true, force: true }).catch(() => {})
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
