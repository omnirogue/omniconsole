import { describe, expect, it, vi } from 'vitest'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { SessionResumeResult } from '../../shared/session-resume-types'
import { assignByRef, type AssignRefDeps } from './session-manage-assign-ref'
import { SessionManagePartialError, SessionManageRefusal } from './session-manage-refusal'
import { manageEntry, sidebarRow } from './session-manage-test-fixtures'

const ID = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'
const REF = `claude:${ID}@local`
const actor = { kind: 'cli' as const }

type World = {
  rows: SessionManageSidebarRow[]
  entries: Record<string, Partial<SessionManageEntry>>
  bound?: boolean
}

function deps(world: World, over: Partial<AssignRefDeps> = {}) {
  let clock = 0
  const calls: string[] = []
  const unarchive = vi.fn<AssignRefDeps['unarchive']>(async (row, dryRun) => {
    calls.push(`unarchive ${row.paneKey}${dryRun ? ' (dry run)' : ''}`)
    if (!dryRun) {
      world.rows = world.rows.map((entry) =>
        entry.paneKey === row.paneKey ? { ...entry, archived: false, archiveKind: null } : entry
      )
    }
    return { summary: `Unarchived “${row.title}”.` }
  })
  const resume = vi.fn<AssignRefDeps['resume']>(async (dryRun) => {
    calls.push(`resume${dryRun ? ' (dry run)' : ''}`)
    const result: SessionResumeResult = {
      dryRun,
      action: 'resume',
      target: { paneKey: null, title: REF },
      actor,
      ref: REF,
      summary: dryRun ? `Would reopen ${REF}.` : `Reopened ${REF}.`,
      ...(dryRun ? {} : { outcome: 'resumed' as const, paneKey: 'tab-9:leaf-9' })
    }
    if (!dryRun) {
      world.rows = [
        ...world.rows,
        sidebarRow({ paneKey: 'tab-9:leaf-9', tabId: 'tab-9', rowKey: 'r9', providerSessionId: ID })
      ]
    }
    return result
  })
  const assign = vi.fn<AssignRefDeps['assign']>(async (paneKey, options) => {
    calls.push(`assign ${paneKey}${options.firstTurn ? ' (first turn from transcript)' : ''}`)
    return {
      result: {
        dryRun: options.dryRun,
        action: 'assign',
        target: { paneKey, title: 'Parser' },
        actor,
        summary: `Gave “Parser” a new task.`
      },
      entryId: 'queue-1'
    }
  })
  const value: AssignRefDeps = {
    readRows: async () => world.rows,
    observe: async (row) => ({
      entry: manageEntry({
        paneKey: row.paneKey,
        title: row.title,
        ...world.entries[row.paneKey!]
      }),
      bound: world.bound === true
    }),
    unarchive,
    resume,
    assign,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    ...over
  }
  return { deps: value, calls, unarchive, resume, assign }
}

const held = (over: Partial<SessionManageSidebarRow> = {}) =>
  sidebarRow({
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    rowKey: 'r1',
    providerSessionId: ID,
    ...over
  })

describe('session assign --ref', () => {
  it('unarchives an automatically archived, idle conversation and gives it the task', async () => {
    const world: World = {
      rows: [held({ archived: true, archiveKind: 'automatic' })],
      entries: { 'tab-1:leaf-1': { state: 'idle' } }
    }
    const { deps: d, calls } = deps(world)
    const { result, entryId } = await assignByRef(d, { ref: REF, dryRun: false })
    expect(calls).toEqual(['unarchive tab-1:leaf-1', 'assign tab-1:leaf-1'])
    expect(world.rows[0]!.archived).toBe(false)
    expect(result.steps).toEqual(['Unarchived “Parser fix”.', 'Gave “Parser” a new task.'])
    expect(entryId).toBe('queue-1')
  })

  it('resumes a closed conversation, waits until it is free, and gives it the first task from its transcript', async () => {
    const world: World = { rows: [], entries: { 'tab-9:leaf-9': { state: 'idle' } } }
    const { deps: d, calls } = deps(world)
    const { result } = await assignByRef(d, { ref: REF, dryRun: false })
    expect(calls).toEqual(['resume', 'assign tab-9:leaf-9 (first turn from transcript)'])
    expect(result.summary).toBe(`Reopened ${REF}. Gave “Parser” a new task.`)
  })

  it('unarchives and resumes an archived conversation that exited', async () => {
    const world: World = {
      rows: [held({ archived: true, archiveKind: 'manual' })],
      entries: {
        'tab-1:leaf-1': { verdict: 'exited', state: 'exited' },
        'tab-9:leaf-9': { state: 'idle' }
      }
    }
    const { deps: d, calls } = deps(world)
    await assignByRef(d, { ref: REF, dryRun: false })
    expect(calls).toEqual([
      'unarchive tab-1:leaf-1',
      'resume',
      'assign tab-9:leaf-9 (first turn from transcript)'
    ])
  })

  it('refuses a busy live row before changing anything, and points to --when-idle', async () => {
    const world: World = {
      rows: [held({ archived: true })],
      entries: { 'tab-1:leaf-1': { state: 'working' } }
    }
    const { deps: d, calls } = deps(world)
    const failure = assignByRef(d, { ref: REF, dryRun: false })
    await expect(failure).rejects.toBeInstanceOf(SessionManageRefusal)
    await expect(failure).rejects.toThrow('--when-idle')
    expect(calls).toEqual([])
  })

  it('reports a reopened conversation that never reads as free as partly applied, sending nothing', async () => {
    const world: World = { rows: [], entries: { 'tab-9:leaf-9': { state: 'working' } } }
    const { deps: d, calls } = deps(world)
    const failure = assignByRef(d, { ref: REF, dryRun: false })
    await expect(failure).rejects.toBeInstanceOf(SessionManagePartialError)
    await expect(failure).rejects.toThrow(`did not read as free within 45 s (working)`)
    expect(calls).toEqual(['resume'])
  })

  it('reports what already happened when the task itself is refused after resuming', async () => {
    const world: World = { rows: [], entries: { 'tab-9:leaf-9': { state: 'idle' } } }
    const { deps: d } = deps(world, {
      assign: async () => {
        throw new SessionManageRefusal('Its latest reply ends on a question. Nothing was sent.')
      }
    })
    const failure = assignByRef(d, { ref: REF, dryRun: false })
    await expect(failure).rejects.toBeInstanceOf(SessionManagePartialError)
    await expect(failure).rejects.toThrow(`Already done: Reopened ${REF}.`)
  })

  it('describes the plan on a dry run and changes nothing', async () => {
    const world: World = {
      rows: [held({ archived: true })],
      entries: { 'tab-1:leaf-1': { verdict: 'exited', state: 'exited' } }
    }
    const { deps: d, calls } = deps(world)
    const { result } = await assignByRef(d, { ref: REF, dryRun: true })
    expect(calls).toEqual(['unarchive tab-1:leaf-1 (dry run)', 'resume (dry run)'])
    expect(result.dryRun).toBe(true)
    expect(result.summary).toContain('Then it would be given the task once it reads as free')
    expect(world.rows[0]!.archived).toBe(true)
  })

  it('refuses another computer’s conversation and an ambiguous one', async () => {
    const remote = deps({ rows: [], entries: {} })
    await expect(
      assignByRef(remote.deps, { ref: `claude:${ID}@runtime:env-1`, dryRun: false })
    ).rejects.toThrow('cannot be resumed or given a task from here yet')
    const two = deps({
      rows: [held(), held({ paneKey: 'tab-2:leaf-2', rowKey: 'r2' })],
      entries: {}
    })
    await expect(assignByRef(two.deps, { ref: REF, dryRun: false })).rejects.toThrow(
      'held by 2 sidebar rows'
    )
    expect(remote.calls).toEqual([])
    expect(two.calls).toEqual([])
  })
})
