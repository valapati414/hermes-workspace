/**
 * POST /api/swarm-profiles-bootstrap
 *
 * Creates profile directories and bootstraps config for every worker listed in
 * swarm.yaml that doesn't already have a profile directory. Call this once after
 * a fresh install to prepare worker profiles before the first dispatch.
 *
 * The orchestration scheduler also calls this internally at startup.
 */

import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isAuthenticated } from '../../server/auth-middleware'
import { readSwarmRoster } from '../../server/swarm-roster'
import { getProfilesDir } from '../../server/claude-paths'
import { ensureSwarmProfileConfig } from '../../server/swarm-profile-config'

export const Route = createFileRoute('/api/swarm-profiles-bootstrap')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        const profilesDir = getProfilesDir()
        mkdirSync(profilesDir, { recursive: true })

        const roster = readSwarmRoster()
        const results = roster.workers.map((worker) => {
          const profilePath = join(profilesDir, worker.id)
          const existed = existsSync(profilePath)
          let bootstrapped = false
          let error: string | undefined

          try {
            const r = ensureSwarmProfileConfig(profilePath)
            bootstrapped = r.ok
            if (!r.ok) error = r.error
          } catch (err) {
            error = err instanceof Error ? err.message : String(err)
          }

          return { workerId: worker.id, existed, bootstrapped, error: error ?? null }
        })

        const created = results.filter((r) => !r.existed).length
        const failed = results.filter((r) => r.error).length

        return json({
          ok: failed === 0,
          profilesDir,
          workers: results,
          summary: { total: results.length, created, failed },
        })
      },
    },
  },
})
