import { describe, expect, it } from 'vitest'
import type { LocalRunNode } from '../../../shared/local-run-graph'
import {
  DEFAULT_SESSION_ACTION_TEMPLATES,
  SESSION_ACTION_PRESET_IDS
} from '../../../shared/session-action-presets'
import { buildLocalRunNodeSpec } from './local-run-briefs'

function specFor(presetId: LocalRunNode['presetId']): string {
  return buildLocalRunNodeSpec({
    node: {
      id: 'cut',
      actor: { agent: 'codex' },
      presetId,
      objective: 'cut a 30 second promo',
      deps: []
    },
    workspacePath: '/work/promo',
    outputDir: '/work/promo/.omni/runs/run_1/task_1',
    reportPath: '/work/promo/.omni/runs/run_1/task_1.md',
    inputs: []
  })
}

describe('buildLocalRunNodeSpec', () => {
  it('tells every worker to decide and proceed, and to record the decision', () => {
    // A local run is one person's own work: nobody is watching the mailbox, so a
    // worker that stops for a preference stalls the whole graph.
    for (const presetId of SESSION_ACTION_PRESET_IDS) {
      const spec = specFor(presetId)

      expect(spec).toContain('Decide and proceed.')
      expect(spec).toContain('Write every decision you made, and why, into your report.')
      expect(spec).toContain('Ask ONLY if you are truly blocked')
      expect(spec).toContain('never stop silently in your terminal')
    }
  })

  it('assumes no code: no build, test suite or git unless the workspace names one', () => {
    for (const presetId of SESSION_ACTION_PRESET_IDS) {
      expect(specFor(presetId)).toContain(
        'run no build, no test suite and no git command unless the objective or a file in the workspace names one'
      )
    }
    // The preset templates themselves stay folder-first: nothing names a repository,
    // a branch or a package manager.
    for (const template of Object.values(DEFAULT_SESSION_ACTION_TEMPLATES)) {
      expect(template).not.toMatch(/\b(git|repository|repo|branch|npm|pnpm|yarn|commit)\b/i)
    }
  })

  it('still dictates the report path and the single worker_done', () => {
    const spec = specFor('implement')

    expect(spec).toContain('Report file: /work/promo/.omni/runs/run_1/task_1.md')
    expect(spec).toContain('Send worker_done exactly once')
  })
})
