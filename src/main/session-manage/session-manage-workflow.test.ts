import { describe, expect, it } from 'vitest'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageWorkflowAnchor } from '../../shared/session-workflow-anchor'
import { toSessionManageEntry } from './session-manage-inventory'
import { observeSession } from './session-manage-observe'
import { observeSources, sidebarRow } from './session-manage-test-fixtures'
import { classifySessionTidyFor, type SessionTidyMode } from './session-manage-tidy'
import type { SessionWorkflowRunReading } from './session-manage-workflow'
import { sessionWorkflowDeleteRefusal } from './session-manage-workflow'

/** A Council conversation: a tab with no pane, whose run this computer's controller owns. */
function workflowRow(
  anchor: Partial<SessionManageWorkflowAnchor> = {},
  overrides: Partial<SessionManageSidebarRow> = {}
): SessionManageSidebarRow {
  return sidebarRow({
    rowKey: '["local","repo::/w","tab-9"]',
    viewKey: '["local","repo::/w","tab-9"]',
    paneKey: null,
    tabId: 'tab-9',
    title: 'Which cache?',
    agent: 'Council',
    workflow: {
      controller: 'local',
      preset: 'council',
      runId: 'execution-9',
      status: 'unknown',
      ...anchor
    },
    ...overrides
  })
}

/** The pane sources would call every pane-less row unverifiable; the run must decide first. */
const paneSources = observeSources({ resolvePane: () => null })

async function verdicts(
  row: SessionManageSidebarRow,
  reading?: SessionWorkflowRunReading,
  extra: SessionTidyMode = {},
  plan: { hold?: string; include?: readonly string[] } = {}
) {
  const sources = reading ? { ...paneSources, workflowRun: async () => reading } : paneSources
  const entry = toSessionManageEntry(await observeSession(row, sources))
  const classify = (mode: SessionTidyMode) =>
    classifySessionTidyFor(
      { now: 10_000_000, ...mode, ...extra },
      row,
      entry,
      plan.hold ?? null,
      new Set(plan.include ?? [])
    )
  return {
    entry,
    archive: classify({}),
    remove: classify({ delete: true }),
    removeUnverified: classify({ delete: true, unverified: true })
  }
}

describe('workflow conversations are classified by their run, not their missing pane (C6)', () => {
  it.each([
    ['running', 'working'],
    ['needs-you', 'awaiting-user']
  ] as const)('keeps a %s run in ordinary tidy and every delete', async (status, state) => {
    const { entry, archive, remove, removeUnverified } = await verdicts(workflowRow(), { status })
    expect(entry).toMatchObject({ state, stateBasis: 'workflow', verdict: 'live' })
    for (const verdict of [archive, remove, removeUnverified]) {
      expect(verdict).toMatchObject({ action: 'skip', group: 'workflow-active' })
      expect(verdict.reason).toContain('tidy never cancels a run')
    }
  })

  it.each([
    ['draft', { runId: null, status: 'draft' }],
    ['Start in flight', { runId: null, status: 'starting' }]
  ] as const)('keeps a %s, even with --unverified', async (_label, anchor) => {
    const row = workflowRow(anchor, { launchPending: anchor.status === 'draft' })
    const { archive, remove, removeUnverified } = await verdicts(row)
    for (const verdict of [archive, remove, removeUnverified]) {
      expect(verdict).toMatchObject({ action: 'skip', group: 'workflow-draft' })
    }
  })

  it.each(['done', 'failed', 'stopped'] as const)(
    'offers a verified %s run to ordinary archive and delete, without --unverified',
    async (status) => {
      const { entry, archive, remove } = await verdicts(workflowRow(), { status })
      expect(entry).toMatchObject({ state: 'exited', verdict: 'exited', stateBasis: 'workflow' })
      expect(entry.workflow).toMatchObject({ runId: 'execution-9', status })
      expect(archive).toMatchObject({ action: 'archive' })
      expect(archive.reason).toContain('its run history is kept')
      expect(archive.reason).toContain('cancels nothing')
      expect(remove).toMatchObject({ action: 'delete' })
      expect(remove.unverified).toBeUndefined()
    }
  )

  it.each([
    ['missing', 'workflow-run-not-found', 'Run not found'],
    ['unavailable', 'workflow-status-unavailable', 'Status unavailable']
  ] as const)(
    'keeps a %s run unless --delete --unverified names the risk',
    async (status, group, words) => {
      const { entry, archive, remove, removeUnverified } = await verdicts(workflowRow(), {
        status
      })
      expect(entry).toMatchObject({ verdict: 'unverifiable', state: 'unknown' })
      expect(entry.waitingOn).toContain(words)
      expect(archive).toMatchObject({ action: 'skip', group })
      expect(remove).toMatchObject({ action: 'skip', group })
      expect(removeUnverified).toMatchObject({ action: 'delete', unverified: true })
      expect(removeUnverified.reason).toContain('cancels nothing')
    }
  )

  it('reads a failed controller read as status unavailable, never as absence or completion', async () => {
    const row = workflowRow()
    const sources = {
      ...paneSources,
      workflowRun: async (): Promise<SessionWorkflowRunReading> => {
        throw new Error('database is locked')
      }
    }
    const entry = toSessionManageEntry(await observeSession(row, sources))
    expect(entry).toMatchObject({ verdict: 'unverifiable', state: 'unknown' })
    expect(entry.waitingOn).toContain('Status unavailable')
    expect(entry.workflow?.status).toBe('unavailable')
  })

  // Why: without the controller nothing revalidates a cached finish; it may protect, never prove.
  it('keeps a cached finish unverifiable when no controller reader is wired', async () => {
    const done = await verdicts(workflowRow({ status: 'done' }))
    expect(done.entry).toMatchObject({ verdict: 'unverifiable', state: 'unknown' })
    expect(done.archive).toMatchObject({ action: 'skip', group: 'workflow-status-unavailable' })
    expect(done.remove).toMatchObject({ action: 'skip', group: 'workflow-status-unavailable' })
    expect(done.removeUnverified).toMatchObject({ action: 'delete', unverified: true })
    const running = await verdicts(workflowRow({ status: 'running' }))
    expect(running.removeUnverified).toMatchObject({ action: 'skip', group: 'workflow-active' })
    const unread = await verdicts(workflowRow({ status: 'unknown' }))
    expect(unread.archive).toMatchObject({ group: 'workflow-status-unavailable' })
  })

  it('never labels a started workflow launch-pending because its pane is null', async () => {
    for (const status of ['running', 'done', 'missing', 'unavailable'] as const) {
      const { entry, archive, remove } = await verdicts(workflowRow(), { status })
      expect(entry.waitingOn ?? '').not.toContain('starting its agent')
      expect([archive.group, remove.group]).not.toContain('launch-pending')
    }
  })

  it('reads the run from the controller even while the workspace’s SSH host is down', async () => {
    const row = workflowRow({}, { hostId: 'ssh:box', hostUnavailable: true })
    const { archive, remove } = await verdicts(row, { status: 'done' })
    expect(archive.action).toBe('archive')
    expect(remove.action).toBe('delete')
  })

  it('keeps a quarantined workflow row unverifiable', async () => {
    const row = workflowRow({}, { ownershipUnverified: 'conflicting-provenance' })
    const { archive } = await verdicts(row, { status: 'done' })
    expect(archive.action).toBe('skip')
  })

  it('keeps pinned and saved workflow rows as ordinary rows are kept', async () => {
    const pinned = await verdicts(workflowRow({}, { pinned: true }), { status: 'done' })
    expect(pinned.archive).toMatchObject({ action: 'skip', group: 'pinned' })
    const saved = await verdicts(workflowRow({}, { saved: true }), { status: 'done' })
    expect(saved.remove).toMatchObject({ action: 'skip', group: 'saved' })
  })

  it('holds a finished workflow with an open commitment until the request names its tab', async () => {
    const hold = 'Its recorded outcomes are not finished.'
    const held = await verdicts(workflowRow(), { status: 'done' }, {}, { hold })
    expect(held.archive).toMatchObject({ action: 'hold', group: 'held', reason: hold })
    expect(held.remove).toMatchObject({ action: 'hold', group: 'held', reason: hold })
    const named = await verdicts(
      workflowRow(),
      { status: 'done' },
      {},
      { hold, include: ['tab-9'] }
    )
    expect(named.archive).toMatchObject({ action: 'archive', included: true })
    expect(named.archive.reason).toContain('the request names it')
    expect(named.remove).toMatchObject({ action: 'delete', included: true })
  })
})

describe('omni session delete on a workflow conversation', () => {
  it('refuses an active or unverifiable run without the matching flag, and nothing else', async () => {
    const entryFor = async (status: SessionWorkflowRunReading['status']) =>
      toSessionManageEntry(
        await observeSession(workflowRow(), {
          ...paneSources,
          workflowRun: async () => ({ status }) as SessionWorkflowRunReading
        })
      )
    const plain = { force: false, unverified: false }
    expect(sessionWorkflowDeleteRefusal(await entryFor('running'), plain)).toContain(
      'still running'
    )
    expect(
      sessionWorkflowDeleteRefusal(await entryFor('running'), { ...plain, force: true })
    ).toBeNull()
    expect(sessionWorkflowDeleteRefusal(await entryFor('missing'), plain)).toContain('--unverified')
    expect(
      sessionWorkflowDeleteRefusal(await entryFor('missing'), { ...plain, unverified: true })
    ).toBeNull()
    expect(sessionWorkflowDeleteRefusal(await entryFor('done'), plain)).toBeNull()
  })
})
