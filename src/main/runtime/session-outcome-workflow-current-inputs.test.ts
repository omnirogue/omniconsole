import { expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { captureSessionOutcomeCurrentRoutes } from './session-outcome-workflow-current-inputs'
import { installSessionOutcomeWorkflowPort } from './session-outcome-workflow-port'
import type { SessionOutcomeWorkflowPort } from './session-outcome-workflow-port'
import type { OrcaRuntimeService } from './omni-runtime'
function fixture() {
  const { workflow } = workflowProofFixture()
  for (const node of workflow.preview.graph.nodes) {
    node.workspace = { kind: 'folder', host: 'local', path: '/folder' }
  }
  const old = {
    worktreeId: 'folder',
    steps: [],
    outcomeSet: {
      workflow,
      continuation: { taskId: 'btk_root', principal: 'person' },
      outcomes: [
        {
          id: 'build',
          dependsOn: [],
          stepIds: [],
          conditions: [{ kind: 'file', target: 'chosen/report.txt' }],
          actions: []
        },
        {
          id: 'unrelated',
          dependsOn: [],
          stepIds: [],
          conditions: [{ kind: 'file', target: 'private-unselected.txt' }],
          actions: []
        }
      ]
    }
  } as unknown as SessionChain
  const current = {
    ...old,
    steps: [
      {
        id: 'new-review',
        agent: 'codex',
        model: 'gpt-6-astra',
        prompt: 'Review current file.',
        status: 'queued',
        review: {
          groupId: 'new',
          reviewerId: 'astra',
          round: 1,
          maxRounds: 1,
          candidateVersion: 'pending'
        }
      }
    ],
    outcomeSet: {
      ...old.outcomeSet!,
      outcomes: [{ ...old.outcomeSet!.outcomes[0]!, stepIds: ['new-review'] }]
    }
  } as SessionChain
  const files = [
    {
      rel: 'uploads/report.txt',
      name: 'report.txt',
      sha256: 'a'.repeat(64),
      size_bytes: 12,
      target_path: 'chosen/report.txt'
    }
  ]
  const capture = vi.fn(async () => files)
  installSessionOutcomeWorkflowPort({
    captureCurrentInputs: capture
  } as unknown as SessionOutcomeWorkflowPort)
  return { old, current, capture, files }
}
it('captures only explicit prior files in the owning outcome scope and keeps original producer model for review-current', async () => {
  const { old, current, capture, files } = fixture()
  const routes = await captureSessionOutcomeCurrentRoutes({} as OrcaRuntimeService, current, old)
  expect(capture).toHaveBeenCalledWith(
    {},
    {
      taskId: 'btk_root',
      principal: 'person',
      worktree: 'id:folder',
      selectedSourcePaths: ['chosen/report.txt']
    }
  )
  expect(routes.get('new-review')).toEqual({
    provider: 'codex',
    model: 'gpt-5.6-terra',
    effort: 'high',
    files
  })
})
it('does not substitute whole-folder capture when no selected prior paths exist', async () => {
  const { old, current, capture } = fixture()
  old.outcomeSet!.outcomes[0]!.conditions = []
  await expect(
    captureSessionOutcomeCurrentRoutes({} as OrcaRuntimeService, current, old)
  ).rejects.toThrow('Choose explicit current folder files')
  expect(capture).not.toHaveBeenCalled()
})
it('passes capture authority failures through before an outcome preview can be admitted', async () => {
  const { old, current, capture } = fixture()
  capture.mockRejectedValueOnce(new Error('Signed owner changed'))
  await expect(
    captureSessionOutcomeCurrentRoutes({} as OrcaRuntimeService, current, old)
  ).rejects.toThrow('Signed owner changed')
})

it('uses the retained completed source for initial roots without requiring prior workflow receipts or manual file conditions', async () => {
  const { current, capture, files } = fixture()
  current.outcomeSet!.workflow = undefined
  current.outcomeSet!.outcomes[0]!.conditions = []
  current.outcomeSet!.continuation.initialSource = {
    sourceVersion: 'completed-turn',
    paneKey: 'source',
    worktreeId: 'folder',
    handle: 'handle',
    processIncarnation: 'incarnation',
    producer: { provider: 'codex', model: 'actual-source-model' },
    effort: 'high',
    files,
    git: { head_sha: 'b'.repeat(40), deleted_paths: ['removed.md'] }
  }
  const routes = await captureSessionOutcomeCurrentRoutes({} as OrcaRuntimeService, current)
  expect(routes.get('new-review')).toEqual({
    provider: 'codex',
    model: 'actual-source-model',
    effort: 'high',
    files,
    producer: { provider: 'codex', model: 'actual-source-model' },
    git: { head_sha: 'b'.repeat(40), deleted_paths: ['removed.md'] }
  })
  expect(capture).not.toHaveBeenCalled()
})

it('does not replace a later dependent stage input with the original source snapshot', async () => {
  const { current, files } = fixture()
  current.outcomeSet!.workflow = undefined
  current.outcomeSet!.continuation.initialSource = {
    sourceVersion: 'done',
    paneKey: 'source',
    worktreeId: 'folder',
    handle: 'handle',
    processIncarnation: 'incarnation',
    producer: { provider: 'codex', model: 'actual' },
    files
  }
  const first = current.outcomeSet!.outcomes[0]!
  current.steps.push({
    id: 'later',
    agent: 'codex',
    model: 'next',
    prompt: 'Use reviewed work.',
    status: 'queued'
  })
  current.outcomeSet!.outcomes.push({
    ...first,
    id: 'dependent',
    dependsOn: [first.id],
    stepIds: ['later']
  })
  const routes = await captureSessionOutcomeCurrentRoutes({} as OrcaRuntimeService, current)
  expect([...routes.keys()]).toEqual(['new-review'])
})
