import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { HANDLER_COMMAND_KEYS } from '../dispatch'
import { COMMAND_SPECS } from '../specs'
import type { SessionSidebarCountsResult } from '../../shared/session-sidebar-counts'
import {
  SESSION_FRAME_LOG_HANDLERS,
  formatSessionFrameLogStatus,
  formatSessionSidebarCounts
} from './session-frame-log'

const STATUS = {
  enabled: true,
  filePath: '/Users/me/Library/Application Support/omniconsole-ide/logs/session-frames.ndjson',
  files: ['/Users/me/Library/Application Support/omniconsole-ide/logs/session-frames.ndjson'],
  bytes: 1024 * 1024,
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 8,
  enabledAt: Date.UTC(2026, 9, 4, 18, 0, 0),
  expiresAt: Date.UTC(2026, 9, 5, 2, 0, 0),
  build: { appVersion: '1.12.21-local.1759600000.abcdef123456', commit: 'abcdef123456' }
}

function context(state: string | undefined, extra: [string, string][] = [], isRemote = false) {
  const call = vi.fn(async () => ({ id: '1', ok: true as const, result: STATUS }))
  const flags = new Map<string, string | boolean>([
    ...(state ? [['state', state]] : []),
    ...extra
  ] as [string, string][])
  return {
    call,
    ctx: {
      client: { call, isRemote },
      flags,
      cwd: '/',
      json: true
    } as unknown as HandlerContext
  }
}

describe('omni session frame-log', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is a registered command with a handler', () => {
    const paths = COMMAND_SPECS.map((spec) => spec.path.join(' '))
    expect(paths).toEqual(expect.arrayContaining(['session frame-log', 'session sidebar-counts']))
    expect(HANDLER_COMMAND_KEYS.has('session frame-log')).toBe(true)
    expect(HANDLER_COMMAND_KEYS.has('session sidebar-counts')).toBe(true)
  })

  it('switches the log with session.frameLog.set and reads status by default', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const on = context('on')
    await SESSION_FRAME_LOG_HANDLERS['session frame-log']!(on.ctx)
    expect(on.call).toHaveBeenCalledWith('session.frameLog.set', { enabled: true })

    const forDay = context('on', [['for', '24h']])
    await SESSION_FRAME_LOG_HANDLERS['session frame-log']!(forDay.ctx)
    expect(forDay.call).toHaveBeenCalledWith('session.frameLog.set', {
      enabled: true,
      durationMs: 24 * 60 * 60 * 1000
    })

    const off = context('off')
    await SESSION_FRAME_LOG_HANDLERS['session frame-log']!(off.ctx)
    expect(off.call).toHaveBeenCalledWith('session.frameLog.set', { enabled: false })

    const status = context(undefined)
    await SESSION_FRAME_LOG_HANDLERS['session frame-log']!(status.ctx)
    expect(status.call).toHaveBeenCalledWith('session.frameLog.status')
  })

  it('refuses an unknown state before calling the runtime', async () => {
    const bad = context('maybe')
    await expect(SESSION_FRAME_LOG_HANDLERS['session frame-log']!(bad.ctx)).rejects.toThrow(
      /Use on, off or status/
    )
    expect(bad.call).not.toHaveBeenCalled()
    for (const [state, value] of [
      ['on', '49h'],
      ['on', 'soon'],
      ['off', '1h']
    ] as const) {
      const refused = context(state, [['for', value]])
      await expect(SESSION_FRAME_LOG_HANDLERS['session frame-log']!(refused.ctx)).rejects.toThrow(
        /--for/
      )
      expect(refused.call).not.toHaveBeenCalled()
    }
  })

  it('refuses another computer’s CLI connection', async () => {
    for (const key of ['session frame-log', 'session sidebar-counts']) {
      const remote = context('on', [], true)
      await expect(SESSION_FRAME_LOG_HANDLERS[key]!(remote.ctx)).rejects.toThrow(
        /computer running OmniConsole/
      )
      expect(remote.call).not.toHaveBeenCalled()
    }
  })

  it('prints where the file is and its bound', () => {
    expect(formatSessionFrameLogStatus(STATUS)).toBe(
      [
        'Session frame log: on since 2026-10-04T18:00:00.000Z, switches itself off at 2026-10-05T02:00:00.000Z',
        `File: ${STATUS.filePath}`,
        'Size: 1.0 MB in 1 file(s), capped at 80.0 MB',
        'Build: 1.12.21-local.1759600000.abcdef123456 (commit abcdef123456)'
      ].join('\n')
    )
  })

  describe('session sidebar-counts text (session parity, step 8)', () => {
    const STUDIO = 'runtime:env-studio'
    const RENDERED = Date.UTC(2026, 9, 6, 22, 0, 0)
    const older: SessionSidebarCountsResult = {
      available: true,
      onScreen: true,
      ready: true,
      renderedAt: RENDERED,
      readAt: RENDERED + 1_000,
      switchHostCounts: [{ hostId: STUDIO, label: 'Mac Studio', count: 7 }],
      sessionCountsByHost: [{ hostId: STUDIO, label: 'Mac Studio', count: 7 }],
      archivedCount: 2,
      hiddenCount: 0,
      showArchived: false,
      hostFilter: null,
      rows: [],
      archiveKeys: [],
      hosts: []
    }

    it('prints an older window’s counts exactly as before: no buckets, no owner states', () => {
      expect(formatSessionSidebarCounts(older)).toBe(
        [
          'Rendered 2026-10-06T22:00:00.000Z, read 2026-10-06T22:00:01.000Z',
          'Host switch (as shown):',
          '  Mac Studio (runtime:env-studio): 7',
          'Sessions per host (hosts with sessions):',
          '  Mac Studio (runtime:env-studio): 7',
          'Archived: 2',
          'Hidden: 0',
          'Rows: 0 (0 archived)'
        ].join('\n')
      )
    })

    it('prints buckets per host and each paired owner’s ledger state', () => {
      const text = formatSessionSidebarCounts({
        ...older,
        sessionCountsByHost: [
          {
            hostId: STUDIO,
            label: 'Mac Studio',
            count: 7,
            ownerListed: 4,
            heldByOwner: 1,
            receiverOnly: 1,
            workflow: 1,
            unverified: 1,
            stale: 0,
            archived: 2
          }
        ],
        ownerLedgers: [
          {
            hostId: STUDIO,
            generation: 'gen-1',
            revision: 12,
            source: 'window',
            state: 'ready',
            asOf: RENDERED
          },
          {
            hostId: 'runtime:env-mini',
            generation: null,
            revision: null,
            source: null,
            state: 'older',
            asOf: null
          }
        ]
      })
      expect(text).toContain(
        "  Mac Studio (runtime:env-studio): 7 — 4 owner-listed, 1 held by owner, 1 only here, 1 workflow (1 can't verify, 2 archived)"
      )
      expect(text).toContain('Paired owners’ ledgers:')
      expect(text).toContain('  Mac Studio: ledger ready (revision 12, window-authored)')
      expect(text).toContain(
        '  runtime:env-mini: older OmniConsole: paused and archived conversations not listed'
      )
    })

    it('still prints the parity population when the sidebar is off screen', () => {
      const text = formatSessionSidebarCounts({
        ...older,
        available: false,
        reason: 'sidebar not on screen',
        parity: {
          rows: [],
          countsByHost: [
            {
              hostId: 'local',
              count: 3,
              ownerListed: 2,
              heldByOwner: 0,
              receiverOnly: 1,
              workflow: 0,
              unverified: 1,
              stale: 0,
              archived: 0
            }
          ],
          ownerLedgers: []
        }
      })
      expect(text.split('\n')).toEqual([
        'Sidebar counts unavailable: sidebar not on screen',
        'Parity population (every sidebar row, before filters): 0 rows',
        "  local: 3 — 2 owner-listed, 1 only here (1 can't verify)"
      ])
    })
  })
})
