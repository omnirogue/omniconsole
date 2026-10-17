import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { resolveSessionTarget } from './session-folder-target'
import { SESSION_MANAGE_HANDLERS } from './session-manage'

const ID = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'
const REF = `claude:${ID}@local`

function client(sessions: Record<string, unknown>[]) {
  const call = vi.fn(async () => ({ id: '1', ok: true, result: { sessions }, _meta: {} }))
  return { client: { call } as unknown as RuntimeClient, call }
}

const row = (paneKey: string, extra: Record<string, unknown> = {}) => ({
  paneKey,
  hostId: 'local',
  providerSessionId: null,
  transcriptPath: null,
  ...extra
})

const flags = (entries: [string, string | boolean][]) => new Map(entries)

describe('--ref', () => {
  it('retains the requested reference through ask RPC after resolving its pane', async () => {
    const call = vi.fn(async (method: string) => ({
      result:
        method === 'sessionManage.list'
          ? { sessions: [row('tab-2:b', { providerSessionId: ID })] }
          : { dryRun: true, summary: 'Would ask.' }
    }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await SESSION_MANAGE_HANDLERS['session ask']!({
        client: { call, isRemote: false } as unknown as RuntimeClient,
        flags: flags([
          ['ref', REF],
          ['question', 'Status?'],
          ['require-keep-going-off', true],
          ['dry-run', true]
        ]),
        cwd: '/tmp',
        json: true
      })
      expect(call).toHaveBeenCalledWith(
        'sessionManage.ask',
        expect.objectContaining({
          target: { paneKey: 'tab-2:b' },
          expectedRef: REF,
          requireKeepGoingOff: true
        }),
        expect.anything()
      )
    } finally {
      log.mockRestore()
    }
  })

  it('names the one pane holding the conversation, archived rows included', async () => {
    const { client: runtime, call } = client([
      row('tab-1:a', { providerSessionId: 'other' }),
      row('tab-2:b', { transcriptPath: `/h/.claude/projects/-w/${ID}.jsonl`, archived: true })
    ])
    await expect(resolveSessionTarget(runtime, flags([['ref', REF]]))).resolves.toEqual({
      paneKey: 'tab-2:b'
    })
    expect(call).toHaveBeenCalledWith(
      'sessionManage.list',
      { includeArchived: true },
      expect.anything()
    )
  })

  it('sends a closed conversation to resume, and an ambiguous one to --pane', async () => {
    await expect(
      resolveSessionTarget(client([row('tab-1:a')]).client, flags([['ref', REF]]))
    ).rejects.toThrow(`Reopen it first with omni session resume --ref ${REF}`)
    await expect(
      resolveSessionTarget(
        client([
          row('tab-1:a', { providerSessionId: ID }),
          row('tab-2:b', { providerSessionId: ID })
        ]).client,
        flags([['ref', REF]])
      )
    ).rejects.toThrow('open in 2 panes (tab-1:a, tab-2:b)')
  })

  it('refuses a malformed ref and a ref next to --pane before reading anything', async () => {
    const { client: runtime, call } = client([])
    await expect(resolveSessionTarget(runtime, flags([['ref', 'claude:x']]))).rejects.toThrow(
      'is not a session reference'
    )
    await expect(
      resolveSessionTarget(
        runtime,
        flags([
          ['ref', REF],
          ['pane', 'tab-1:a']
        ])
      )
    ).rejects.toThrow('Pass --ref alone, not with --terminal or --pane.')
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses to match against a controller that lists no provider ids', async () => {
    await expect(
      resolveSessionTarget(
        client([{ paneKey: 'tab-1:a', hostId: 'local' }]).client,
        flags([['ref', REF]])
      )
    ).rejects.toThrow('without their provider conversation')
  })
})
