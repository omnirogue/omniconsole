import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionFindOwnerResult } from '../../shared/session-owner-types'
import { parseArgs } from '../args'
import type { RuntimeClient } from '../runtime-client'
import { formatSessionFindOwner } from '../session-owner-format'
import { COMMAND_SPECS } from '../specs'
import { SESSION_OWNER_HANDLERS } from './session-owner'

const FOUND: SessionFindOwnerResult = {
  disposition: 'assign',
  launchNew: false,
  recommend:
    'omni session assign --pane tab-7:leaf-1 --task "<the task>" --reason "<why this session>"',
  taskFiles: [],
  reason: '“Parser work” is idle and this task continues its work (same folder).',
  owner: {
    paneKey: 'tab-7:leaf-1',
    tabId: 'tab-7',
    title: 'Parser work',
    folder: 'Clients / Acme',
    worktreePath: '/w',
    state: 'idle',
    light: true,
    load: 'idle, nothing queued or pending',
    signals: ['same-folder'],
    conflictFiles: [],
    related: 0.91,
    duplicate: 0.2,
    goal: 'Fix the parser'
  },
  candidates: [],
  unchecked: []
}

async function run(command: 'session find-owner' | 'session assign', argv: string[]) {
  const parsed = parseArgs(argv)
  const call = vi.fn(async (_method: string, _params?: unknown, _options?: unknown) => ({
    result: command === 'session find-owner' ? FOUND : { summary: 'ok', dryRun: false }
  }))
  const client = { call, isRemote: false } as unknown as RuntimeClient
  await SESSION_OWNER_HANDLERS[command]!({ flags: parsed.flags, client, cwd: '/tmp', json: true })
  return call
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('omni session find-owner', () => {
  it('sends the task and the optional place', async () => {
    const call = await run('session find-owner', [
      'session',
      'find-owner',
      '--task',
      'Add retries',
      '--files',
      'src/a.ts, src/b/*.ts',
      '--worktree',
      'repo::/w',
      '--folder',
      'Clients / Acme'
    ])
    expect(call).toHaveBeenCalledWith(
      'sessionManage.findOwner',
      {
        task: 'Add retries',
        files: ['src/a.ts', 'src/b/*.ts'],
        worktree: 'repo::/w',
        folder: 'Clients / Acme'
      },
      { timeoutMs: 180_000 }
    )
  })

  it('prints the disposition and the next command for assign', () => {
    const text = formatSessionFindOwner(FOUND)
    expect(text.split('\n').slice(0, 2)).toEqual([
      `assign: ${FOUND.reason}`,
      'Do not launch a new session.'
    ])
    expect(text).toContain('Next: omni session assign --pane tab-7:leaf-1')
  })

  it('is a registered command with its flags', () => {
    const spec = COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'session find-owner')
    expect(spec?.allowedFlags).toEqual(
      expect.arrayContaining(['task', 'files', 'worktree', 'folder', 'repo'])
    )
    expect(spec?.notes?.join(' ')).toContain('Decision table')
  })
})

describe('omni session assign', () => {
  it('needs --reason before anything is sent', async () => {
    await expect(
      run('session assign', [
        'session',
        'assign',
        '--pane',
        'tab-7:leaf-1',
        '--task',
        'Add retries'
      ])
    ).rejects.toThrow('needs --reason')
  })

  it('sends target, task and provenance', async () => {
    const call = await run('session assign', [
      'session',
      'assign',
      '--pane',
      'tab-7:leaf-1',
      '--task',
      'Add retries',
      '--reason',
      'find-owner: idle, same folder',
      '--dry-run'
    ])
    expect(call).toHaveBeenLastCalledWith('sessionManage.assign', {
      target: { paneKey: 'tab-7:leaf-1' },
      task: 'Add retries',
      reason: 'find-owner: idle, same folder',
      dryRun: true
    })
  })

  it('sends a past conversation’s ref for main to unarchive or resume first', async () => {
    const ref = 'claude:2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c@local'
    const call = await run('session assign', [
      'session',
      'assign',
      '--ref',
      ref,
      '--task',
      'Add retries',
      '--reason',
      'find-owner: resume'
    ])
    expect(call).toHaveBeenLastCalledWith(
      'sessionManage.assign',
      { ref, task: 'Add retries', reason: 'find-owner: resume' },
      { timeoutMs: 180_000 }
    )
  })

  it('holds a task for a busy owner with --when-idle', async () => {
    const call = await run('session assign', [
      'session',
      'assign',
      '--pane',
      'tab-7:leaf-1',
      '--task',
      'Add retries',
      '--reason',
      'find-owner: conflict-owner-busy',
      '--when-idle',
      '--within',
      '45m'
    ])
    expect(call).toHaveBeenLastCalledWith(
      'sessionManage.continueWhenIdle',
      {
        target: { paneKey: 'tab-7:leaf-1' },
        text: 'Add retries',
        kind: 'assign',
        withinMs: 45 * 60_000,
        reason: 'find-owner: conflict-owner-busy'
      },
      undefined
    )
  })
})

describe('find-owner over past work', () => {
  it('prints the past conversation to resume and what it considered', () => {
    const text = formatSessionFindOwner({
      ...FOUND,
      disposition: 'resume',
      owner: undefined,
      reason: '“Fetcher” was closed and this task continues its work.',
      recommend: 'omni session assign --ref claude:x@local --task "<the task>" --reason "<why>"',
      pastOwner: {
        ref: 'claude:x@local',
        kind: 'closed',
        title: 'Fetcher',
        paneKey: null,
        archiveKind: null,
        cwd: '/w',
        transcriptPath: '/h/.claude/projects/-w/x.jsonl',
        lastActivityAt: 1,
        related: 0.9,
        duplicate: 0.2,
        finished: false,
        links: ['https://github.com/o/r/pull/9'],
        goal: 'Retry the fetcher'
      },
      past: [
        {
          ref: 'claude:x@local',
          kind: 'closed',
          title: 'Fetcher',
          paneKey: null,
          archiveKind: null,
          cwd: '/w',
          transcriptPath: '/h/.claude/projects/-w/x.jsonl',
          lastActivityAt: 1,
          related: 0.9,
          duplicate: 0.2,
          finished: false,
          links: ['https://github.com/o/r/pull/9'],
          goal: 'Retry the fetcher'
        }
      ]
    })
    expect(text).toContain('past conversation: “Fetcher”  ref claude:x@local')
    expect(text).toContain(
      '  tab closed · related 0.90, duplicate 0.20 · Fetcher  ref claude:x@local'
    )
    expect(text).toContain('    outputs: https://github.com/o/r/pull/9')
    expect(text).toContain('Next: omni session assign --ref claude:x@local')
  })
})
