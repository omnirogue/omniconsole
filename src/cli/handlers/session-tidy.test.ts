import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionTidyReport,
  SessionTidyResult,
  SessionTidyRow
} from '../../shared/session-manage-types'
import { buildAgentContext } from '../agent-context'
import { parseArgs } from '../args'
import type { RuntimeClient } from '../runtime-client'
import { formatSessionTidy } from '../session-manage-format'
import { COMMAND_SPECS } from '../specs'
import { SESSION_MANAGE_HANDLERS } from './session-manage'

const ORIGINAL_EXIT_CODE = process.exitCode

const PLAN: SessionTidyResult = {
  dryRun: true,
  actor: { kind: 'cli' },
  rows: [
    {
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      title: 'worker-task_5ad8df40da3a',
      folder: null,
      hostId: 'local',
      state: 'exited',
      verdict: 'exited',
      action: 'archive',
      reason: 'Exited.'
    },
    {
      paneKey: 'tab-2:leaf-1',
      tabId: 'tab-2',
      title: 'Ads',
      folder: 'Clients / Acme',
      hostId: 'local',
      state: 'idle',
      verdict: 'live',
      action: 'hold',
      reason: 'Its recorded outcomes are not finished.'
    },
    {
      paneKey: 'tab-3:leaf-1',
      tabId: 'tab-3',
      title: 'Parser',
      folder: null,
      hostId: 'local',
      state: 'working',
      verdict: 'live',
      action: 'skip',
      reason: 'Working.'
    }
  ],
  titleFlags: [{ paneKey: 'tab-1:leaf-1', tabId: 'tab-1', title: 'worker-task_5ad8df40da3a' }],
  counts: { archive: 1, hold: 1, skip: 1, junkTitles: 1 }
}

async function run(argv: string[], result: unknown = PLAN) {
  const parsed = parseArgs(argv)
  const call = vi.fn(async (_method: string, _params?: unknown, _options?: unknown) => ({ result }))
  const client = { call, isRemote: false } as unknown as RuntimeClient
  await SESSION_MANAGE_HANDLERS['session tidy']!({
    flags: parsed.flags,
    client,
    cwd: '/tmp',
    json: true
  })
  return call
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = ORIGINAL_EXIT_CODE
})

describe('omni session tidy', () => {
  it('is a dry run by default', async () => {
    const call = await run(['session', 'tidy'])
    expect(call).toHaveBeenCalledWith('sessionManage.tidy', {}, expect.anything())
  })

  it('refuses --apply without --request, sending nothing', async () => {
    await expect(run(['session', 'tidy', '--apply', '--reason', 'tidy'])).rejects.toThrow(
      '--request'
    )
  })

  it('sends --apply with provenance, --include and --host', async () => {
    const call = await run([
      'session',
      'tidy',
      '--apply',
      '--request',
      'clean up the sessions, the ads one too',
      '--reason',
      'end of day',
      '--include',
      'tab-2:leaf-1, tab-4:leaf-1',
      '--host',
      'local'
    ])
    expect(call.mock.calls[0]![1]).toEqual({
      apply: true,
      hostId: 'local',
      include: ['tab-2:leaf-1', 'tab-4:leaf-1'],
      reason: 'end of day',
      request: 'clean up the sessions, the ads one too'
    })
  })

  it('exits non-zero when an archive failed', async () => {
    await run(['session', 'tidy', '--apply', '--request', 'tidy up'], {
      ...PLAN,
      dryRun: false,
      applied: { archived: 0, skipped: 0, failed: 1 }
    })
    expect(process.exitCode).toBe(1)
  })

  it('exits non-zero with the skip reasons counted when it archives nothing', async () => {
    const skip = (paneKey: string, group: SessionTidyRow['group'], reason: string) => ({
      ...PLAN.rows[2]!,
      paneKey,
      group,
      reason
    })
    const result: SessionTidyResult = {
      ...PLAN,
      dryRun: false,
      rows: [
        skip('p1', 'other-omniconsole', 'It runs on another OmniConsole.'),
        skip('p2', 'other-omniconsole', 'It runs on another OmniConsole.'),
        skip('p3', 'ssh-host', '“x” runs on the SSH host box-1.'),
        { ...PLAN.rows[2]!, paneKey: 'p4', reason: 'An older host’s reason.' }
      ],
      applied: { archived: 0, skipped: 0, failed: 0 }
    }
    await run(['session', 'tidy', '--apply', '--request', 'clean up'], result)
    expect(process.exitCode).toBe(1)
    const printed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)
    expect(printed.result.report).toEqual({
      archived: [],
      changed: [],
      failed: [],
      notArchived: [
        {
          group: 'other-omniconsole',
          reason: expect.stringContaining('another OmniConsole'),
          count: 2
        },
        { group: 'ssh-host', reason: expect.stringContaining('SSH host'), count: 1 },
        { group: 'other', reason: 'An older host’s reason.', count: 1 }
      ]
    })
    const text = formatSessionTidy(printed.result)
    expect(text).toContain('Not archived, by reason:')
    expect(text).toContain('2 × Runs on another OmniConsole')
    expect(text).toContain('Nothing was archived.')
  })

  it('exits zero and lists archived rows apart from rows that changed since the plan', async () => {
    const result: SessionTidyResult = {
      ...PLAN,
      dryRun: false,
      rows: [
        { ...PLAN.rows[0]!, outcome: 'archived' },
        {
          ...PLAN.rows[0]!,
          paneKey: 'tab-5:leaf-1',
          title: 'Docs',
          outcome: 'skipped',
          outcomeReason: 'Changed since the plan: Working.'
        },
        { ...PLAN.rows[1]!, group: 'held' }
      ],
      applied: { archived: 1, skipped: 1, failed: 0 }
    }
    await run(['session', 'tidy', '--apply', '--request', 'clean up'], result)
    expect(process.exitCode).toBe(ORIGINAL_EXIT_CODE)
    const printed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)
    const report = printed.result.report as SessionTidyReport
    expect(report.archived).toEqual([
      { paneKey: 'tab-1:leaf-1', tabId: 'tab-1', title: 'worker-task_5ad8df40da3a' }
    ])
    expect(report.changed).toEqual([
      expect.objectContaining({ title: 'Docs', reason: 'Changed since the plan: Working.' })
    ])
    expect(report.notArchived).toEqual([expect.objectContaining({ group: 'held', count: 1 })])
    const text = formatSessionTidy(printed.result)
    expect(text).toContain('Archived:')
    expect(text).toContain('Changed since the plan, so not archived:')
    expect(text).toContain('Undo')
  })

  it('adds no report to a dry run', async () => {
    await run(['session', 'tidy'])
    const printed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)
    expect(printed.result.report).toBeUndefined()
    expect(process.exitCode).toBe(ORIGINAL_EXIT_CODE)
  })

  it('is discoverable in omni agent-context with its flags', () => {
    const tidy = buildAgentContext(COMMAND_SPECS).commands.find(
      (command) => command.command === 'session tidy'
    )
    expect(tidy?.flags).toEqual(
      expect.arrayContaining(['apply', 'include', 'reason', 'request', 'host'])
    )
  })

  it('prints a summary, then rows grouped by action', () => {
    const text = formatSessionTidy(PLAN)
    expect(text.split('\n')[0]).toBe('Would archive 1 · holding 1 · skipping 1 · 1 junk title')
    expect(text.indexOf('Archive:')).toBeLessThan(text.indexOf('Hold'))
    expect(text.indexOf('Hold')).toBeLessThan(text.indexOf('Skip:'))
    expect(text).toContain('Ads · idle · live · Clients / Acme — Its recorded outcomes')
    expect(text).toContain('Dry run: nothing changed.')
  })
})

describe('omni session tidy --delete', () => {
  const DELETE_PLAN: SessionTidyResult = {
    ...PLAN,
    mode: 'delete',
    rows: [
      { ...PLAN.rows[0]!, action: 'delete' },
      {
        ...PLAN.rows[2]!,
        paneKey: null,
        tabId: 'tab-9',
        title: 'Discover',
        state: 'unknown',
        verdict: 'unverifiable',
        action: 'delete',
        unverified: true,
        reason: 'It has no terminal pane (a tab left from an earlier run).'
      },
      PLAN.rows[2]!
    ],
    counts: { archive: 0, hold: 0, skip: 1, junkTitles: 1, delete: 2 }
  }

  it('sends --delete and --unverified, and refuses --unverified alone', async () => {
    const call = await run(['session', 'tidy', '--delete', '--unverified'], DELETE_PLAN)
    expect(call.mock.calls[0]![1]).toEqual({ delete: true, unverified: true })
    await expect(run(['session', 'tidy', '--unverified'])).rejects.toThrow('goes with --delete')
  })

  it('previews deletes and keeps, naming a tab-only row by its tab', () => {
    const text = formatSessionTidy(DELETE_PLAN)
    expect(text).toContain('Would delete 2 · keeping 1')
    expect(text).toContain('Delete:')
    expect(text).toContain('Keep:')
    expect(text).toContain('tab tab-9')
    expect(text).toContain('omni session tidy --delete --unverified --apply --request')
  })

  it('exits non-zero when it deletes nothing, and reports what it deleted', async () => {
    await run(['session', 'tidy', '--delete', '--apply', '--request', 'delete all sessions'], {
      ...DELETE_PLAN,
      dryRun: false,
      applied: { archived: 0, deleted: 0, skipped: 0, failed: 0 }
    })
    expect(process.exitCode).toBe(1)
    process.exitCode = ORIGINAL_EXIT_CODE
    const deleted = {
      ...DELETE_PLAN,
      dryRun: false,
      rows: DELETE_PLAN.rows.map((row) =>
        row.action === 'delete' ? { ...row, outcome: 'deleted' as const } : row
      ),
      applied: { archived: 0, deleted: 2, skipped: 0, failed: 0 }
    }
    await run(
      ['session', 'tidy', '--delete', '--apply', '--request', 'delete all sessions'],
      deleted
    )
    expect(process.exitCode).toBe(ORIGINAL_EXIT_CODE)
  })
})
