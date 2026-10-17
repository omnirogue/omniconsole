import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCurrentSnapshot } from '../../shared/session-outcome-current-inputs'
import type { OrcaRuntimeService } from './omni-runtime'
import { captureInitialSessionOutcomeSource } from './session-outcome-initial-source'
import {
  installSessionOutcomeWorkflowPort,
  type SessionOutcomeWorkflowPort
} from './session-outcome-workflow-port'

const { observe } = vi.hoisted(() => ({ observe: vi.fn() }))
vi.mock('./session-outcome-source', () => ({ observeSessionOutcomeSource: observe }))

const cleanups: (() => void)[] = []
beforeEach(() => {
  observe.mockReset().mockResolvedValue({ ready: true, version: 'turn-finished' })
})
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function fixture(git = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'outcome-initial-source-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ['result.md', 'condition.md', 'version.md', 'unmentioned.md', '.env']) {
    writeFileSync(join(root, name), name)
  }
  const context = {
    paneKey: 'source-pane',
    handle: 'agent-session:actual-source',
    processIncarnation: 'structured:actual-source',
    agent: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    summary: 'Completed the actual source.\n\nThe result includes **precise formatting**.\n',
    files: ['result.md', join(root, 'result.md'), 'missing.md', '../outside.md', '.env']
  }
  const scope = vi.fn(async () => ({ path: root }))
  const readContext = vi.fn(async () => context)
  const runtime = {
    getSessionOutcomeExecutionScope: scope,
    readSessionOutcomeSourceContext: readContext
  } as unknown as OrcaRuntimeService
  const snapshot: SessionOutcomeCurrentSnapshot = {
    files: [
      {
        rel: 'uploads/source-result.md',
        name: 'source-result.md',
        sha256: 'a'.repeat(64),
        size_bytes: 83,
        target_path: '.omni/runs/chain/source/source-result.md'
      }
    ],
    ...(git ? { git: { head_sha: 'b'.repeat(40), deleted_paths: ['obsolete.md'] } } : {})
  }
  const capture = vi.fn(async () => snapshot)
  installSessionOutcomeWorkflowPort({
    captureSourceInputs: capture
  } as unknown as SessionOutcomeWorkflowPort)
  const chain = {
    id: 'chain',
    worktreeId: 'destination-tree',
    sourceWorktreeId: 'source-tree',
    sourcePaneKey: context.paneKey,
    workspacePath: root,
    steps: [],
    outcomeSet: {
      revision: 1,
      continuation: {
        owner: 'execution-host',
        hostId: 'local',
        epoch: 'epoch',
        state: 'owned',
        taskId: 'btk_actual',
        principal: 'signed-person',
        sourceReady: true,
        sourceVersion: 'turn-finished',
        planningSource: {
          runId: 'run_pristine',
          projectionTaskId: 'task_pristine',
          coordinatorHandle: context.handle,
          processIncarnation: context.processIncarnation
        }
      },
      outcomes: [
        {
          id: 'review',
          conditions: [
            { id: 'file', kind: 'file', target: 'condition.md' },
            { id: 'review', kind: 'review', fileVersions: [{ path: 'version.md' }] },
            { id: 'future', kind: 'file', target: 'not-produced-yet.md' }
          ]
        }
      ]
    }
  } as unknown as SessionChain
  return { root, chain, runtime, context, snapshot, capture, scope, readContext }
}

it.each([false, true])(
  'captures the verified completed actor and exact source result for git=%s',
  async (git) => {
    const f = fixture(git)
    const result = await captureInitialSessionOutcomeSource(f.runtime, f.chain)
    expect(f.scope).toHaveBeenCalledWith('source-tree')
    expect(f.readContext).toHaveBeenCalledWith('source-pane', 'source-tree')
    expect(f.capture).toHaveBeenCalledWith(f.runtime, {
      taskId: 'btk_actual',
      principal: 'signed-person',
      worktree: 'id:source-tree',
      selectedSourcePaths: ['result.md', 'condition.md', 'version.md'],
      sourceResult: {
        path: expect.stringMatching(
          /^\.omni\/runs\/chain\/source_[a-f0-9]{24}\/source-result\.md$/
        ),
        content: f.context.summary
      }
    })
    expect(observe).toHaveBeenCalledWith(f.runtime, f.chain, { successfulOnly: true })
    expect(result.outcomeSet!.continuation.initialSource).toEqual({
      sourceVersion: 'turn-finished',
      paneKey: 'source-pane',
      worktreeId: 'source-tree',
      handle: f.context.handle,
      processIncarnation: f.context.processIncarnation,
      producer: { provider: 'codex', model: 'gpt-6-astra' },
      effort: 'high',
      ...f.snapshot
    })
    expect(f.chain.outcomeSet!.continuation.initialSource).toBeUndefined()
  }
)

it('does not read or capture a source that has not successfully completed', async () => {
  const f = fixture()
  f.chain.outcomeSet!.continuation.sourceReady = false
  await expect(captureInitialSessionOutcomeSource(f.runtime, f.chain)).rejects.toThrow(
    'Wait for the original source'
  )
  expect(f.readContext).not.toHaveBeenCalled()
  expect(f.capture).not.toHaveBeenCalled()
})

it.each(['unknown', 'pane', 'handle', 'incarnation'])(
  'refuses an %s source identity before uploading any files',
  async (mismatch) => {
    const f = fixture()
    if (mismatch === 'unknown') {
      f.readContext.mockResolvedValueOnce(null as never)
    }
    if (mismatch === 'pane') {
      f.context.paneKey = 'different-pane'
    }
    if (mismatch === 'handle') {
      f.context.handle = 'agent-session:replacement'
    }
    if (mismatch === 'incarnation') {
      f.context.processIncarnation = 'structured:replacement'
    }
    await expect(captureInitialSessionOutcomeSource(f.runtime, f.chain)).rejects.toThrow(
      'could not be verified'
    )
    expect(f.capture).not.toHaveBeenCalled()
  }
)

it.each([{ ready: false }, { ready: true, version: 'a-later-turn' }])(
  'does not retain uploaded inputs when completion changes during capture: %j',
  async (observation) => {
    const f = fixture()
    observe.mockResolvedValueOnce(observation)
    await expect(captureInitialSessionOutcomeSource(f.runtime, f.chain)).rejects.toThrow(
      'source changed'
    )
    expect(f.capture).toHaveBeenCalledOnce()
    expect(f.chain.outcomeSet!.continuation.initialSource).toBeUndefined()
  }
)

it('reuses the retained snapshot even if the original source has since changed', async () => {
  const f = fixture(true)
  const captured = await captureInitialSessionOutcomeSource(f.runtime, f.chain)
  f.capture.mockClear()
  f.scope.mockClear()
  f.readContext.mockClear()
  observe.mockClear().mockResolvedValue({ ready: false })
  expect(await captureInitialSessionOutcomeSource(f.runtime, captured)).toBe(captured)
  expect(f.scope).not.toHaveBeenCalled()
  expect(f.readContext).not.toHaveBeenCalled()
  expect(f.capture).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
})

it('requires the source execution host to capture its own files', async () => {
  const f = fixture()
  f.scope.mockResolvedValueOnce({ path: f.root, connectionId: 'paired-host' } as never)
  await expect(captureInitialSessionOutcomeSource(f.runtime, f.chain)).rejects.toThrow(
    'own execution host'
  )
  expect(f.readContext).not.toHaveBeenCalled()
  expect(f.capture).not.toHaveBeenCalled()
})
