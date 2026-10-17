import type { LocalRunNode } from '../../../../shared/local-run-graph'
import type { LocalRunNodeSnapshot, LocalRunSnapshot } from '../../../../shared/local-run-types'

/** A folder workspace with a fan-out: two cuts in their own run subfolders, then a fold. */
export function localRunNodeFixture(
  patch: Partial<LocalRunNodeSnapshot> = {}
): LocalRunNodeSnapshot {
  return {
    id: 'cut-a',
    actor: { agent: 'codex' },
    presetId: 'implement',
    state: 'completed',
    taskId: 'task_a',
    dispatchId: 'dsp_a',
    terminalHandle: 'term_a',
    placement: null,
    reportPath: null,
    outputDir: null,
    manifestPath: null,
    producedFiles: [],
    gateId: null,
    gateQuestion: null,
    question: null,
    deliveryId: null,
    error: null,
    ...patch
  }
}

export function localRunGraphNodeFixture(patch: Partial<LocalRunNode> = {}): LocalRunNode {
  return {
    id: 'cut-a',
    actor: { agent: 'codex' },
    presetId: 'implement',
    objective: 'Produce cut A',
    deps: [],
    ...patch
  }
}

export function localRunFixture(patch: Partial<LocalRunSnapshot> = {}): LocalRunSnapshot {
  const workspacePath = patch.workspacePath ?? '/Users/me/Webinar'
  return {
    id: 'lrn_1',
    runId: 'run_1',
    workspacePath,
    workspaceId: 'folder:1',
    workspaceKind: 'folder',
    coordinatorTerminalHandle: 'term_coordinator',
    stage: 'running',
    maxConcurrent: 3,
    graph: {
      workspacePath,
      maxConcurrent: 3,
      nodes: [
        localRunGraphNodeFixture({ id: 'cut-a', objective: 'Produce cut A' }),
        localRunGraphNodeFixture({ id: 'cut-b', objective: 'Produce cut B' }),
        localRunGraphNodeFixture({
          id: 'fold',
          presetId: 'synthesize',
          objective: 'Fold the cuts together',
          deps: ['cut-a', 'cut-b']
        })
      ]
    },
    nodes: [
      localRunNodeFixture({
        id: 'cut-a',
        state: 'completed',
        placement: { worktree: 'current', cwd: `${workspacePath}/.omni/runs/run_1/task_a` },
        outputDir: `${workspacePath}/.omni/runs/run_1/task_a`,
        manifestPath: `${workspacePath}/.omni/runs/run_1/task_a/manifest.md`,
        reportPath: `${workspacePath}/.omni/runs/run_1/task_a.md`,
        producedFiles: [`${workspacePath}/.omni/runs/run_1/task_a/cut-a.mp4`]
      }),
      localRunNodeFixture({
        id: 'cut-b',
        state: 'running',
        taskId: 'task_b',
        dispatchId: 'dsp_b',
        terminalHandle: 'term_b',
        placement: { worktree: 'current', cwd: `${workspacePath}/.omni/runs/run_1/task_b` },
        outputDir: `${workspacePath}/.omni/runs/run_1/task_b`
      }),
      localRunNodeFixture({
        id: 'fold',
        presetId: 'synthesize',
        state: 'queued',
        taskId: 'task_fold',
        dispatchId: null,
        terminalHandle: null
      })
    ],
    events: [
      { at: '2026-09-10T10:00:00.000Z', kind: 'info', node: 'run', text: 'Created 3 task(s)' },
      { at: '2026-09-10T10:01:00.000Z', kind: 'node', node: 'cut-a', text: 'cut-a produced 1 file' }
    ],
    error: null,
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:02:00.000Z',
    ...patch
  }
}
