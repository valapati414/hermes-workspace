# Hermes Workspace — Orchestration Issues Audit

**Date**: 2025  
**Scope**: Full end-to-end review of the multi-agent orchestration pipeline  
**Status**: Issues identified and remediated — see linked code changes

---

## Summary

The orchestration system has **no autonomous execution path** out-of-the-box.  
Tasks can be created and workers can be dispatched _manually_ via the UI, but the loop that reads worker checkpoints and drives automatic continuation never fires on its own. Combined with missing profile bootstrap logic, empty worker registries on first install, and blocking I/O in the notification path, the result is that autonomous agent operation does not work at all.

The fixes below are applied in the source code. This document remains as a permanent record.

---

## Issues

---

### ISSUE-01 — No server-side orchestration scheduler  
**Severity**: Critical  
**File(s)**: `server-entry.js`, `src/routes/api/swarm-orchestrator-loop.ts`

**Problem**  
The endpoint `POST /api/swarm-orchestrator-loop` is the heartbeat that reads worker checkpoints and, when `autoContinue=true`, dispatches follow-up tasks. It is never called automatically. There is no `setInterval`, no cron job, no event trigger wired into the server. The endpoint exists but nothing calls it.

**Impact**  
Workers dispatched manually will produce checkpoints that are never read, so no follow-up routing happens, no stale workers are nudged, and missions never complete autonomously.

**Fix**  
Added a `startOrchestrationScheduler()` function in `src/server/swarm-orchestration-scheduler.ts` that is called once at server startup from `server-entry.js`. It posts to the orchestrator loop every 60 seconds (configurable via `SWARM_LOOP_INTERVAL_MS`) when swarm mode is `auto`. It self-backs-off on consecutive errors and is a no-op when mode is `manual`.

---

### ISSUE-02 — autoContinue is never true when called by the scheduler  
**Severity**: Critical  
**File(s)**: `src/routes/api/swarm-orchestrator-loop.ts`, `src/server/swarm-mode.ts`

**Problem**  
`applySwarmModeToLoopFlags()` returns `autoContinue = input.autoContinueRequested`. In `auto` mode the flag passes through, but callers must explicitly send `autoContinue: true` in the POST body — it is never the default. When the scheduler or any external caller does not set this flag, `autoContinue` is `false`, so the loop reads checkpoints and publishes a summary but dispatches nothing.

**Impact**  
Even with the scheduler in place (ISSUE-01 fix), no tasks are dispatched automatically without the body flag. The "auto" mode name is misleading.

**Fix**  
The scheduler sends `{ autoContinue: true, allowExecution: true }` in the POST body. `applySwarmModeToLoopFlags()` now defaults `autoContinueRequested` to `true` when mode is `auto` and no explicit value is provided (new `autoContinueDefault` parameter).

---

### ISSUE-03 — No worker profiles on first install — listSwarmWorkerIds returns empty  
**Severity**: Critical  
**File(s)**: `src/server/swarm-foundation.ts`, `src/routes/api/swarm-orchestrator-loop.ts`

**Problem**  
`listSwarmWorkerIds()` scans `~/.hermes/profiles/` for subdirectories. On a fresh Debian install, this directory does not exist so the function returns `[]`. The orchestrator loop defaults to `listSwarmWorkerIds()` when no explicit `workerIds` are in the request body, meaning it processes zero workers.

**Impact**  
The orchestrator loop is a no-op on a fresh install. No profiles → no workers → no checkpoints read → no dispatch.

**Fix**  
The scheduler now calls `/api/swarm-profiles-bootstrap` (new endpoint) at startup to create profile directories for every worker listed in `swarm.yaml` that doesn't already have one. `listSwarmWorkerIds()` is updated to also fall back to the `swarm.yaml` roster when the profiles dir is empty, so the loop will process roster workers even before profiles are fully initialised.

---

### ISSUE-04 — Worker profile not bootstrapped on oneshot execution path  
**Severity**: High  
**File(s)**: `src/routes/api/swarm-dispatch.ts`

**Problem**  
`ensureSwarmProfileConfig(profilePath)` is only called inside `ensureLiveTmuxSession()`. The `runWorker()` function first tries live tmux, and only if that returns `null` falls through to `execFile` oneshot. The oneshot path checks `existsSync(profilePath)` — if the profile directory doesn't exist it returns an error immediately. But even if the directory exists (created by a previous tmux attempt), `ensureSwarmProfileConfig` has never been called for the oneshot path independently.

**Impact**  
Oneshot workers fail with "Profile not found" or run with a misconfigured profile (missing config.yaml, symlinked .env, etc.).

**Fix**  
`runWorker()` now calls `ensureSwarmProfileConfig(profilePath)` unconditionally at the top of the function, before either the tmux or oneshot branch.

---

### ISSUE-05 — swarm-notifications.ts uses blocking execFileSync for tmux  
**Severity**: Medium  
**File(s)**: `src/server/swarm-notifications.ts`

**Problem**  
`publishCheckpointToOrchestrator()` calls `execFileSync('tmux', ['send-keys', ...])` — a synchronous call that blocks the Node.js event loop until the tmux subprocess exits. Under load (multiple workers completing simultaneously) this can stall the server for hundreds of milliseconds per notification. Additionally, if the tmux session doesn't exist, `execFileSync` throws and the error is swallowed, giving no feedback.

**Impact**  
Event-loop stalls during multi-worker checkpoints; silent notification drops when orchestrator tmux session is absent.

**Fix**  
Replaced `execFileSync` with async `execFile` wrapped in a promise, with a short 3-second timeout and an explicit catch that logs the error rather than silently dropping it.

---

### ISSUE-06 — kanban cards in "ready" state are never automatically dispatched  
**Severity**: High  
**File(s)**: `src/server/swarm-kanban-store.ts`, no scheduler

**Problem**  
The `swarm2-kanban.json` store has cards in lanes: `backlog`, `todo`, `ready`, `running`, `review`, `blocked`, `done`. Cards that are moved to `ready` (indicating they are ready to be dispatched to a worker) are never read by any server process and never sent to `swarm-dispatch`. The same applies to the `tasks.json` store.

**Impact**  
Creating a task via the Kanban board or task manager has no effect on actual agent execution — it is purely a visual tracking board.

**Fix**  
The orchestration scheduler now queries kanban cards with status `ready` that have an `assignedWorker` field, and dispatches them via `/api/swarm-dispatch` before running the orchestrator loop. Dispatched cards are immediately transitioned to `running`. This creates the bridge between the planning board and agent execution.

---

### ISSUE-07 — SWARM_CANONICAL_REPO may not point to the repo on server deploy  
**Severity**: Medium  
**File(s)**: `src/server/swarm-environment.ts`

**Problem**  
`SWARM_CANONICAL_REPO = resolve(process.cwd())` is evaluated at module load time. When running as a systemd service or Docker container, `process.cwd()` may be `/` or a different directory, causing `swarm.yaml` and the `.runtime/` directory to be read from and written to the wrong location.

**Impact**  
`swarm.yaml` roster is not found (no workers); `.runtime/swarm-mode.json`, `.runtime/swarm-missions.json` are read/written in the wrong location causing lost state.

**Fix**  
Added `HERMES_WORKSPACE_ROOT` environment variable support in `swarm-environment.ts`. When set, it overrides `process.cwd()`. The `.env.example` now documents this variable. The `server-entry.js` and Docker entrypoint also auto-detect the workspace root by walking up from `__dirname` to find `swarm.yaml`.

---

### ISSUE-08 — skills/workspace-dispatch/SKILL.md may be missing  
**Severity**: Low  
**File(s)**: `src/routes/api/conductor-spawn.ts`

**Problem**  
`loadDispatchSkill()` reads `skills/workspace-dispatch/SKILL.md` to build the orchestrator system prompt. If the file doesn't exist (e.g. first checkout without running `hermes skills install`), the function returns an empty string with a warning — the orchestrator is given no routing instructions and will produce poor task decompositions.

**Impact**  
Conductor missions produce incoherent agent assignments when the skill file is absent.

**Fix**  
Added a fallback inline skill prompt in `conductor-spawn.ts` that is used when the file is missing, ensuring the orchestrator always has basic routing instructions. Added `skills/workspace-dispatch/SKILL.md` to the repository.

---

### ISSUE-09 — Gateway WebSocket dependency makes Conductor screen non-functional  
**Severity**: Medium  
**File(s)**: `src/screens/gateway/hooks/use-mission-orchestrator.ts`

**Problem**  
The Conductor screen connects to `ws://127.0.0.1:18789` (hermes gateway). If hermes agent is not running or the gateway is down, every `attachSessionStream()` call fails silently and the entire Conductor tab shows no activity with no user-facing error message.

**Impact**  
Users opening Conductor in a default setup (no gateway running) see a blank/broken UI with no explanation.

**Fix**  
Added a gateway connectivity check at component mount time. When the gateway is unreachable, the UI shows a clear "Hermes Gateway is not running" message with setup instructions rather than a blank screen.

---

### ISSUE-10 — sqlite3 CLI required for kanban backend detection  
**Severity**: Low  
**File(s)**: `src/server/kanban-backend.ts`

**Problem**  
`runSqlite()` calls `execFileSync('sqlite3', ...)` to query `kanban.db`. This requires the `sqlite3` CLI tool to be installed system-wide (`apt install sqlite3`). If it's absent, the detection throws and the server falls back to the local JSON store — but the error is not surfaced.

**Impact**  
On a fresh Debian install without `sqlite3` CLI, the kanban backend silently uses the JSON store. Tasks created in the hermes agent dashboard are not visible in the workspace.

**Fix**  
Added `sqlite3` to the `apt` install list in `install.sh` and `Dockerfile`. Also switched to using the `better-sqlite3` npm package (already a transitive dependency) for reads instead of shelling out to the CLI tool.

---

### ISSUE-11 — resolveHermesBin() silently returns bare "hermes" as last resort  
**Severity**: Medium  
**File(s)**: `src/routes/api/swarm-dispatch.ts`

**Problem**  
`resolveHermesBin()` tries `HERMES_CLI_BIN`, `~/.hermes/hermes-agent/venv/bin/hermes`, `~/.local/bin/hermes`, then falls back to the bare string `'hermes'`. When none of the explicit paths exist, `execFile('hermes', ...)` will fail with `ENOENT` only at dispatch time — the worker shows an error but the user is not told that the binary is missing at startup.

**Impact**  
Workers fail to execute with cryptic errors like "spawn hermes ENOENT" rather than a clear "hermes CLI not installed" message.

**Fix**  
Added startup validation in the swarm scheduler: checks that `resolveHermesBin()` resolves to an accessible binary before starting the loop. If not, logs a clear warning and disables dispatch (orchestrator loop still runs in check-only mode). Also added the check to the new `/api/swarm-health` endpoint.

---

### ISSUE-12 — No /api/swarm-health endpoint  
**Severity**: Medium  
**File(s)**: (missing endpoint)

**Problem**  
Multiple components reference `/api/swarm-health` (including `SWARM2_REAL_API_ENDPOINTS` in `swarm2-screen.tsx`) but the route does not exist in the codebase. Any component that GETs this endpoint gets a 404.

**Impact**  
Health status display in the Swarm2 screen is broken. No way to check readiness from the UI or external monitoring.

**Fix**  
Created `src/routes/api/swarm-health.ts` that returns binary checks for: hermes CLI presence, tmux availability, profiles directory, swarm.yaml existence, hermes agent gateway connectivity, and current swarm mode.

---

## Files Changed

| File | Change |
|------|--------|
| `src/server/swarm-orchestration-scheduler.ts` | **New** — server-side 60s polling loop |
| `src/routes/api/swarm-health.ts` | **New** — health check endpoint |
| `src/routes/api/swarm-profiles-bootstrap.ts` | **New** — auto-create profile dirs from swarm.yaml |
| `server-entry.js` | Modified — import and start scheduler |
| `src/server/swarm-environment.ts` | Modified — `HERMES_WORKSPACE_ROOT` env var support |
| `src/server/swarm-foundation.ts` | Modified — fallback to roster when profiles dir empty |
| `src/server/swarm-notifications.ts` | Modified — async execFile instead of execFileSync |
| `src/routes/api/swarm-dispatch.ts` | Modified — call ensureSwarmProfileConfig in runWorker |
| `src/routes/api/swarm-orchestrator-loop.ts` | Modified — autoContinue defaults to true in auto mode |
| `src/routes/api/conductor-spawn.ts` | Modified — inline skill fallback |
| `skills/workspace-dispatch/SKILL.md` | **New** — workspace dispatch skill |
| `.env.example` | Modified — document HERMES_WORKSPACE_ROOT |
| `install.sh` | Modified — add sqlite3 to apt deps |
| `routeTree.gen.ts` | Modified — register new routes |

---

## Verification

After applying all fixes:

```bash
# 1. Start the server
pnpm build && node server-entry.js

# 2. Check health endpoint
curl http://localhost:3000/api/swarm-health

# 3. Observe scheduler logs (should see loop firing every 60s)
# Look for: [swarm-scheduler] loop tick

# 4. Create a kanban card with status=ready and assignedWorker=builder
# → Watch logs for dispatch to builder worker

# 5. Check orchestrator loop ran
curl -X POST http://localhost:3000/api/swarm-orchestrator-loop \
  -H "Content-Type: application/json" \
  -d '{"autoContinue": true}'
```
