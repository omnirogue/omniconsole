import { describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { autoBindFromToolEvent, autoBindListener } from './work-delivery-autobind'

const tool = (toolInput: string, extra: Partial<AgentHookEventPayload> = {}, failed = false) =>
  ({
    paneKey: 'tab-1:leaf-1',
    connectionId: null,
    hookEventName: 'PostToolUse',
    payload: { state: 'working', toolName: 'Bash', toolInput, ...(failed ? { failed: true } : {}) },
    ...extra
  }) as unknown as AgentHookEventPayload

describe('autoBindFromToolEvent', () => {
  it('binds on a QA handoff comment and a pull request naming the key', () => {
    expect(autoBindFromToolEvent(tool('omni-jira comment OMR-93 --body-file /tmp/h.md'))).toEqual({
      jira: 'OMR-93',
      source: 'handoff'
    })
    expect(
      autoBindFromToolEvent(tool('gh pr create --title "OMR-85: re-test fixes" --body-file b.md'))
    ).toEqual({
      jira: 'OMR-85',
      source: 'pull-request'
    })
  })

  it('ignores reads, failures and other commands', () => {
    expect(autoBindFromToolEvent(tool('omni-jira get OMR-93'))).toBeNull()
    expect(autoBindFromToolEvent(tool('omni-jira comment OMR-93 x', {}, true))).toBeNull()
    expect(autoBindFromToolEvent(tool('gh pr view 635'))).toBeNull()
    expect(
      autoBindFromToolEvent(tool('omni-jira comment OMR-93 x', { hookEventName: 'PreToolUse' }))
    ).toBeNull()
  })
})

describe('autoBindListener', () => {
  it('binds once per pane and issue, and never from a remote or replayed event', async () => {
    const bind = vi.fn(async () => ({
      ok: true as const,
      workItem: 'jira:OMR-93',
      binding: { hostId: 'h', source: 'handoff' }
    }))
    const listen = autoBindListener({
      bind,
      rowOf: async () => ({ worktreeId: 'w', title: 'OMR-93' })
    })
    listen(tool('omni-jira comment OMR-93 a', { connectionId: 'ssh-1' }))
    listen(tool('omni-jira comment OMR-93 a', { isReplay: true }))
    listen(tool('omni-jira comment OMR-93 a'))
    listen(tool('omni-jira comment OMR-93 b'))
    await vi.waitFor(() => expect(bind).toHaveBeenCalledOnce())
    expect(bind).toHaveBeenCalledWith({
      jira: 'OMR-93',
      source: 'handoff',
      pane: { paneKey: 'tab-1:leaf-1', worktreeId: 'w', title: 'OMR-93' }
    })
  })
})
