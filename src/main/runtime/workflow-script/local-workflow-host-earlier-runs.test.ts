import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalWorkflowGraphDraft } from '../../../shared/local-workflow-draft'
import { workflowTemplate } from '../../../shared/workflow-graph-templates'
import type { LocalWorkflowStartRequest } from '../../../shared/local-workflow-rpc'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { closeHostFixtures, hostCatalog, hostFixture } from './local-workflow-host.test-fixtures'
import { readDiscoverFocusFinding } from './discover-focus-finding'
import type { DiscoverOmniosFinding } from '../../../shared/discover-omnios-page'
import { EARLIER_RUNS_ENV } from './workflow-earlier-findings'
import { workflowEarlierSettledReader } from './workflow-earlier-settled'
import type { WorkflowRunTarget } from '../../../shared/workflow-run-result'

vi.mock(import('./discover-focus-finding'), async (original) => ({
  ...(await original()),
  readDiscoverFocusFinding: vi.fn()
}))
// The earlier run here is a bare row; its settled result stands in for a projection of it.
vi.mock(import('./workflow-earlier-settled'), () => ({
  workflowEarlierSettledReader: vi.fn(
    () => (executionId: string) =>
      executionId === 'earlier'
        ? {
            targets: [
              {
                key: 'find.r1.1',
                title: 'Cache key ignores locale',
                location: 'src/cache.ts:3',
                severity: 'high',
                tally: 'confirmed'
              } as WorkflowRunTarget
            ],
            actedOn: new Set<string>()
          }
        : undefined
  )
}))

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeHostFixtures()
})

function discoverRequest(requestId: string, skipEarlierRuns = false): LocalWorkflowStartRequest {
  const draft = createLocalWorkflowGraphDraft({
    prompt: 'Find bugs',
    concurrency: 2,
    skipEarlierRuns,
    graph: {
      spec: workflowTemplate('discover', ['claude', 'codex', 'grok']),
      team: hostCatalog.map(({ agent, accountId }, index) => ({
        id: `seat-${index + 1}`,
        agent,
        accountId
      }))
    }
  })
  return {
    worktree: 'workspace-a',
    conversationId: `conversation-${requestId}`,
    requestId,
    preset: 'discover',
    draft
  }
}

/** Admits each request up to its preflight, which keeps the snapshot and stops the run there. */
async function admitted(requests: LocalWorkflowStartRequest[], earlierRun = true) {
  const snapshots: LocalWorkflowHostSnapshot[] = []
  const f = await hostFixture({
    preflight: async (snapshot) => {
      snapshots.push(snapshot)
      throw new Error('Stopped after admission')
    }
  })
  if (earlierRun) {
    const snapshot = {
      graph: { spec: { template: 'discover' } },
      host: { workspaceId: 'workspace-a', startedAt: 1 }
    }
    f.db.db
      .prepare(
        `INSERT INTO local_workflow_executions (id, conversation_id, request_id, snapshot_json, snapshot_digest, preset, fence, state, attempt_limit, call_limit, budget_limit) VALUES ('earlier', 'earlier', 'earlier', ?, 'digest', 'discover', 1, 'completed', 1, 1, 1)`
      )
      .run(JSON.stringify({ snapshot }))
    f.db.db
      .prepare(
        `INSERT INTO local_workflow_calls (execution_id, call_id, input_digest, result_json) VALUES ('earlier', 'find/r1/scout.r1.1/a0', 'input', ?)`
      )
      .run(
        JSON.stringify({
          items: [
            { title: 'Cache key ignores locale', location: 'src/cache.ts:3', severity: 'high' }
          ]
        })
      )
  }
  for (const request of requests) {
    expect(await f.host.start(request)).toEqual({
      rejected: true,
      reason: 'Stopped after admission'
    })
  }
  return snapshots
}

describe('Start with the cross-run known list', () => {
  it('freezes the selected finding into the brief and removes its earlier title without isolation', async () => {
    vi.mocked(readDiscoverFocusFinding).mockReturnValue({
      n: 1,
      key: 'cache',
      title: 'Cache key ignores locale',
      location: 'src/cache.ts:3',
      detail: 'Evidence for the locale mismatch',
      why: 'Wrong page',
      next: 'Check the key'
    } as DiscoverOmniosFinding)
    const request = discoverRequest('focused')
    request.draft.focusFinding = 'earlier:1'
    const [snapshot] = await admitted([request])
    expect(snapshot.task.prompt).toContain('Evidence for the locale mismatch')
    expect(snapshot.host.focusFinding).toBe('earlier:1')
    expect(snapshot.host.earlierFindings?.titles).toEqual([])
    expect(snapshot.host.isolated).toBeUndefined()
    expect(readDiscoverFocusFinding).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'earlier:1',
      'workspace-a',
      expect.stringContaining('discover-omnios')
    )
  })

  it('freezes the earlier titles into a Discover run on the same workspace', async () => {
    const [snapshot] = await admitted([discoverRequest('request-1')])
    expect(snapshot.host.earlierFindings).toEqual({
      step: 'find',
      runs: ['earlier'],
      titles: ['Cache key ignores locale (src/cache.ts:3)'],
      holdRepeats: true
    })
    // Verdicts and the person's picks come from the run and its page folder.
    expect(workflowEarlierSettledReader).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('discover-omnios')
    )
  })

  it('starts without the list when asked, when the host turns it off, or with nothing earlier', async () => {
    const [skipped] = await admitted([discoverRequest('request-1', true)])
    vi.stubEnv(EARLIER_RUNS_ENV, '0')
    const [off] = await admitted([discoverRequest('request-2')])
    vi.unstubAllEnvs()
    const [none] = await admitted([discoverRequest('request-3')], false)
    for (const snapshot of [skipped, off, none]) {
      expect(snapshot.host).not.toHaveProperty('earlierFindings')
    }
    // Only the run that asked is isolated, which also keeps its results out of OmniOS.
    expect(skipped.host.isolated).toBe(true)
    expect(off.host).not.toHaveProperty('isolated')
    expect(none.host).not.toHaveProperty('isolated')
  })
})
