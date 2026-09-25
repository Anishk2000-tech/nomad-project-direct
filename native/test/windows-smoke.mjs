// End-to-end smoke test for an installed native NOMAD (run by CI on a real Windows machine after
// a silent install; also works against a local Linux stack). Uses only NOMAD's public HTTP API —
// the same calls the dashboard makes — and then checks each app answers on its own port.
//
//   node windows-smoke.mjs [--base http://localhost:8080] [--apps kiwix,qdrant,cyberchef,...]
//                          [--ai] [--benchmark] [--model qwen2.5:0.5b]
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (!a.startsWith('--')) return acc
    const next = arr[i + 1]
    return [...acc, [a.slice(2), next && !next.startsWith('--') ? next : true]]
  }, [])
)
const BASE = String(args.base || 'http://localhost:8080').replace(/\/$/, '')
const HOST = new URL(BASE).hostname
const apps = String(args.apps || 'kiwix,cyberchef,flatnotes,kolibri').split(',').filter(Boolean)

const APP_CHECKS = {
  kiwix: { service: 'nomad_kiwix_server', url: `http://${HOST}:8090/catalog/v2/entries`, expect: /Wikipedia/i, timeoutMin: 10 },
  qdrant: { service: 'nomad_qdrant', url: `http://${HOST}:6333/`, expect: /qdrant/i, timeoutMin: 10 },
  cyberchef: { service: 'nomad_cyberchef', url: `http://${HOST}:8100/`, expect: /CyberChef/i, timeoutMin: 10 },
  flatnotes: { service: 'nomad_flatnotes', url: `http://${HOST}:8200/`, expect: /flatnotes/i, timeoutMin: 20 },
  kolibri: { service: 'nomad_kolibri_2', url: `http://${HOST}:8310/`, expect: /Kolibri/i, timeoutMin: 25 },
  filebrowser: { service: 'nomad_filebrowser', url: `http://${HOST}:8410/`, expect: /File Browser|filebrowser/i, timeoutMin: 10 },
  ittools: { service: 'nomad_it_tools', url: `http://${HOST}:8430/`, expect: /IT Tools/i, timeoutMin: 10 },
  excalidraw: { service: 'nomad_excalidraw', url: `http://${HOST}:8440/`, expect: /Excalidraw/i, timeoutMin: 10 },
  ollama: { service: 'nomad_ollama', url: `http://${HOST}:11434/api/version`, expect: /version/, timeoutMin: 30 },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const t0 = Date.now()
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`

async function http(method, path, body, { timeout = 30000 } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    // App URLs (absolute) follow redirects (Kolibri sends / → /en/); dashboard routes don't.
    redirect: path.startsWith('http') ? 'follow' : 'manual',
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, text, json }
}

async function step(name, fn) {
  const start = Date.now()
  console.log(`${stamp()} ▶ ${name}`)
  try {
    const detail = await fn()
    results.push({ name, ok: true, secs: (Date.now() - start) / 1000, detail })
    console.log(`${stamp()} ✔ ${name}${detail ? ` — ${detail}` : ''}`)
    return true
  } catch (err) {
    results.push({ name, ok: false, secs: (Date.now() - start) / 1000, detail: err.message })
    console.log(`${stamp()} ✘ ${name} — ${err.message}`)
    return false
  }
}

async function waitFor(what, fn, timeoutMs, intervalMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let last = 'no answer'
  while (Date.now() < deadline) {
    try {
      const r = await fn()
      if (r === true || (r && r.ok)) return r
      last = r?.why ?? String(r)
    } catch (err) {
      last = err.message
    }
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${what} (${last})`)
}

async function serviceState(name) {
  const { json } = await http('GET', '/api/system/services')
  return (json || []).find((s) => s.service_name === name)
}

async function installApp(key) {
  const check = APP_CHECKS[key]
  if (!check) throw new Error(`unknown app "${key}"`)
  const existing = await serviceState(check.service)
  if (!existing?.installed) {
    const res = await http('POST', '/api/system/services/install', { service_name: check.service })
    if (res.status >= 400) throw new Error(`install request failed: HTTP ${res.status} ${res.text.slice(0, 300)}`)
  }
  await waitFor(
    `${check.service} to be installed and running`,
    async () => {
      const s = await serviceState(check.service)
      if (s?.installed && s.status === 'running') return true
      const all = await http('GET', `/api/system/services/${check.service}/logs?tail=5`).catch(() => null)
      return { ok: false, why: `${s ? `${s.installation_status}/${s.status}` : 'not listed yet'} ${all?.json?.logs ? '| ' + String(all.json.logs).trim().split('\n').pop() : ''}` }
    },
    check.timeoutMin * 60000
  )
  const res2 = await waitFor(
    `${check.url}`,
    async () => {
      const r = await http('GET', check.url, null, { timeout: 15000 })
      return r.status < 400 && check.expect.test(r.text) ? { ok: true, r } : { ok: false, why: `HTTP ${r.status}` }
    },
    5 * 60000
  )
  return `${check.url} → HTTP ${res2.r.status}`
}

// ── Core ───────────────────────────────────────────────────────────────────
await step('dashboard health', async () => {
  await waitFor('/api/health', async () => (await http('GET', '/api/health')).json?.status === 'ok', 5 * 60000, 3000)
  return 'ok'
})
await step('dashboard pages render', async () => {
  for (const p of ['/home', '/supply-depot', '/settings/system', '/easy-setup', '/maps', '/docs/home']) {
    // The first /maps visit downloads the base map assets inside the request.
    const r = await http('GET', p, null, { timeout: 180000 })
    if (r.status >= 400) throw new Error(`${p} → HTTP ${r.status}`)
  }
  return 'home, supply depot, system, easy setup, maps, docs'
})
await step('system info reports this machine', async () => {
  const { json } = await http('GET', '/api/system/info')
  if (!json?.cpu?.brand) throw new Error('no CPU info')
  return `${json.os?.distro ?? json.os?.platform} · ${json.cpu.brand} · ${(json.mem.total / 2 ** 30).toFixed(1)} GB RAM`
})
await step('catalog hides apps without a native build', async () => {
  const r = await http('GET', '/supply-depot')
  if (/Vaultwarden/.test(r.text)) throw new Error('Vaultwarden is still offered')
  return 'Vaultwarden etc. hidden'
})
await step('log viewer answers on :9999', async () => {
  const r = await http('GET', `http://${HOST}:9999/api/system`)
  if (!r.json?.length) throw new Error(`HTTP ${r.status}`)
  return `${r.json.length} core logs`
})

// ── Apps ───────────────────────────────────────────────────────────────────
for (const key of apps) await step(`install app: ${key}`, () => installApp(key))

if (args.ai) {
  await step('install AI Assistant (Ollama + Qdrant)', () => installApp('ollama'))
  await step('Qdrant (installed as a dependency) answers', async () => {
    const r = await http('GET', `http://${HOST}:6333/`)
    if (!/qdrant/i.test(r.text)) throw new Error(`HTTP ${r.status}`)
    return JSON.parse(r.text).version
  })
  const model = String(args.model || 'qwen2.5:0.5b')
  await step(`pull model ${model} and generate text`, async () => {
    const pull = await http('POST', `http://${HOST}:11434/api/pull`, { model, stream: false }, { timeout: 30 * 60000 })
    if (pull.status >= 400) throw new Error(`pull failed: ${pull.text.slice(0, 200)}`)
    const gen = await http('POST', `http://${HOST}:11434/api/generate`, { model, prompt: 'Reply with the single word: ready', stream: false }, { timeout: 10 * 60000 })
    if (!gen.json?.response) throw new Error(`generate failed: ${gen.text.slice(0, 200)}`)
    return `"${gen.json.response.trim().slice(0, 40)}" in ${(gen.json.total_duration / 1e9).toFixed(1)}s`
  })
}

if (args.benchmark) {
  await step('system benchmark through the job queue (JS sysbench)', async () => {
    const before = (await http('GET', '/api/benchmark/results/latest')).json
    const run = await http('POST', '/api/benchmark/run/system', {})
    if (run.status >= 400) throw new Error(`HTTP ${run.status} ${run.text.slice(0, 200)}`)
    const result = await waitFor(
      'benchmark result',
      async () => {
        const latest = (await http('GET', '/api/benchmark/results/latest')).json
        const r = latest?.result ?? latest
        const id = r?.benchmark_id ?? r?.id
        const prevId = (before?.result ?? before)?.benchmark_id ?? (before?.result ?? before)?.id
        return id && id !== prevId && r.cpu_score !== undefined ? { ok: true, r } : { ok: false, why: 'running' }
      },
      15 * 60000,
      10000
    )
    return `cpu ${(result.r.cpu_score * 100).toFixed(0)} · memory ${(result.r.memory_score * 100).toFixed(0)} · disk read ${(result.r.disk_read_score * 100).toFixed(0)}`
  })
}

// ── Summary ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log('\n══════════ Project NOMAD native smoke test ══════════')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(55)} ${r.secs.toFixed(0).padStart(5)}s  ${r.detail ?? ''}`)
console.log(`${results.length - failed.length}/${results.length} passed`)
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import('node:fs/promises')
  const md = [
    '### Project NOMAD — Windows smoke test',
    '',
    '| Result | Check | Time | Detail |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.secs.toFixed(0)}s | ${String(r.detail ?? '').replace(/\|/g, '\\|').slice(0, 200)} |`),
    '',
  ].join('\n')
  await appendFile(process.env.GITHUB_STEP_SUMMARY, md)
}
process.exit(failed.length ? 1 : 0)
