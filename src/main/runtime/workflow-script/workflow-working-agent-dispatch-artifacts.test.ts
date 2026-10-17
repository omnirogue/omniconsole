import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import {
  markWorkingAgentStartInFlight,
  prepareWorkingAgentCall
} from './workflow-working-agent-calls'
import { captureWorkingAgentDispatchArtifacts } from './workflow-working-agent-dispatch-artifacts'
import type { WorkflowProgramCall } from './workflow-program-context'

const roots: string[] = []
const opened: OrchestrationDb[] = []
afterEach(() => {
  opened.splice(0).forEach((db) => db.close())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'working-dispatch-artifacts-'))
  roots.push(root)
  const source = join(root, 'source')
  const child = join(root, 'child')
  execFileSync('git', ['init', '-q', source])
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim()
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  writeFileSync(join(source, 'index.html'), '<h1>Base</h1>')
  git('add', 'index.html')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  git('worktree', 'add', '-qb', 'candidate', child)
  writeFileSync(join(child, 'index.html'), '<h1>Candidate</h1>')
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const executionId = new WorkflowCheckpointStore(db.db).create({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot: { version: 1, capability: { mode: 'working-agent', revision: 1 } },
    preset: 'council',
    fence: 1,
    attemptLimit: 1,
    callLimit: 7,
    budgetLimit: 7
  })
  const run = db.createRun({
    objective: 'Build HTML',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const task = db.createTask({ runId: run.id, spec: 'Build HTML' })
  const call: WorkflowProgramCall = {
    id: 'answers/seat-1',
    prompt: 'Build index.html',
    schema: {
      type: 'object',
      properties: { markdown: { type: 'string' } },
      required: ['markdown']
    },
    semantic: { kind: 'none' },
    validateSemantics: () => null,
    seatId: 'seat-1',
    dependencies: []
  }
  prepareWorkingAgentCall(db, {
    executionId,
    runId: run.id,
    taskId: task.id,
    workspaceId: `repo::${source}`,
    sourceBase: base,
    sourceDiffDigest: 'b'.repeat(64),
    seatFingerprint: 'claude:account:model',
    call
  })
  markWorkingAgentStartInFlight(db, executionId, call.id)
  const dispatch = createRootDispatch(db, task.id, 'term_worker')
  const resource = db.createWorkerTerminalResourceStatement({
    dispatchId: dispatch.id,
    worktreeId: `repo::${child}`,
    terminalHandle: 'term_worker',
    paneKey: null,
    processIncarnation: null,
    ownership: 'owned'
  })
  return { db, source, child, dispatchId: dispatch.id, taskId: task.id, resourceId: resource.id }
}

describe('working Dispatch candidate artifact binding', () => {
  it('captures only its private child and pins that identity', async () => {
    const f = fixture()
    const captured = await captureWorkingAgentDispatchArtifacts(f.db, f.dispatchId)
    expect(captured?.files.map((file) => file.relativePath)).toEqual(['index.html'])
    expect(captured?.files[0].contentPreview).toBe('<h1>Candidate</h1>')
    expect(captured?.diff).not.toContain(f.child)
    const row = f.db.db
      .prepare('SELECT child_worktree_id FROM local_workflow_worker_calls WHERE task_id=?')
      .get(f.taskId) as { child_worktree_id: string }
    expect(row.child_worktree_id).toBe(`repo::${f.child}`)
    writeFileSync(join(f.child, 'index.html'), '<h1>Changed after submit</h1>')
    expect((await captureWorkingAgentDispatchArtifacts(f.db, f.dispatchId))?.digest).not.toBe(
      captured?.digest
    )
  })

  it('refuses a Dispatch resource redirected into the original workspace', async () => {
    const f = fixture()
    f.db.db
      .prepare('UPDATE worker_terminal_resources SET worktree_id=? WHERE id=?')
      .run(`repo::${f.source}`, f.resourceId)
    await expect(captureWorkingAgentDispatchArtifacts(f.db, f.dispatchId)).rejects.toThrow(
      /child worktree identity/
    )
  })
})
