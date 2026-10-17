// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { useCoreStore } from '../store/coreStore'
import type { ActionLogEntry } from '../store/coreStoreTypes'
import { useUiStore } from '../store/uiStore'
import { FleetSessionProjection } from './FleetSessionProjection'
import type { FleetSession } from './fleetTypes'

type PollLog = Omit<ActionLogEntry, 'id' | 'timestamp'>

const activeSession: FleetSession = {
  id: 'live-session',
  agent_name: 'claude',
  task_summary: 'Prepare customer response',
  agent_status: 'working'
}

beforeEach(() => {
  useCoreStore.setState(useCoreStore.getInitialState(), true)
  useUiStore.setState(useUiStore.getInitialState(), true)
})

describe('fleet session projection evidence', () => {
  it('removes a missing session without fabricating a terminal card or an ended log', () => {
    const projection = new FleetSessionProjection()
    const logs: PollLog[] = []
    const waiting: FleetSession = {
      id: 'waiting-session',
      agent_name: 'codex',
      agent_status: 'working',
      attention_state: 'needs_input'
    }
    projection.reconcile([activeSession, waiting], [])
    expect(useCoreStore.getState().tasks).toHaveLength(2)

    projection.reconcile([waiting], logs)

    expect(useCoreStore.getState().tasks).toMatchObject([
      { id: 'sess:waiting-session', status: 'on_hold', requiresUserApproval: true }
    ])
    expect(logs).toEqual([
      {
        agentIndex: 2,
        action: 'Session unavailable in latest poll — Prepare customer response',
        taskId: 'sess:live-session'
      }
    ])
  })

  it('logs disappearance only once and restores a reappearing session from its reported state', () => {
    const projection = new FleetSessionProjection()
    const logs: PollLog[] = []
    projection.reconcile([activeSession], [])
    projection.reconcile([], logs)
    projection.reconcile([], logs)
    expect(useCoreStore.getState().tasks).toEqual([])
    expect(logs).toHaveLength(1)

    const restoredLogs: PollLog[] = []
    projection.reconcile([activeSession], restoredLogs)
    expect(useCoreStore.getState().tasks).toMatchObject([
      { id: 'sess:live-session', status: 'in_progress', output: undefined, revisions: [] }
    ])
    expect(restoredLogs).toEqual([
      {
        agentIndex: 2,
        action: 'New session — Prepare customer response [in progress]',
        taskId: 'sess:live-session'
      }
    ])
  })

  it('continues projecting a terminal status explicitly reported by the hub', () => {
    const projection = new FleetSessionProjection()
    const logs: PollLog[] = []
    projection.reconcile([activeSession], [])
    projection.reconcile([{ ...activeSession, agent_status: 'exited' }], logs)

    expect(useCoreStore.getState().tasks).toMatchObject([
      { id: 'sess:live-session', status: 'done', requiresUserApproval: false }
    ])
    expect(logs[0].action).toBe('in progress → done — Prepare customer response')

    projection.reconcile([], [])
    expect(useCoreStore.getState().tasks).toEqual([])
  })

  it('never surfaces personal sessions', () => {
    const logs: PollLog[] = []
    new FleetSessionProjection().reconcile([{ ...activeSession, personal: true }], logs)
    expect(useCoreStore.getState().tasks).toEqual([])
    expect(logs).toEqual([])
  })
})
