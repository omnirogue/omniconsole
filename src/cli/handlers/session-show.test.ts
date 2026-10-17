import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionShowResult } from '../../shared/session-show'
import { parseArgs } from '../args'
import type { RuntimeClient } from '../runtime-client'
import { formatSessionShow } from '../session-manage-format'
import { SESSION_MANAGE_HANDLERS } from './session-manage'

const ORIGINAL_EXIT_CODE = process.exitCode

const SHOWN: SessionShowResult = {
  shown: true,
  mode: 'beside',
  placement: 'split',
  keptKeyboardFocus: false,
  target: { paneKey: 'tab-1:leaf-1', tabId: 'tab-1', title: 'Ads', worktreeId: 'wt-1' },
  summary: 'Showing “Ads” on the right, split beside the current view.'
}

async function run(argv: string[], result: unknown = SHOWN) {
  const parsed = parseArgs(argv)
  const call = vi.fn(async (_method: string, _params?: unknown) => ({ result }))
  const client = { call, isRemote: false } as unknown as RuntimeClient
  await SESSION_MANAGE_HANDLERS['session show']!({
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

describe('omni session show', () => {
  it('shows beside, with the flash, by default', async () => {
    const call = await run(['session', 'show', '--pane', 'tab-1:leaf-1'])
    expect(call).toHaveBeenCalledWith('sessionManage.show', {
      target: { paneKey: 'tab-1:leaf-1' },
      mode: 'beside'
    })
    expect(process.exitCode).toBe(ORIGINAL_EXIT_CODE)
  })

  it('passes --replace and --no-flash', async () => {
    const call = await run(['session', 'show', '--pane', 'tab-1:leaf-1', '--replace', '--no-flash'])
    expect(call).toHaveBeenCalledWith('sessionManage.show', {
      target: { paneKey: 'tab-1:leaf-1' },
      mode: 'replace',
      flash: false
    })
  })

  it('refuses --beside with --replace and a missing target', async () => {
    await expect(
      run(['session', 'show', '--pane', 'tab-1:leaf-1', '--beside', '--replace'])
    ).rejects.toThrow('Pass --beside or --replace, not both.')
    await expect(run(['session', 'show'])).rejects.toThrow('Name the session with --pane')
  })

  it('exits non-zero when nothing was shown', async () => {
    await run(['session', 'show', '--pane', 'tab-1:leaf-1'], {
      ...SHOWN,
      shown: false,
      placement: null,
      target: null,
      summary: 'Not shown: only the omni CLI on the computer running OmniConsole moves its window.'
    })
    expect(process.exitCode).toBe(1)
  })

  it('prints the summary and the pane', () => {
    expect(formatSessionShow(SHOWN)).toBe(
      'Showing “Ads” on the right, split beside the current view.\npane tab-1:leaf-1'
    )
  })
})
