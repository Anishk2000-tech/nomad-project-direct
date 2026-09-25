// Container manager: Docker container semantics on top of native processes.
//
// A container is persisted as <home>/containers/<id>/container.json (Docker inspect shape) with
// its logs next to it. Starting one asks the image's recipe for a command line, translating the
// container's view of the world (Binds → host folders, PortBindings → listen ports, Env) into
// arguments for the native build. Restart policies behave like Docker's, including
// "unless-stopped" surviving an engine/PC restart.
import path from 'node:path'
import { readdir, lstat, rm, symlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { LogWriter, queryLogs, removeLogs, formatRecord } from './lib/logs.mjs'
import { isPortFree, isSameProcess, killTree, pidAlive, sampleProcessTrees, spawnManaged } from './lib/proc.mjs'
import {
  EngineError,
  ensureDir,
  humanDuration,
  isWin,
  nowIso,
  pathExists,
  randomHex,
  readJson,
  removeWithRetry,
  writeJsonAtomic,
} from './lib/util.mjs'

const LINUX_DEFAULT_STORAGE = '/opt/project-nomad/storage'

// Environment variables a native app may inherit from the engine. Everything else (database
// passwords, APP_KEY, the engine token...) stays out of app processes.
const INHERITED_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'SYSTEMDRIVE', 'windir', 'WINDIR', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'COMPUTERNAME',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'LANG', 'LC_ALL', 'TZ',
  'CUDA_VISIBLE_DEVICES', 'HIP_VISIBLE_DEVICES', 'ROCR_VISIBLE_DEVICES', 'GPU_DEVICE_ORDINAL',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'PIP_CERT', 'REQUESTS_CA_BUNDLE',
]

// Commands `docker exec` may run natively. NOMAD only uses exec to read GPU stats; anything
// broader would let any caller of the engine API run arbitrary programs as the service account.
const EXEC_ALLOWLIST = new Set(['nvidia-smi', 'rocm-smi', 'amd-smi'])

function envListToObject(list = []) {
  const out = {}
  for (const kv of list || []) {
    const i = kv.indexOf('=')
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1)
  }
  return out
}

function baseEnv() {
  const env = {}
  for (const k of INHERITED_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]
  return env
}

function publishedPorts(hostConfig) {
  const out = []
  for (const [key, bindings] of Object.entries(hostConfig?.PortBindings || {})) {
    const [privatePort, proto = 'tcp'] = key.split('/')
    for (const b of bindings || []) {
      const hp = Number(b?.HostPort)
      if (hp) out.push({ privatePort: Number(privatePort), publicPort: hp, proto, ip: b.HostIp || '0.0.0.0' })
    }
  }
  return out
}

export class ContainerManager {
  constructor({ home, images, logger, storageRoot, restrictBinds = true, nodePath = process.execPath, engineDir }) {
    this.home = home
    this.dir = path.join(home, 'containers')
    this.volumesDir = path.join(home, 'volumes')
    this.images = images
    this.log = logger.child('containers')
    this.storageRoot = storageRoot ? path.resolve(storageRoot) : null
    this.restrictBinds = restrictBinds
    this.nodePath = nodePath
    this.engineDir = engineDir
    this.containers = new Map()
    this.runtime = new Map()
    this.execs = new Map()
    this.shuttingDown = false
  }

  // ── persistence ───────────────────────────────────────────────────────────

  async load() {
    await ensureDir(this.dir)
    for (const id of await readdir(this.dir).catch(() => [])) {
      const c = await readJson(path.join(this.dir, id, 'container.json'))
      if (!c?.Id) continue
      // A process from a previous engine run may have outlived it (crash). Reap it so its ports
      // are free before we restart it.
      if (c.State?.Pid && pidAlive(c.State.Pid) && (await isSameProcess(c.State.Pid, c.NomadCommand, c.NomadArgs))) {
        this.log.warn(`Reaping orphaned process ${c.State.Pid} of ${c.Name}`)
        await killTree(c.State.Pid)
      }
      if (c.State?.Running || c.State?.Restarting) {
        c.State = { ...c.State, Status: 'exited', Running: false, Restarting: false, Pid: 0, ExitCode: c.State.ExitCode ?? 255, FinishedAt: nowIso() }
      }
      this.containers.set(c.Id, c)
    }
    this.log.info(`Loaded ${this.containers.size} container(s)`)
  }

  async _save(c) {
    await writeJsonAtomic(path.join(this.dir, c.Id, 'container.json'), c)
  }

  /** Start containers whose restart policy says they should be running after an engine start. */
  async restore() {
    for (const c of this.containers.values()) {
      const policy = c.HostConfig?.RestartPolicy?.Name || 'no'
      const shouldRun = policy === 'always' || (policy === 'unless-stopped' && c.Desired === 'running')
      if (!shouldRun) continue
      this.log.info(`Restoring ${c.Name} (${policy})`)
      this.start(c.Id).catch((err) => {
        this.log.error(`Failed to restore ${c.Name}: ${err.message}`)
        this._scheduleRestart(c, this._rt(c))
      })
    }
  }

  // ── lookup ────────────────────────────────────────────────────────────────

  find(ref) {
    if (!ref) return null
    const s = String(ref)
    if (this.containers.has(s)) return this.containers.get(s)
    const name = s.startsWith('/') ? s : `/${s}`
    for (const c of this.containers.values()) if (c.Name === name) return c
    const matches = [...this.containers.values()].filter((c) => c.Id.startsWith(s))
    return matches.length === 1 ? matches[0] : null
  }

  get(ref) {
    const c = this.find(ref)
    if (!c) throw new EngineError(404, `No such container: ${ref}`)
    return c
  }

  _rt(c) {
    if (!this.runtime.has(c.Id)) {
      this.runtime.set(c.Id, {
        child: null,
        stopping: false,
        restartTimer: null,
        backoff: 0,
        waiters: [],
        log: new LogWriter(path.join(this.dir, c.Id, 'container.log')),
      })
    }
    return this.runtime.get(c.Id)
  }

  imageInUse(img) {
    for (const c of this.containers.values()) if (c.ImageId === img.Id) return true
    return false
  }

  // ── binds / ports ─────────────────────────────────────────────────────────

  _parseBind(bind) {
    const m = /^([A-Za-z]:[\\/][^:]*|[^:]+):([^:]+)(?::([^:]*))?$/.exec(bind)
    if (!m) throw new EngineError(400, `invalid bind mount spec "${bind}"`)
    let source = m[1]
    const destination = m[2].replace(/\\/g, '/')
    const mode = m[3] || ''
    if (!/^[A-Za-z]:[\\/]/.test(source) && !source.startsWith('/') && !source.startsWith('\\\\')) {
      // Named volume.
      source = path.join(this.volumesDir, source.replace(/[^\w.-]/g, '_'))
    } else if (this.storageRoot && (source === LINUX_DEFAULT_STORAGE || source.startsWith(LINUX_DEFAULT_STORAGE + '/'))) {
      // Catalog entries seeded with the Linux default storage root follow the native storage root.
      source = path.join(this.storageRoot, ...source.slice(LINUX_DEFAULT_STORAGE.length).split('/').filter(Boolean))
    }
    source = path.resolve(source)
    return { source, destination, mode, readOnly: /(^|,)ro(,|$)/.test(mode) }
  }

  _checkBindAllowed(mount) {
    if (!this.restrictBinds || !this.storageRoot) return
    const inside = (root) => {
      const r = path.resolve(root)
      const s = isWin ? mount.source.toLowerCase() : mount.source
      const rr = isWin ? r.toLowerCase() : r
      return s === rr || s.startsWith(rr + path.sep)
    }
    if (!inside(this.storageRoot) && !inside(this.volumesDir)) {
      throw new EngineError(
        400,
        `Folder "${mount.source}" is outside the NOMAD storage folder (${this.storageRoot}). ` +
          'In the native edition, app folders must live inside the NOMAD storage folder.'
      )
    }
  }

  _mounts(c) {
    return (c.HostConfig?.Binds || []).map((b) => this._parseBind(b))
  }

  _hostPath(c, containerPath) {
    const p = String(containerPath).replace(/\\/g, '/')
    const mounts = this._mounts(c).sort((a, b) => b.destination.length - a.destination.length)
    for (const m of mounts) {
      if (p === m.destination) return m.source
      if (p.startsWith(m.destination.replace(/\/$/, '') + '/')) {
        return path.join(m.source, ...p.slice(m.destination.replace(/\/$/, '').length + 1).split('/'))
      }
    }
    return path.join(this.dir, c.Id, 'data', 'rootfs', ...p.split('/').filter(Boolean))
  }

  _translateArgs(c, args) {
    const mounts = this._mounts(c)
    const underMount = (p) => mounts.some((m) => p === m.destination || p.startsWith(m.destination.replace(/\/$/, '') + '/'))
    return (args || []).map((arg) => {
      if (typeof arg !== 'string') return arg
      if (arg.startsWith('/') && underMount(arg)) return this._hostPath(c, arg)
      const kv = /^(-{1,2}[\w.-]+=)(\/.*)$/.exec(arg)
      if (kv && underMount(kv[2])) return kv[1] + this._hostPath(c, kv[2])
      return arg
    })
  }

  /**
   * Docker can mount one folder inside another's mount point (File Browser shows storage/books
   * inside its /srv root). Natively we reproduce that with directory junctions (Windows) or
   * symlinks (Linux) placed inside the outer folder.
   */
  async _linkNestedMounts(c) {
    const mounts = this._mounts(c)
    for (const inner of mounts) {
      const outer = mounts
        .filter((o) => o !== inner && inner.destination.startsWith(o.destination.replace(/\/$/, '') + '/'))
        .sort((a, b) => b.destination.length - a.destination.length)[0]
      if (!outer) continue
      const rel = inner.destination.slice(outer.destination.replace(/\/$/, '').length + 1)
      const linkPath = path.join(outer.source, ...rel.split('/'))
      await ensureDir(inner.source)
      await ensureDir(path.dirname(linkPath))
      try {
        const st = await lstat(linkPath)
        if (st.isSymbolicLink()) continue
        if (st.isDirectory() && (await readdir(linkPath)).length === 0) await rm(linkPath, { recursive: true })
        else continue
      } catch {}
      await symlink(inner.source, linkPath, isWin ? 'junction' : 'dir').catch((err) =>
        this.log.warn(`Could not link ${linkPath} → ${inner.source}: ${err.message}`)
      )
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async create(name, body = {}) {
    const img = this.images.find(body.Image)
    if (!img) throw new EngineError(404, `No such image: ${body.Image}`)
    if (name) {
      if (!/^\/?[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) throw new EngineError(400, `Invalid container name (${name})`)
      const existing = this.find(name.startsWith('/') ? name : `/${name}`)
      if (existing) {
        throw new EngineError(409, `Conflict. The container name "/${name.replace(/^\//, '')}" is already in use by container "${existing.Id}". You have to remove (or rename) that container to be able to reuse that name.`)
      }
    }
    const id = randomHex(32)
    const hostConfig = { ...(body.HostConfig || {}) }
    const c = {
      Id: id,
      Name: `/${(name || `nomad_${id.slice(0, 12)}`).replace(/^\//, '')}`,
      Created: nowIso(),
      ImageId: img.Id,
      Image: img.Id,
      Config: {
        Image: body.Image,
        Cmd: body.Cmd ?? null,
        Entrypoint: body.Entrypoint ?? null,
        Env: body.Env ?? [],
        ExposedPorts: body.ExposedPorts ?? {},
        Labels: body.Labels ?? {},
        Tty: !!body.Tty,
        WorkingDir: body.WorkingDir ?? '',
        User: body.User ?? '',
      },
      HostConfig: hostConfig,
      State: { Status: 'created', Running: false, Paused: false, Restarting: false, OOMKilled: false, Dead: false, Pid: 0, ExitCode: 0, Error: '', StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z' },
      RestartCount: 0,
      Desired: 'created',
    }
    for (const m of this._mounts(c)) this._checkBindAllowed(m)
    await ensureDir(path.join(this.dir, id, 'data'))
    this.containers.set(id, c)
    await this._save(c)
    this.log.info(`Created ${c.Name} from ${body.Image}`)
    return { Id: id, Warnings: [] }
  }

  _launchContext(c, img) {
    const recipeEnv = envListToObject(c.Config.Env)
    const ports = publishedPorts(c.HostConfig)
    return {
      platform: process.platform,
      nodePath: this.nodePath,
      engineHome: this.home,
      storageRoot: this.storageRoot,
      engineFile: (rel) => path.join(this.engineDir, ...rel.split('/')),
      image: { dir: this.images.rootfs(img), repo: img.Repo, version: img.Version, meta: img.Meta || {} },
      container: { id: c.Id, name: c.Name.slice(1), dataDir: path.join(this.dir, c.Id, 'data') },
      cmd: Array.isArray(c.Config.Cmd) ? c.Config.Cmd : c.Config.Cmd ? String(c.Config.Cmd).split(' ') : [],
      env: recipeEnv,
      hostPort: (port, proto = 'tcp') => ports.find((p) => p.privatePort === Number(port) && p.proto === proto)?.publicPort ?? null,
      firstHostPort: () => ports[0]?.publicPort ?? null,
      hostPath: (p) => this._hostPath(c, p),
      translateArgs: (args) => this._translateArgs(c, args),
    }
  }

  async _launch(c) {
    const img = this.images.find(c.ImageId) || this.images.find(c.Config.Image)
    if (!img) throw new EngineError(404, `No such image: ${c.Config.Image}`)
    const recipe = this.images.recipeFor(img)
    if (!recipe) throw new EngineError(500, `No native recipe for image ${c.Config.Image}`)
    const rt = this._rt(c)

    for (const m of this._mounts(c)) {
      this._checkBindAllowed(m)
      const looksLikeFile = /\.[a-z0-9]{1,5}$/i.test(m.destination)
      if (!looksLikeFile && !(await pathExists(m.source))) await ensureDir(m.source)
    }
    await this._linkNestedMounts(c)

    for (const p of publishedPorts(c.HostConfig)) {
      if (!(await isPortFree(p.publicPort))) {
        throw new EngineError(
          500,
          `driver failed programming external connectivity on endpoint ${c.Name.slice(1)}: Bind for 0.0.0.0:${p.publicPort} failed: port is already allocated`
        )
      }
    }

    const ctx = this._launchContext(c, img)
    const spec = await recipe.launch(ctx)
    for (const d of spec.mkdirs || []) await ensureDir(d)
    const env = { ...baseEnv(), ...ctx.env, ...(spec.env || {}) }
    const cwd = spec.cwd || ctx.container.dataDir
    await ensureDir(cwd)

    rt.log.note(`[nomad-engine] starting ${path.basename(spec.command)} ${spec.args.join(' ')}`)
    const child = spawnManaged(spec.command, spec.args, {
      cwd,
      env,
      onStdout: (d) => rt.log.write(1, d),
      onStderr: (d) => rt.log.write(2, d),
    })
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    }).catch((err) => {
      throw new EngineError(500, `failed to start ${spec.command}: ${err.message}`)
    })

    rt.child = child
    rt.stopping = false
    rt.startedAtMs = Date.now()
    c.State = {
      ...c.State,
      Status: 'running',
      Running: true,
      Restarting: false,
      Pid: child.pid,
      ExitCode: 0,
      Error: '',
      StartedAt: nowIso(),
      FinishedAt: '0001-01-01T00:00:00Z',
    }
    c.NomadCommand = spec.command
    c.NomadArgs = spec.args
    child.once('exit', (code, signal) => this._onExit(c, rt, child, code, signal))
    await this._save(c)
    this.log.info(`Started ${c.Name} (pid ${child.pid})`)
  }

  async start(ref) {
    const c = this.get(ref)
    const rt = this._rt(c)
    if (c.State.Running) return { notModified: true }
    if (rt.restartTimer) {
      clearTimeout(rt.restartTimer)
      rt.restartTimer = null
    }
    c.Desired = 'running'
    try {
      await this._launch(c)
    } catch (err) {
      c.State = { ...c.State, Status: 'exited', Running: false, Restarting: false, Error: err.message, ExitCode: 128 }
      await this._save(c)
      throw err
    }
    return { notModified: false }
  }

  _onExit(c, rt, child, code, signal) {
    if (rt.child !== child) return
    rt.child = null
    rt.log.flushPartial()
    const exitCode = code ?? (signal ? 137 : 1)
    const ranFor = Date.now() - (rt.startedAtMs || Date.now())
    c.State = { ...c.State, Status: 'exited', Running: false, Restarting: false, Pid: 0, ExitCode: exitCode, FinishedAt: nowIso() }
    for (const w of rt.waiters.splice(0)) w({ StatusCode: exitCode })
    this._save(c).catch(() => {})

    if (rt.stopping || this.shuttingDown) return
    rt.log.note(`[nomad-engine] process exited with code ${exitCode}`)
    if (c.HostConfig?.AutoRemove) {
      this.remove(c.Id, { force: true }).catch(() => {})
      return
    }
    const policy = c.HostConfig?.RestartPolicy?.Name || 'no'
    const max = Number(c.HostConfig?.RestartPolicy?.MaximumRetryCount || 0)
    const restart =
      policy === 'always' ||
      policy === 'unless-stopped' ||
      (policy === 'on-failure' && exitCode !== 0 && (max === 0 || c.RestartCount < max))
    if (!restart) return
    if (ranFor > 30000) rt.backoff = 0
    this._scheduleRestart(c, rt)
  }

  _scheduleRestart(c, rt) {
    if (this.shuttingDown || rt.restartTimer) return
    const delay = Math.min(60000, 500 * 2 ** rt.backoff)
    rt.backoff = Math.min(rt.backoff + 1, 7)
    c.State = { ...c.State, Status: 'restarting', Restarting: true }
    rt.log.note(`[nomad-engine] restarting in ${Math.round(delay / 1000)}s`)
    rt.restartTimer = setTimeout(async () => {
      rt.restartTimer = null
      if (this.shuttingDown || c.Desired !== 'running') return
      c.RestartCount = (c.RestartCount || 0) + 1
      try {
        await this._launch(c)
      } catch (err) {
        rt.log.note(`[nomad-engine] restart failed: ${err.message}`)
        c.State = { ...c.State, Status: 'restarting', Restarting: true, Error: err.message }
        this._scheduleRestart(c, rt)
      }
    }, delay)
    this._save(c).catch(() => {})
  }

  async stop(ref, { markStopped = true } = {}) {
    const c = this.get(ref)
    const rt = this._rt(c)
    if (markStopped) c.Desired = 'stopped'
    if (rt.restartTimer) {
      clearTimeout(rt.restartTimer)
      rt.restartTimer = null
      c.State = { ...c.State, Status: 'exited', Restarting: false }
      await this._save(c)
      if (!rt.child) return { notModified: false }
    }
    if (!rt.child) {
      await this._save(c)
      return { notModified: true }
    }
    rt.stopping = true
    const child = rt.child
    const exited = new Promise((resolve) => child.once('exit', resolve))
    await killTree(child.pid)
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15000))])
    await this._save(c)
    this.log.info(`Stopped ${c.Name}`)
    return { notModified: false }
  }

  async restart(ref) {
    const c = this.get(ref)
    await this.stop(c.Id)
    await this.start(c.Id)
  }

  async remove(ref, { force = false } = {}) {
    const c = this.get(ref)
    const rt = this._rt(c)
    if ((c.State.Running || rt.child) && !force) {
      throw new EngineError(409, `You cannot remove a running container ${c.Id}. Stop the container before attempting removal or force remove`)
    }
    await this.stop(c.Id).catch(() => {})
    await rt.log.drain()
    this.containers.delete(c.Id)
    this.runtime.delete(c.Id)
    await removeLogs(path.join(this.dir, c.Id, 'container.log'))
    await removeWithRetry(path.join(this.dir, c.Id))
    this.log.info(`Removed ${c.Name}`)
  }

  async rename(ref, newName) {
    const c = this.get(ref)
    const name = `/${String(newName).replace(/^\//, '')}`
    const clash = this.find(name)
    if (clash && clash.Id !== c.Id) {
      throw new EngineError(409, `Conflict. The container name "${name}" is already in use by container "${clash.Id}".`)
    }
    c.Name = name
    await this._save(c)
  }

  async update(ref, body = {}) {
    const c = this.get(ref)
    if (body.RestartPolicy) c.HostConfig = { ...c.HostConfig, RestartPolicy: body.RestartPolicy }
    await this._save(c)
    return { Warnings: [] }
  }

  wait(ref) {
    const c = this.get(ref)
    const rt = this._rt(c)
    if (!rt.child && !rt.restartTimer) return Promise.resolve({ StatusCode: c.State.ExitCode ?? 0, Error: null })
    return new Promise((resolve) => rt.waiters.push(resolve))
  }

  async shutdown() {
    this.shuttingDown = true
    const running = [...this.containers.values()].filter((c) => this.runtime.get(c.Id)?.child || this.runtime.get(c.Id)?.restartTimer)
    await Promise.all(running.map((c) => this.stop(c.Id, { markStopped: false }).catch(() => {})))
    for (const rt of this.runtime.values()) await rt.log.drain()
  }

  // ── read models ───────────────────────────────────────────────────────────

  _portsSummary(c) {
    return publishedPorts(c.HostConfig).map((p) => ({ IP: p.ip, PrivatePort: p.privatePort, PublicPort: p.publicPort, Type: p.proto }))
  }

  _mountsInspect(c) {
    return this._mounts(c).map((m) => ({
      Type: 'bind',
      Source: m.source,
      Destination: m.destination,
      Mode: m.mode,
      RW: !m.readOnly,
      Propagation: 'rprivate',
    }))
  }

  _statusText(c) {
    const s = c.State
    if (s.Restarting) return `Restarting (${s.ExitCode}) ${humanDuration(Date.now() - Date.parse(s.FinishedAt))} ago`
    if (s.Running) return `Up ${humanDuration(Date.now() - Date.parse(s.StartedAt))}`
    if (s.Status === 'created') return 'Created'
    return `Exited (${s.ExitCode}) ${humanDuration(Date.now() - Date.parse(s.FinishedAt))} ago`
  }

  list({ all = false } = {}) {
    return [...this.containers.values()]
      .filter((c) => all || c.State.Running)
      .map((c) => ({
        Id: c.Id,
        Names: [c.Name],
        Image: c.Config.Image,
        ImageID: c.ImageId,
        Command: Array.isArray(c.Config.Cmd) ? c.Config.Cmd.join(' ') : c.Config.Cmd || '',
        Created: Math.floor(Date.parse(c.Created) / 1000),
        Ports: this._portsSummary(c),
        Labels: c.Config.Labels || {},
        State: c.State.Status,
        Status: this._statusText(c),
        HostConfig: { NetworkMode: 'default' },
        NetworkSettings: { Networks: { 'nomad-native': { IPAddress: '127.0.0.1' } } },
        Mounts: this._mountsInspect(c),
      }))
  }

  inspect(ref) {
    const c = this.get(ref)
    const ports = {}
    for (const p of publishedPorts(c.HostConfig)) {
      const key = `${p.privatePort}/${p.proto}`
      ports[key] = ports[key] || []
      ports[key].push({ HostIp: p.ip, HostPort: String(p.publicPort) })
    }
    const state = c.State
    return {
      Id: c.Id,
      Created: c.Created,
      Path: c.NomadCommand || '',
      Args: [],
      State: state,
      Image: c.ImageId,
      Name: c.Name,
      RestartCount: c.RestartCount || 0,
      Driver: 'nomad-native',
      Platform: process.platform === 'win32' ? 'windows' : 'linux',
      HostConfig: c.HostConfig,
      Mounts: this._mountsInspect(c),
      Config: c.Config,
      NetworkSettings: { Networks: { 'nomad-native': { IPAddress: '127.0.0.1' } }, Ports: ports },
    }
  }

  async logs(ref, q) {
    const c = this.get(ref)
    const rt = this._rt(c)
    await rt.log.drain()
    return queryLogs(path.join(this.dir, c.Id, 'container.log'), { ...q, tty: c.Config.Tty })
  }

  /** Stream new log records to `res` until the container exits (attach / logs?follow=1). */
  follow(ref, res, { stdout = true, stderr = true, timestamps = false } = {}) {
    const c = this.get(ref)
    const rt = this._rt(c)
    const unsubscribe = rt.log.subscribe((rec) => {
      if ((rec.s === 1 && stdout) || (rec.s === 2 && stderr)) res.write(formatRecord(rec, { tty: c.Config.Tty, timestamps }))
    })
    const finish = () => {
      unsubscribe()
      res.end()
    }
    res.on('close', unsubscribe)
    if (!rt.child && !rt.restartTimer) finish()
    else rt.waiters.push(() => setTimeout(finish, 100))
  }

  async stats(ref) {
    const c = this.get(ref)
    const rt = this._rt(c)
    const ncpu = os.cpus().length || 1
    const now = new Date()
    const base = {
      read: now.toISOString(),
      preread: new Date(now.getTime() - 1000).toISOString(),
      name: c.Name,
      id: c.Id,
      pids_stats: {},
      memory_stats: { usage: 0, limit: os.totalmem(), stats: {} },
      cpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0, online_cpus: ncpu },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0, online_cpus: ncpu },
    }
    if (!rt.child) return base
    const sample = (await sampleProcessTrees([rt.child.pid])).get(rt.child.pid)
    if (!sample) return base
    const systemNow = Date.now() * 1e6 * ncpu
    return {
      ...base,
      memory_stats: { usage: sample.memBytes, limit: os.totalmem(), stats: {} },
      cpu_stats: { cpu_usage: { total_usage: sample.cpuTotalNs }, system_cpu_usage: systemNow, online_cpus: ncpu },
      precpu_stats: {
        cpu_usage: { total_usage: sample.cpuTotalNs - sample.cpuNsDelta },
        system_cpu_usage: systemNow - sample.systemNsDelta,
        online_cpus: ncpu,
      },
    }
  }

  // ── exec (restricted) ─────────────────────────────────────────────────────

  execCreate(ref, body = {}) {
    const c = this.get(ref)
    if (!c.State.Running) throw new EngineError(409, `Container ${c.Id} is not running`)
    const cmd = body.Cmd || []
    const program = path.basename(String(cmd[0] || '')).replace(/\.exe$/i, '').toLowerCase()
    if (!EXEC_ALLOWLIST.has(program)) {
      throw new EngineError(403, `exec of "${cmd[0]}" is not permitted by the native engine`)
    }
    const id = randomHex(32)
    this.execs.set(id, { id, containerId: c.Id, cmd, tty: !!body.Tty, running: false, exitCode: null })
    return { Id: id }
  }

  execStart(execId, res) {
    const ex = this.execs.get(execId)
    if (!ex) throw new EngineError(404, `No such exec instance: ${execId}`)
    ex.running = true
    res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' })
    const child = spawn(ex.cmd[0], ex.cmd.slice(1), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = (stream) => (d) => res.write(ex.tty ? d : formatRecord({ s: stream, m: d.toString().replace(/\n$/, ''), t: nowIso() }, { tty: false }))
    child.stdout.on('data', out(1))
    child.stderr.on('data', out(2))
    const done = (code) => {
      ex.running = false
      ex.exitCode = code ?? 1
      res.end()
      setTimeout(() => this.execs.delete(execId), 60000).unref()
    }
    child.once('error', (err) => {
      res.write(ex.tty ? `${err.message}\n` : formatRecord({ s: 2, m: err.message, t: nowIso() }, { tty: false }))
      done(127)
    })
    child.once('exit', done)
  }

  execInspect(execId) {
    const ex = this.execs.get(execId)
    if (!ex) throw new EngineError(404, `No such exec instance: ${execId}`)
    return { ID: ex.id, Running: ex.running, ExitCode: ex.exitCode, ContainerID: ex.containerId, ProcessConfig: { entrypoint: ex.cmd[0], arguments: ex.cmd.slice(1), tty: ex.tty } }
  }
}
