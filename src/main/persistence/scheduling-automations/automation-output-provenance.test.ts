import { describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRunOutputSnapshot } from '../../../shared/automations-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { ProtectedSecretPersistence } from '../../protected-secret-persistence'
import { StateSerializationSecretHandlingOperations } from '../loading-store/state-serialization-secret-handling'
import {
  createAutomationRun,
  updateAutomationRun,
  type AutomationRunOperations
} from './automation-run-operations'

const snapshotFields: AutomationRunOutputSnapshot = {
  format: 'plain_text',
  content: '  Completed the review.\nNo changes recommended.  ',
  capturedAt: 1_800_000_000_000,
  truncated: true
}

function harness() {
  const automation: Automation = {
    id: 'automation-1',
    name: 'Review',
    prompt: 'Review the observed results.',
    precheck: null,
    agentId: 'codex',
    projectId: 'project-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: 'workspace-1',
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: false,
    nextRunAt: 1,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 30,
    createdAt: 1,
    updatedAt: 1
  }
  const state = getDefaultPersistedState('automation-output-provenance-fixture')
  state.automations = [automation]
  const ops: AutomationRunOperations = {
    state,
    flush: vi.fn(),
    recordManualRun: vi.fn(),
    getWorkspaceDisplayName: () => 'Fixture workspace'
  }
  const run = createAutomationRun(ops, automation, 1, 'manual')
  return { ops, run }
}

function serializeAndRestore(ops: AutomationRunOperations): AutomationRunOutputSnapshot | null {
  const serializer = new StateSerializationSecretHandlingOperations({
    state: ops.state,
    protectedSecrets: new ProtectedSecretPersistence()
  })
  const durable: Omit<PersistedState, 'githubCache'> = JSON.parse(
    serializer.buildStateToSave().payload
  )
  ops.state = { ...durable, githubCache: { pr: {}, issue: {} } }
  return ops.state.automationRuns[0]!.outputSnapshot
}

describe('automation output provenance persistence', () => {
  it.each(['assistant_message', 'terminal_capture'] as const)(
    'preserves exact snapshot fields and %s provenance through writes and serialization',
    (provenance) => {
      const { ops, run } = harness()
      const snapshot: AutomationRunOutputSnapshot = { ...snapshotFields, provenance }

      const completed = updateAutomationRun(ops, {
        runId: run.id,
        status: 'completed',
        outputSnapshot: snapshot
      })

      expect(completed.outputSnapshot).toStrictEqual(snapshot)
      expect(serializeAndRestore(ops)).toStrictEqual(snapshot)

      const followUp = updateAutomationRun(ops, {
        runId: run.id,
        status: 'completed',
        error: 'A follow-up result without a new snapshot'
      })

      expect(followUp.outputSnapshot).toStrictEqual(snapshot)
      expect(serializeAndRestore(ops)).toStrictEqual(snapshot)
    }
  )

  it.each([
    'Completed the review. No changes recommended.',
    'assistant_message\nAssistant: Completed the review.',
    '❯ run\n● Assistant: Completed the review.'
  ])('never infers provenance for a legacy snapshot from content: %j', (content) => {
    const { ops, run } = harness()
    const legacy: AutomationRunOutputSnapshot = { ...snapshotFields, content }
    run.outputSnapshot = legacy

    const updated = updateAutomationRun(ops, { runId: run.id, status: 'completed' })

    expect(updated.outputSnapshot).toStrictEqual(legacy)
    expect(updated.outputSnapshot).not.toHaveProperty('provenance')
    expect(serializeAndRestore(ops)).toStrictEqual(legacy)
    expect(ops.state.automationRuns[0]!.outputSnapshot).not.toHaveProperty('provenance')
  })

  it.each([undefined, null, 'unknown', 'ASSISTANT_MESSAGE', 'assistant_message ', 17])(
    'drops unsupported provenance %j on incoming and previously stored snapshots',
    (provenance) => {
      for (const source of ['incoming', 'stored'] as const) {
        const { ops, run } = harness()
        const malformed: AutomationRunOutputSnapshot = {
          ...snapshotFields,
          provenance: provenance as AutomationRunOutputSnapshot['provenance']
        }
        if (source === 'stored') {
          run.outputSnapshot = malformed
        }

        const updated = updateAutomationRun(ops, {
          runId: run.id,
          status: 'completed',
          ...(source === 'incoming' ? { outputSnapshot: malformed } : {})
        })

        expect(updated.outputSnapshot).toStrictEqual(snapshotFields)
        expect(updated.outputSnapshot).not.toHaveProperty('provenance')
        expect(serializeAndRestore(ops)).toStrictEqual(snapshotFields)
        expect(ops.state.automationRuns[0]!.outputSnapshot).not.toHaveProperty('provenance')
      }
    }
  )

  it('clears the complete snapshot, including provenance, on an explicit null update', () => {
    const { ops, run } = harness()
    updateAutomationRun(ops, {
      runId: run.id,
      status: 'completed',
      outputSnapshot: { ...snapshotFields, provenance: 'assistant_message' }
    })

    const cleared = updateAutomationRun(ops, {
      runId: run.id,
      status: 'completed',
      outputSnapshot: null
    })

    expect(cleared.outputSnapshot).toBeNull()
    expect(serializeAndRestore(ops)).toBeNull()
  })
})
