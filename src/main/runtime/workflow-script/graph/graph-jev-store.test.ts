import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GraphJevStore, graphFindHasRetryableScreenFailure } from './graph-jev-store'
import {
  localWorkflowFindRequestSchema,
  localWorkflowFindSpec
} from '../../../../shared/local-workflow-find-request'
import type { WorkflowRoute } from '../../../../shared/workflow-graph'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'

const ROUTES: WorkflowRoute[] = ['claude', 'codex']

let dir = ''
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('graphFindHasRetryableScreenFailure', () => {
  it('is false for a non-Find spec (nothing to screen)', () => {
    dir = mkdtempSync(join(tmpdir(), 'jev-store-'))
    const store = GraphJevStore.forExecution('exec', dir)
    expect(graphFindHasRetryableScreenFailure(workflowTemplate('council', ROUTES), store)).toBe(
      false
    )
  })

  it('is true when the store has no record at all for the screen call: a transient failure was never cached', () => {
    dir = mkdtempSync(join(tmpdir(), 'jev-store-'))
    const store = GraphJevStore.forExecution('exec', dir)
    const spec = localWorkflowFindSpec(
      localWorkflowFindRequestSchema.parse({ prompt: 'Best crate', items: ['A', 'B'] }),
      ROUTES,
      []
    )
    expect(graphFindHasRetryableScreenFailure(spec, store)).toBe(true)
  })

  it('is true when every recorded page succeeded but the run still failed: the missing page was transient', () => {
    dir = mkdtempSync(join(tmpdir(), 'jev-store-'))
    const store = GraphJevStore.forExecution('exec', dir)
    const spec = localWorkflowFindSpec(
      localWorkflowFindRequestSchema.parse({ prompt: 'Best crate', items: ['A', 'B'] }),
      ROUTES,
      []
    )
    store.write('judge/screen/page.1', {
      digest: 'd1',
      outcome: { value: { scores: { a: 3 }, criteria: [], unscored: [] } },
      at: 1
    })
    expect(graphFindHasRetryableScreenFailure(spec, store)).toBe(true)
  })

  it('is false when a permanent (non-retryable) failure is on record for the screen call', () => {
    dir = mkdtempSync(join(tmpdir(), 'jev-store-'))
    const store = GraphJevStore.forExecution('exec', dir)
    const spec = localWorkflowFindSpec(
      localWorkflowFindRequestSchema.parse({ prompt: 'Best crate', items: ['A', 'B'] }),
      ROUTES,
      []
    )
    store.write('judge/screen', {
      digest: 'd1',
      outcome: { value: { markdown: 'x', error: 'no TypeSafe API key' } },
      detail: 'no TypeSafe API key',
      at: 1
    })
    expect(graphFindHasRetryableScreenFailure(spec, store)).toBe(false)
  })
})
