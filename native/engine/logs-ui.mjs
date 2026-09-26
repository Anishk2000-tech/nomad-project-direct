// Read-only log viewer on port 9999 — the native stand-in for Dozzle, which the Docker edition
// runs behind Settings → "Service Logs & Metrics". Shows every app container plus the core
// NOMAD components (admin server, workers, database, Redis, supervisor).
import http from 'node:http'
import { open, stat } from 'node:fs/promises'

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Project NOMAD — Logs</title>
<style>
:root{--bg:#0f1512;--panel:#17201b;--line:#243029;--text:#dfe7e1;--muted:#8ea196;--accent:#7fb069;--err:#ff8a7a}
@media (prefers-color-scheme: light){:root{--bg:#f4f6f3;--panel:#fff;--line:#dfe5df;--text:#1c2420;--muted:#5d6b63;--accent:#3f7a2b;--err:#b3261e}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--text);display:flex;height:100vh}
aside{width:260px;min-width:200px;border-right:1px solid var(--line);background:var(--panel);overflow:auto}
h1{font-size:15px;margin:0;padding:14px 16px;border-bottom:1px solid var(--line)}h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:14px 16px 6px}
button.item{display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;background:none;border:0;color:inherit;padding:7px 16px;cursor:pointer;font:inherit}
button.item:hover,button.item.active{background:color-mix(in srgb,var(--accent) 16%,transparent)}
.st{font-size:11px;color:var(--muted)}.st.running{color:var(--accent)}.st.exited,.st.restarting{color:var(--err)}
main{flex:1;display:flex;flex-direction:column;min-width:0}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line)}header strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
label{color:var(--muted);font-size:13px;display:flex;gap:6px;align-items:center}
pre{flex:1;margin:0;padding:12px 16px;overflow:auto;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.empty{color:var(--muted);padding:24px}
@media (max-width:640px){body{flex-direction:column}aside{width:auto;max-height:40vh;border-right:0;border-bottom:1px solid var(--line)}}
</style></head><body>
<aside><h1>Project NOMAD logs</h1><h2>Apps</h2><div id="apps"></div><h2>NOMAD core</h2><div id="system"></div></aside>
<main><header><strong id="title">Select a log</strong>
<label><input type="checkbox" id="follow" checked> Auto-refresh</label>
<label>Lines <select id="tail"><option>200</option><option selected>1000</option><option>5000</option></select></label></header>
<pre id="out" class="empty">Pick an app or component on the left.</pre></main>
<script>
let current=null;const out=document.getElementById('out');
async function j(u){const r=await fetch(u);return r.json()}
function item(label,status,key){const b=document.createElement('button');b.className='item';b.dataset.key=key;
 b.innerHTML='<span></span><span class="st"></span>';b.children[0].textContent=label;b.children[1].textContent=status||'';if(status)b.children[1].classList.add(status);
 b.onclick=()=>{current=key;document.querySelectorAll('.item').forEach(x=>x.classList.toggle('active',x===b));document.getElementById('title').textContent=label;load(true)};return b}
async function lists(){const [apps,sys]=await Promise.all([j('api/containers'),j('api/system')]);
 const a=document.getElementById('apps');a.replaceChildren(...apps.map(c=>item(c.name,c.state,'c/'+c.id)));
 if(!apps.length)a.innerHTML='<div class="empty">No apps installed yet.</div>';
 document.getElementById('system').replaceChildren(...sys.map(s=>item(s.name,'','s/'+s.name)));
 document.querySelectorAll('.item').forEach(x=>x.classList.toggle('active',x.dataset.key===current))}
async function load(scroll){if(!current)return;const t=document.getElementById('tail').value;
 const r=await fetch('api/'+current+'?tail='+t);const text=await r.text();const atBottom=out.scrollTop+out.clientHeight>=out.scrollHeight-40;
 out.classList.toggle('empty',!text);out.textContent=text||'(no output yet)';if(scroll||atBottom)out.scrollTop=out.scrollHeight}
document.getElementById('tail').onchange=()=>load(true);
lists();setInterval(lists,10000);setInterval(()=>{if(document.getElementById('follow').checked)load(false)},3000);
</script></body></html>`

async function tailFile(file, lines) {
  let fh
  try {
    const { size } = await stat(file)
    const want = Math.min(size, Math.max(64 * 1024, lines * 400))
    fh = await open(file, 'r')
    const buf = Buffer.alloc(want)
    await fh.read(buf, 0, want, size - want)
    const text = buf.toString('utf8')
    return text.split('\n').slice(-lines - 1).join('\n')
  } catch {
    return ''
  } finally {
    await fh?.close()
  }
}

export function createLogsUiServer({ containers, systemLogs, logger }) {
  const log = logger.child('logs-ui')
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://ui')
      const tail = Math.min(20000, Math.max(10, Number(url.searchParams.get('tail') || 1000)))
      const p = url.pathname
      if (req.method !== 'GET') return res.writeHead(405).end()
      if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
        return res.end(PAGE)
      }
      if (p === '/api/containers') {
        const list = containers.list({ all: true }).map((c) => ({ id: c.Id, name: c.Names[0].slice(1), state: c.State }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(list.sort((a, b) => a.name.localeCompare(b.name))))
      }
      if (p === '/api/system') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(systemLogs.map((s) => ({ name: s.name }))))
      }
      let m
      if ((m = /^\/api\/c\/([0-9a-f]+)$/.exec(p))) {
        const buf = await containers.logs(m[1], { stdout: true, stderr: true, tail, timestamps: true })
        const c = containers.get(m[1])
        const text = c.Config.Tty ? buf.toString('utf8') : demux(buf)
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end(text)
      }
      if ((m = /^\/api\/s\/(.+)$/.exec(p))) {
        const entry = systemLogs.find((s) => s.name === decodeURIComponent(m[1]))
        if (!entry) return res.writeHead(404).end()
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end(await tailFile(entry.file, tail))
      }
      res.writeHead(404).end()
    } catch (err) {
      log.debug(err.message)
      if (!res.headersSent) res.writeHead(500).end(err.message)
    }
  })
}

function demux(buf) {
  let out = ''
  let off = 0
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off + 4)
    out += buf.toString('utf8', off + 8, off + 8 + size)
    off += 8 + size
  }
  return out
}
