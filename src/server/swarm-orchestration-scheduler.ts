/**
 * swarm-orchestration-scheduler.ts
 *
 * Server-side heartbeat that fires the orchestrator loop at a regular interval
 * when swarm mode is 'auto'. This is the missing piece that makes autonomous
 * multi-agent orchestration work: without it the orchestrator loop endpoint
 * exists but is never called, so workers' checkpoints are never read and
 * follow-up tasks are never dispatched.
 *
 * Call `startOrchestrationScheduler()` once at server startup.
 */

import { readSwarmMode } from './swarm-mode'
import { listSwarmWorkerIds } from './swarm-foundation'
import { readSwarmKanban, writeSwarmKanban } from './swarm-kanban-store'

const LOOP_INTERVAL_MS = parseInt(process.env.SWARM_LOOP_INTERVAL_MS ?? '60000', 10)
const DISPATCH_URL_BASE = process.env.SWARM_SCHEDULER_BASE_URL ?? 'http://127.0.0.1:3000'
const MAX_CONSECUTIVE_ERRORS = 5

let schedulerStarted = false
let consecutiveErrors = 0

/**
 * Bootstrap worker profile directories from swarm.yaml on startup.
 * Workers cannot be dispatched without a profile directory.
 */
async function bootstrapWorkerProfiles(port: number): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    const res = await fetch(`${baseUrl}/api/swarm-profiles-bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-scheduler': '1' },
    })
    if (res.ok) {
      const data = (await res.json()) as { summary?: { created: number; total: number; failed: number } }
      const s = data.summary
      if (s) {
        console.log(`[swarm-scheduler] profiles bootstrap — total:${s.total} created:${s.created} failed:${s.failed}`)
      }
    }
  } catch (err) {
    console.warn('[swarm-scheduler] profiles bootstrap warning:', err)
  }
}

/**
 * Dispatch kanban cards that are in 'ready' status and have an assigned worker.
 * This bridges the planning board to actual agent execution.
 */
async function dispatchReadyKanbanCards(): Promise<void> {
  let kanban
  try {
    kanban = readSwarmKanban()
  } catch {
    return
  }

  const readyCards = kanban.cards.filter(
    (card) =>
      (card.status === 'ready' || card.status === 'todo') &&
      typeof (card as Record<string, unknown>).assignedWorker === 'string' &&
      ((card as Record<string, unknown>).assignedWorker as string).trim(),
  )

  if (readyCards.length === 0) return

  for (const card of readyCards) {
    const workerId = ((card as Record<string, unknown>).assignedWorker as string).trim()
    const task = card.title + (card.description ? `\n\n${card.description}` : '')

    try {
      const res = await fetch(`${DISPATCH_URL_BASE}/api/swarm-dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-scheduler': '1' },
        body: JSON.stringify({
          assignments: [{ workerId, task, rationale: 'Auto-dispatched from kanban ready lane' }],
          waitForCheckpoint: false,
        }),
      })

      if (res.ok) {
        // Transition card to 'running'
        const updated = kanban.cards.map((c) =>
          c.id === card.id ? { ...c, status: 'running' as const } : c,
        )
        writeSwarmKanban({ cards: updated })
        console.log(`[swarm-scheduler] dispatched kanban card "${card.title}" → ${workerId}`)
      } else {
        console.warn(`[swarm-scheduler] failed to dispatch card "${card.title}": HTTP ${res.status}`)
      }
    } catch (err) {
      console.warn(`[swarm-scheduler] error dispatching card "${card.title}":`, err)
    }
  }
}

/**
 * Run one orchestrator loop iteration: read worker checkpoints, publish
 * summaries, and auto-dispatch follow-up tasks when autoContinue is enabled.
 */
async function runOrchestratorLoop(port: number): Promise<void> {
  const workerIds = listSwarmWorkerIds()
  if (workerIds.length === 0) {
    console.log('[swarm-scheduler] no workers found — skipping loop tick')
    return
  }

  const baseUrl = `http://127.0.0.1:${port}`
  const body = {
    autoContinue: true,
    allowExecution: true,
    staleMinutes: 10,
    workerIds,
  }

  const res = await fetch(`${baseUrl}/api/swarm-orchestrator-loop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-scheduler': '1' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`orchestrator-loop returned HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = (await res.json()) as Record<string, unknown>
  const summary = data.summary as Record<string, number> | undefined
  if (summary) {
    console.log(
      `[swarm-scheduler] loop tick — checkpointed:${summary.checkpointed ?? 0} stale:${summary.stale ?? 0} waiting:${summary.waiting ?? 0} unavailable:${summary.unavailable ?? 0}`,
    )
  }
}

/**
 * Start the background orchestration scheduler.
 * Safe to call multiple times — only starts once.
 */
export function startOrchestrationScheduler(port: number = 3000): void {
  if (schedulerStarted) return
  schedulerStarted = true

  console.log(`[swarm-scheduler] starting — interval ${LOOP_INTERVAL_MS}ms, target port ${port}`)

  const tick = async () => {
    const mode = readSwarmMode()
    if (mode.mode !== 'auto') {
      console.log('[swarm-scheduler] mode is manual — skipping tick')
      consecutiveErrors = 0
      return
    }

    try {
      await dispatchReadyKanbanCards()
      await runOrchestratorLoop(port)
      consecutiveErrors = 0
    } catch (err) {
      consecutiveErrors++
      console.error(`[swarm-scheduler] error (consecutive: ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err)
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error('[swarm-scheduler] too many consecutive errors — pausing for 5 minutes')
        await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000))
        consecutiveErrors = 0
      }
    }
  }

  // Give the server a moment to finish binding before the first tick.
  setTimeout(() => {
    void bootstrapWorkerProfiles(port)
    void tick()
    setInterval(() => { void tick() }, LOOP_INTERVAL_MS)
  }, 5000)
}
