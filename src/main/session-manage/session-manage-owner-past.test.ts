import { describe, expect, it, vi } from 'vitest'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionSearchHit } from '../../shared/session-search-types'
import type { SessionOwnerDeps, SessionOwnerObserved } from './session-manage-owner'
import type { SessionOwnerJudgement } from './session-manage-owner-jev'
import {
  findSessionOwnerWithPastWork,
  sessionOwnerPastLinks,
  type SessionOwnerPastDeps
} from './session-manage-owner-past'
import { manageEntry, sidebarRow } from './session-manage-test-fixtures'

const TASK = 'Add retry with backoff to the Meta ads report fetcher'
const ARCHIVED = '11111111-1111-4111-8111-111111111111'
const CLOSED = '22222222-2222-4222-8222-222222222222'
const EXITED = '33333333-3333-4333-8333-333333333333'
const LIVE = '44444444-4444-4444-8444-444444444444'

function hit(sessionId: string, title: string, summary: string | null = null): SessionSearchHit {
  return {
    sessionKey: `claude:${sessionId}`,
    sessionId,
    agent: 'claude',
    hostLabel: 'laptop',
    executionHostId: 'local',
    title,
    cwd: '/w',
    transcriptPath: `/h/.claude/projects/-w/${sessionId}.jsonl`,
    lastActivityAt: 1_000,
    score: 1,
    reasons: [],
    snippets: [],
    summary,
    summarySource: 'model'
  }
}

function row(
  paneKey: string,
  providerSessionId: string,
  over: Partial<SessionManageSidebarRow> = {}
): SessionManageSidebarRow {
  return sidebarRow({
    paneKey,
    tabId: paneKey.split(':')[0]!,
    rowKey: `row-${paneKey}`,
    title: paneKey,
    providerSessionId,
    transcriptPath: null,
    archiveKind: null,
    ...over
  })
}

type Score = SessionOwnerJudgement

function setup(options: {
  hits: SessionSearchHit[]
  rows: SessionManageSidebarRow[]
  observed?: SessionOwnerObserved[]
  entries?: Record<string, Partial<SessionManageEntry>>
  scores: Record<string, Score>
  organization?: { deleted: boolean; hidden: boolean }
}) {
  const judge = vi.fn(async (_task: string, target: { title: string }) => {
    return options.scores[target.title] ?? { failed: 'JEV is turned off' }
  })
  const deps: SessionOwnerDeps & { past: SessionOwnerPastDeps } = {
    search: async () => ({ matches: new Map(), searched: true, hits: options.hits }),
    goal: async () => null,
    judge,
    changes: async () => ({ changes: [], skipped: [], unreadable: [], checkedWorktrees: 0 }),
    past: {
      observe: async (target) =>
        manageEntry({
          paneKey: target.paneKey,
          title: target.title,
          ...options.entries?.[target.paneKey!]
        }),
      organization: async () => options.organization ?? { deleted: false, hidden: false },
      goal: async (found) => `Goal of ${found.title}`,
      judge
    }
  }
  return {
    judge,
    run: () =>
      findSessionOwnerWithPastWork(
        { task: TASK, scope: {}, observed: options.observed ?? [], rows: options.rows },
        deps
      )
  }
}

const related = (score: number, duplicate = 0.1): Score => ({ related: score, duplicate })

describe('find-owner over past work', () => {
  it('unarchives an archived conversation whose goal the task continues, automatic archive included', async () => {
    const { run, judge } = setup({
      hits: [hit(ARCHIVED, 'Ads fetcher')],
      rows: [
        row('tab-1:leaf-1', ARCHIVED, {
          archived: true,
          archiveKind: 'automatic',
          title: 'Ads fetcher'
        })
      ],
      entries: { 'tab-1:leaf-1': { state: 'idle', archived: true } },
      scores: { 'Ads fetcher': related(0.92) }
    })
    const result = await run()
    expect(result.disposition).toBe('unarchive-and-continue')
    expect(result.launchNew).toBe(false)
    expect(result.pastOwner).toMatchObject({
      ref: `claude:${ARCHIVED}@local`,
      kind: 'archived',
      archiveKind: 'automatic',
      paneKey: 'tab-1:leaf-1',
      related: 0.92,
      goal: 'Goal of Ads fetcher'
    })
    expect(result.recommend).toBe(
      `omni session assign --ref claude:${ARCHIVED}@local --task "<the task>" --reason "<why this conversation>"`
    )
    expect(judge).toHaveBeenCalledWith(TASK, {
      title: 'Ads fetcher',
      goal: 'Goal of Ads fetcher',
      summary: null
    })
  })

  it('resumes a closed-tab conversation, and an exited one', async () => {
    const closed = await setup({
      hits: [hit(CLOSED, 'Fetcher retries')],
      rows: [],
      scores: { 'Fetcher retries': related(0.9) }
    }).run()
    expect(closed.disposition).toBe('resume')
    expect(closed.pastOwner).toMatchObject({ kind: 'closed', paneKey: null })
    expect(closed.reason).toContain('was closed and this task continues its work')

    const exited = await setup({
      hits: [hit(EXITED, 'Fetcher')],
      rows: [row('tab-3:leaf-3', EXITED)],
      entries: { 'tab-3:leaf-3': { verdict: 'exited', state: 'exited' } },
      scores: { 'tab-3:leaf-3': related(0.88) }
    }).run()
    expect(exited.disposition).toBe('resume')
    expect(exited.pastOwner).toMatchObject({ kind: 'exited', paneKey: 'tab-3:leaf-3' })
  })

  it('reuses a finished result with its links instead of assigning or launching', async () => {
    const summary =
      'Goal: retries for the ads fetcher\nOutputs: https://github.com/o/r/pull/9 https://console.example.com/a/abc'
    const result = await setup({
      hits: [hit(ARCHIVED, 'Ads fetcher', summary)],
      rows: [
        row('tab-1:leaf-1', ARCHIVED, {
          archived: true,
          archiveKind: 'automatic',
          title: 'Ads fetcher'
        })
      ],
      entries: { 'tab-1:leaf-1': { state: 'idle', archived: true } },
      scores: { 'Ads fetcher': related(0.95, 0.9) }
    }).run()
    expect(result.disposition).toBe('reuse-output')
    expect(result.launchNew).toBe(false)
    expect(result.pastOwner?.links).toEqual([
      'https://github.com/o/r/pull/9',
      'https://console.example.com/a/abc'
    ])
    expect(result.reason).toContain('https://github.com/o/r/pull/9')
    expect(result.recommend).toBeUndefined()
  })

  it('never reuses a same-deliverable conversation that was not verified complete', async () => {
    const result = await setup({
      hits: [hit(ARCHIVED, 'Ads fetcher', 'Outputs: https://github.com/o/r/pull/9')],
      rows: [
        row('tab-1:leaf-1', ARCHIVED, {
          archived: true,
          archiveKind: 'manual',
          title: 'Ads fetcher'
        })
      ],
      entries: { 'tab-1:leaf-1': { state: 'idle', archived: true } },
      scores: { 'Ads fetcher': related(0.95, 0.9) }
    }).run()
    expect(result.disposition).toBe('unarchive-and-continue')
  })

  it('lets a free live owner win over an equally related past one', async () => {
    const liveRow = row('tab-5:leaf-5', LIVE, { title: 'Live ads', folderId: 'ads' })
    const found = await findSessionOwnerWithPastWork(
      {
        task: TASK,
        scope: { folderId: 'ads' },
        observed: [
          {
            row: liveRow,
            entry: manageEntry({ paneKey: 'tab-5:leaf-5', title: 'Live ads' }),
            bound: false
          }
        ],
        rows: [liveRow]
      },
      {
        search: async () => ({
          matches: new Map(),
          searched: true,
          hits: [hit(CLOSED, 'Fetcher retries'), hit(LIVE, 'Live ads')]
        }),
        goal: async () => null,
        judge: async () => related(0.9),
        changes: async () => ({ changes: [], skipped: [], unreadable: [], checkedWorktrees: 0 }),
        past: {
          observe: async () => manageEntry(),
          organization: async () => ({ deleted: false, hidden: false }),
          goal: async () => null,
          judge: async () => related(0.9)
        }
      }
    )
    expect(found.disposition).toBe('assign')
    expect(found.owner?.paneKey).toBe('tab-5:leaf-5')
    // The live conversation's own hit is not offered again as past work.
    expect(found.past?.map((candidate) => candidate.ref)).toEqual([`claude:${CLOSED}@local`])
  })

  it('prefers resuming related past work over launching beside a busy related session', async () => {
    const liveRow = row('tab-5:leaf-5', LIVE, { title: 'Live ads', folderId: 'ads' })
    const found = await findSessionOwnerWithPastWork(
      {
        task: TASK,
        scope: { folderId: 'ads' },
        observed: [
          {
            row: liveRow,
            entry: manageEntry({ paneKey: 'tab-5:leaf-5', title: 'Live ads', state: 'working' }),
            bound: false
          }
        ],
        rows: [liveRow]
      },
      {
        search: async () => ({
          matches: new Map(),
          searched: true,
          hits: [hit(CLOSED, 'Fetcher retries')]
        }),
        goal: async () => null,
        judge: async () => related(0.9),
        changes: async () => ({ changes: [], skipped: [], unreadable: [], checkedWorktrees: 0 }),
        past: {
          observe: async () => manageEntry(),
          organization: async () => ({ deleted: false, hidden: false }),
          goal: async () => null,
          judge: async () => related(0.9)
        }
      }
    )
    expect(found.disposition).toBe('resume')
    expect(found.owner).toBeUndefined()
  })

  it('treats unsure JEV as not related, and leaves out what the person deleted or hid', async () => {
    const unsure = await setup({
      hits: [hit(CLOSED, 'Fetcher retries')],
      rows: [],
      scores: { 'Fetcher retries': related(0.6) }
    }).run()
    expect(unsure.disposition).toBe('launch-new')
    expect(unsure.past?.[0]?.related).toBe(0.6)

    const failed = await setup({
      hits: [hit(CLOSED, 'Fetcher retries')],
      rows: [],
      scores: {}
    }).run()
    expect(failed.disposition).toBe('launch-new')
    expect(failed.jevError).toBe('JEV is turned off')

    const deleted = await setup({
      hits: [hit(CLOSED, 'Fetcher retries')],
      rows: [],
      scores: { 'Fetcher retries': related(0.95) },
      organization: { deleted: true, hidden: false }
    }).run()
    expect(deleted.disposition).toBe('launch-new')
    expect(deleted.past).toEqual([])
  })

  it('checks no past work against a window that does not name provider conversations', async () => {
    const old = sidebarRow({ paneKey: 'tab-1:leaf-1' })
    const result = await setup({
      hits: [hit(CLOSED, 'Fetcher retries')],
      rows: [old],
      scores: { 'Fetcher retries': related(0.95) }
    }).run()
    expect(result.disposition).toBe('launch-new')
    expect(result.unchecked.at(-1)?.reason).toContain('past work was not checked')
  })

  it('reads rows and asks JEV for only the strongest three past conversations', async () => {
    const ids = ['5', '6', '7', '8', '9'].map(
      (n) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`
    )
    const { run, judge } = setup({
      hits: ids.map((id, at) => hit(id, `Past ${at}`)),
      rows: [],
      scores: {}
    })
    const result = await run()
    expect(judge).toHaveBeenCalledTimes(3)
    expect(result.past?.map((candidate) => candidate.title)).toEqual(['Past 0', 'Past 1', 'Past 2'])
  })

  it('reads output links from the summary line the index writes', () => {
    expect(sessionOwnerPastLinks('Goal: x\nOutputs: https://a/b https://a/b https://c/d)')).toEqual(
      ['https://a/b', 'https://c/d']
    )
    expect(sessionOwnerPastLinks('see https://a/b')).toEqual([])
  })
})
