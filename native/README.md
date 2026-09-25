# Project NOMAD for Windows — no Docker required

This folder contains the **native edition** of Project NOMAD: a way to run the exact same Command
Center on Windows 10/11 **without Docker, Docker Desktop or WSL**. It ships as a single
`ProjectNOMAD-Setup-<version>.exe` installer.

- [Installing](#installing)
- [Using it](#using-it)
- [What works](#what-works)
- [How it works](#how-it-works)
- [Building the installer](#building-the-installer)
- [Troubleshooting](#troubleshooting)

---

## Installing

1. Download `ProjectNOMAD-Setup-<version>.exe` from the repository's **Releases** page (or from the
   **Build Windows Installer** workflow run's artifacts).
2. Run it. Because the installer isn't code-signed, Windows SmartScreen may say *"Windows protected
   your PC"* — click **More info → Run anyway**.
3. Choose where to install the program (default `C:\Program Files\Project NOMAD`) and, on the next
   page, the **data folder** (default `C:\ProjectNOMAD`). All downloaded content — Wikipedia, maps,
   AI models, notes, the database — lives in the data folder, so pick a drive with lots of space.
4. Setup installs a Windows service called **Project NOMAD**, starts it, waits until the dashboard is
   up, and opens <http://localhost:8080>. Start with **Easy Setup**.

Requirements: 64-bit Windows 10 or 11, 4 GB RAM minimum (16–32 GB and an NVIDIA/AMD GPU recommended
for AI), and an internet connection while downloading apps and content. Everything works offline
afterwards.

**Silent install** (for scripted deployments):

```bat
ProjectNOMAD-Setup-1.34.1.exe /S /DATA=D:\NOMAD
:: optional: /D=C:\NOMAD\Program   (install folder; must be the last argument)
:: optional: /NOSTART             (don't start the service yet)
```

**Upgrading:** run a newer installer — it keeps your install and data folders. Upgrades can also be
started from **Settings → Check for Updates** inside NOMAD (it downloads the new installer from the
releases of the repository the build came from and runs it silently).

**Uninstalling:** *Settings → Apps → Project NOMAD → Uninstall*, or the *Uninstall Project NOMAD*
Start-menu entry. You'll be asked whether to delete the data folder (default: keep it, so a later
reinstall picks up where you left off). Silent: `"Uninstall Project NOMAD.exe" /S` keeps data,
`/S /PURGE` deletes it.

## Using it

| Start-menu entry | What it does |
|---|---|
| **Project NOMAD** | Opens the dashboard at <http://localhost:8080> |
| **NOMAD Logs** | Opens the log viewer at <http://localhost:9999> (also linked from *Settings → Service Logs & Metrics*) |
| **NOMAD Status** | Shows whether NOMAD and each app are running |
| **Restart NOMAD** | Restarts the service (asks for administrator rights) |
| **NOMAD Data Folder** | Opens the data folder in Explorer |

NOMAD runs as a background service that starts with Windows, so it's available even when nobody is
logged in. Other devices on your **home/private** network can use it at
`http://<this-computer's-name>:8080` — the installer opens the needed ports only for private and
domain networks, never for public Wi-Fi. NOMAD has no login (same as the Docker edition), so don't
expose it to the internet.

The service can also be controlled with the usual Windows tools (`services.msc`, or
`sc stop ProjectNOMAD` / `sc start ProjectNOMAD` from an administrator prompt).

## What works

Everything in the Command Center itself — dashboard, Easy Setup, content collections, Wikipedia
selector, ZIM library manager and uploads, Content Explorer, offline maps (including region
extracts), Medication Reference, the AI chat with Knowledge Base / document uploads, NOMAD.md,
benchmarks, docs, settings and auto-updates of content.

Apps from the Supply Depot, each running as a native Windows program:

| App | Native build used |
|---|---|
| Information Library (Kiwix) | official `kiwix-tools` Windows build (download.kiwix.org) |
| AI Assistant (Ollama) | official Ollama for Windows (NVIDIA CUDA included; AMD ROCm added automatically when an AMD GPU is present) |
| Qdrant (Knowledge Base vector DB) | official Qdrant Windows build |
| Education Platform (Kolibri) | Kolibri from PyPI in a bundled portable Python |
| Notes (FlatNotes) | FlatNotes' own code from its image + its locked Python dependencies |
| File Browser | official File Browser Windows build |
| Data Tools (CyberChef), IT Tools, Excalidraw, Meshtastic Web, MeshCore Web | the web apps taken from their published images, served by NOMAD's static server (MeshCore over HTTPS with a self-signed certificate) |

Not available in the native edition (hidden from the Supply Depot): **Vaultwarden** (no Windows
build), **Stirling PDF**, **Calibre-Web**, **Homebox** (not packaged yet) and **Jellyfin** (install
Jellyfin for Windows from jellyfin.org and add it as a link). **Custom Docker apps** can't run
without Docker, so *Add Custom App* is hidden.

Other differences from the Docker edition:

- **Benchmarks** use a JavaScript port of the sysbench tests, so results are fine for comparing
  your own machines but can't be submitted to the community leaderboard.
- ZIM files are read with NOMAD's built-in reader (the `libzim` library has no Windows build). It
  reads every ZIM Kiwix has published since 2021; very old XZ-compressed ZIMs are still served by
  Kiwix but can't be added to the AI Knowledge Base.
- GPU acceleration for AI works through the normal Windows NVIDIA/AMD drivers — no container toolkit.

## How it works

```
 Windows service "Project NOMAD" (WinSW)
 └─ node.exe native/launcher/supervisor.mjs
    ├─ MariaDB   (runtime/mariadb, 127.0.0.1:3316)   ← replaces the mysql container
    ├─ Redis     (runtime/redis,   127.0.0.1:6389)   ← replaces the redis container
    ├─ NOMAD engine (native/engine, 127.0.0.1:2385)  ← replaces Docker itself
    │    speaks the Docker Engine API; "containers" are native processes
    │    ├─ kiwix-serve.exe  :8090      ├─ ollama.exe serve :11434
    │    ├─ qdrant.exe       :6333      ├─ python -m kolibri :8310
    │    └─ ...
    ├─ node ace queue:work --all        ← background jobs (downloads, embeddings, benchmarks)
    ├─ node bin/server.js :8080         ← the Command Center (unchanged app)
    ├─ disk-info collector              ← replaces the disk-collector sidecar
    ├─ updater                          ← replaces the updater sidecar
    └─ log viewer :9999                 ← replaces Dozzle
```

The key idea is **`native/engine`**: a small, dependency-free Node service that implements the part
of the Docker Engine API NOMAD uses (create/start/stop/rename/remove containers, pull images, logs,
stats, wait, a restricted exec, info). The admin app keeps using `dockerode` exactly as before — in
the native edition it connects to `http://127.0.0.1:2385` instead of `/var/run/docker.sock`
(`admin/app/utils/native_runtime.ts`). This keeps the app code virtually identical to the Docker
edition.

- **Pulling an image** runs a *recipe* (`native/engine/recipes`) that installs the equivalent native
  build: an official Windows release, a PyPI package in a portable Python, or files taken straight
  out of the pinned OCI image via the registry API (static web apps, FlatNotes' source).
- **Starting a container** asks the recipe for a command line and translates the container's
  settings: `Binds` become real folders inside the NOMAD storage folder, `PortBindings` become the
  program's listen port, `Env` is passed through. Docker semantics are preserved — restart policies
  (including `unless-stopped` across reboots), rename-based updates with rollback, "port is already
  allocated" errors, multiplexed logs.
- **Security:** the engine listens on 127.0.0.1 only and requires a secret token (stored in the
  admin-only `config` folder), confines bind mounts to the storage folder, and only allows GPU query
  tools through `exec`. Apps get a minimal environment (no database passwords).

Folder layout:

```
C:\Program Files\Project NOMAD\     program files (replaced on upgrade)
  app\            the Command Center (built admin app + node_modules)
    storage\  →   junction to <data>\storage
  native\         engine + launcher (this folder)
  runtime\        node, mariadb, redis, pmtiles
  service\        WinSW service wrapper (ProjectNOMAD.exe/.xml)
  licenses\       third-party licenses
C:\ProjectNOMAD\                    data folder (kept on uninstall unless you choose otherwise)
  storage\        zim, maps, kb_uploads, ollama models, qdrant, kolibri, flatnotes, ...
  mysql\  redis\  database files
  engine\         installed app packages (images) and app state (containers)
  config\         nomad.json with generated passwords and ports (administrators only)
  logs\           supervisor, admin, workers, mariadb, redis, migrations
```

Ports and other settings can be changed in `config\nomad.json` (restart the service afterwards).

### Admin app changes

All changes are inert unless `NOMAD_RUNTIME=native`, so the Docker edition behaves as before:

- `app/utils/native_runtime.ts` — Docker client factory (native engine / Docker Desktop pipe / Linux
  socket), native catalog filtering, releases repository.
- `app/utils/zim_reader.ts` + `app/utils/libzim.ts` — pure-TypeScript ZIM reader used when the
  `@openzim/libzim` binding can't load; verified entry-for-entry against libzim.
- Kiwix library entries use relative paths natively; the Kiwix pre-install copies a bundled starter
  ZIM when available.
- Service URLs use `127.0.0.1`; Windows-specific port-conflict advice; self-signed certificates via
  the engine (Windows has no `openssl`); `PMTILES_BINARY_PATH`, `NOMAD_UPDATE_SHARED_DIR` and
  `NOMAD_RELEASES_REPO` are configurable.
- UI: the Supply Depot hides *Add Custom App* and unsupported apps in the native edition.

## Building the installer

The installer is built by [`.github/workflows/build-windows-installer.yml`](../.github/workflows/build-windows-installer.yml)
on every push that touches `admin/` or `native/`, and published as a release for `v*` /
`windows-v*` tags (or a manual run with *publish*). The workflow also installs the result on a
fresh Windows machine and tests it end-to-end.

To build locally on Windows (Node.js 22 and NSIS 3 required):

```powershell
cd admin; npm ci --ignore-scripts; cd ..
node native/scripts/stage-app.mjs --out dist/stage --releases-repo <owner>/<repo>
node native/scripts/fetch-windows-runtimes.mjs --out dist/stage --cache dist/download-cache
node native/scripts/prune-app.mjs --dir dist/stage/app
makensis /DVERSION=1.34.1 /DVIVERSION=1.34.1.0 /DSTAGE=$PWD\dist\stage /DOUTFILE=$PWD\dist\ProjectNOMAD-Setup.exe native\installer\windows\nomad.nsi
```

### Developing and testing on Linux

The engine and supervisor are cross-platform, so the whole native stack also runs on Linux (with
MariaDB and Redis from the distribution), which is how it was developed:

```bash
node native/test/engine.test.mjs                         # engine, driven through dockerode
node native/scripts/stage-app.mjs --out /tmp/nomad-stage  # build + stage the app
PATH=$PATH:/usr/sbin node /tmp/nomad-stage/native/launcher/supervisor.mjs \
  --install-dir /tmp/nomad-stage --home /tmp/nomad-home --console
node native/test/windows-smoke.mjs --apps kiwix,kolibri,flatnotes --benchmark
```

`NOMAD_ENGINE_OVERRIDE_<RECIPE>=<folder>` (e.g. `NOMAD_ENGINE_OVERRIDE_KIWIX_SERVE=/usr/bin`) makes a
recipe use locally installed binaries instead of downloading them.

## Troubleshooting

- **Dashboard doesn't open** — first start after install can take a couple of minutes (database
  initialisation). Check *NOMAD Status*, then `C:\ProjectNOMAD\logs\supervisor.log`.
- **An app shows "restarting"** — open *NOMAD Logs* (<http://localhost:9999>) and pick the app.
- **"port … is already in use"** — another program holds the port. For the AI Assistant this is
  usually the Ollama desktop app: quit it from the system tray and disable *start at login*. Core
  ports (8080, 3316, 6389, 2385, 9999) can be changed in `config\nomad.json`.
- **Downloads fail** — Windows Defender or a firewall may block `node.exe`/the app programs from
  reaching the internet; NOMAD needs internet access only while downloading.
- **Moving the data folder** — stop the service, move the folder, edit
  `C:\Program Files\Project NOMAD\data-location.txt` (and the `DataDir` value under
  `HKLM\Software\ProjectNOMAD`), start the service.
