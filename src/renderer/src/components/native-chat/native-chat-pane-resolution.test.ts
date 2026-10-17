import { describe, it, expect } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { resolveNativeChatSession } from './native-chat-pane-resolution'

function entry(
  overrides: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'paneKey'>
): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    stateHistory: [],
    ...overrides
  }
}

describe('resolveNativeChatSession', () => {
  it('resolves a pane with a captured Claude session', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'claude',
        agentStatusEntry: entry({
          paneKey,
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'sess-abc' }
        }),
        ptyId: 'pty-1'
      })
    ).toEqual({
      agent: 'claude',
      sessionId: 'sess-abc',
      transcriptPath: null,
      ptyId: 'pty-1',
      paneKey
    })
  })

  it('surfaces the hook transcriptPath when the providerSession carries one', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'claude',
        agentStatusEntry: entry({
          paneKey,
          agentType: 'claude',
          providerSession: {
            key: 'session_id',
            id: 'sess-abc',
            transcriptPath: '/home/u/.claude/projects/slug/real-uuid.jsonl'
          }
        }),
        ptyId: 'pty-1'
      })
    ).toEqual({
      agent: 'claude',
      sessionId: 'sess-abc',
      transcriptPath: '/home/u/.claude/projects/slug/real-uuid.jsonl',
      ptyId: 'pty-1',
      paneKey
    })
  })

  it('resolves a just-launched pane with sessionId null', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'claude',
        // Entry exists (agent launched) but no providerSession reported yet.
        agentStatusEntry: entry({ paneKey, agentType: 'claude' }),
        ptyId: 'pty-1'
      })
    ).toEqual({ agent: 'claude', sessionId: null, transcriptPath: null, ptyId: 'pty-1', paneKey })
  })

  it('resolves two split leaves independently to their own values', () => {
    const leftKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const rightKey = 'tab-1:22222222-2222-4222-8222-222222222222'
    const left = resolveNativeChatSession({
      paneKey: leftKey,
      launchAgent: 'claude',
      agentStatusEntry: entry({
        paneKey: leftKey,
        agentType: 'claude',
        providerSession: { key: 'session_id', id: 'left-sess' }
      }),
      ptyId: 'pty-left'
    })
    const right = resolveNativeChatSession({
      paneKey: rightKey,
      launchAgent: 'codex',
      agentStatusEntry: entry({
        paneKey: rightKey,
        agentType: 'codex',
        providerSession: { key: 'session_id', id: 'right-sess' }
      }),
      ptyId: 'pty-right'
    })
    expect(left).toEqual({
      agent: 'claude',
      sessionId: 'left-sess',
      transcriptPath: null,
      ptyId: 'pty-left',
      paneKey: leftKey
    })
    expect(right).toEqual({
      agent: 'codex',
      sessionId: 'right-sess',
      transcriptPath: null,
      ptyId: 'pty-right',
      paneKey: rightKey
    })
  })

  it('derives a supported agent from the status entry when no launchAgent is set', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: null,
        agentStatusEntry: entry({
          paneKey,
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'codex-1' }
        }),
        ptyId: 'pty-1'
      })
    ).toEqual({
      agent: 'codex',
      sessionId: 'codex-1',
      transcriptPath: null,
      ptyId: 'pty-1',
      paneKey
    })
  })

  it.each(['codex', 'claude', 'openclaude'] as TuiAgent[])(
    'resolves supported title fallback %s when no hook or launch identity exists',
    (resolvedAgent) => {
      const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
      expect(
        resolveNativeChatSession({
          paneKey,
          launchAgent: null,
          resolvedAgent,
          ptyId: 'pty-1'
        })
      ).toEqual({
        agent: resolvedAgent,
        sessionId: null,
        transcriptPath: null,
        ptyId: 'pty-1',
        paneKey
      })
    }
  )

  it('does not resolve unsupported title fallback gemini', () => {
    expect(
      resolveNativeChatSession({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        launchAgent: null,
        resolvedAgent: 'gemini',
        ptyId: 'pty-1'
      })
    ).toBeNull()
  })

  it('resolves Grok from title fallback once native chat supports its transcript', () => {
    expect(
      resolveNativeChatSession({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        launchAgent: null,
        resolvedAgent: 'grok',
        ptyId: 'pty-1'
      })
    ).toMatchObject({
      agent: 'grok',
      sessionId: null,
      ptyId: 'pty-1'
    })
  })

  it('does not resolve an unsupported live status entry', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: null,
        agentStatusEntry: entry({
          paneKey,
          agentType: 'gemini',
          providerSession: { key: 'session_id', id: 'g-1' }
        }),
        ptyId: 'pty-1'
      })
    ).toBeNull()
  })

  it('does not fall back to a supported title agent when live status is unsupported', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: null,
        agentStatusEntry: entry({
          paneKey,
          agentType: 'gemini',
          providerSession: { key: 'session_id', id: 'g-1' }
        }),
        resolvedAgent: 'codex',
        ptyId: 'pty-1'
      })
    ).toBeNull()
  })

  it('does not fall back to a supported launch agent when live status is unsupported', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'codex',
        agentStatusEntry: entry({
          paneKey,
          agentType: 'gemini',
          providerSession: { key: 'session_id', id: 'g-1' }
        }),
        resolvedAgent: 'claude',
        ptyId: 'pty-1'
      })
    ).toBeNull()
  })

  it('resolves a Grok launch agent', () => {
    expect(
      resolveNativeChatSession({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        launchAgent: 'grok',
        ptyId: 'pty-1'
      })
    ).toMatchObject({
      agent: 'grok',
      sessionId: null,
      ptyId: 'pty-1'
    })
  })

  it('keeps Grok launch identity ahead of a different title agent', () => {
    expect(
      resolveNativeChatSession({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        launchAgent: 'grok',
        resolvedAgent: 'codex',
        ptyId: 'pty-1'
      })
    ).toMatchObject({
      agent: 'grok',
      sessionId: null,
      ptyId: 'pty-1'
    })
  })

  it('keeps launch identity ahead of the title fallback', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'claude',
        resolvedAgent: 'codex',
        ptyId: 'pty-1'
      })?.agent
    ).toBe('claude')
  })

  it('keeps live hook identity and provider session ahead of the title fallback', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'claude',
        agentStatusEntry: entry({
          paneKey,
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'codex-live' }
        }),
        resolvedAgent: 'claude',
        ptyId: 'pty-1'
      })
    ).toEqual({
      agent: 'codex',
      sessionId: 'codex-live',
      transcriptPath: null,
      ptyId: 'pty-1',
      paneKey
    })
  })

  it('resolves a Claude Agent Teams launch to its Claude lead before any hook reports', () => {
    // The lead may run under a profile whose hooks never post; chat must not wait on them.
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({ paneKey, launchAgent: 'claude-agent-teams', ptyId: 'pty-1' })
    ).toEqual({ agent: 'claude', sessionId: null, transcriptPath: null, ptyId: 'pty-1', paneKey })
  })

  it('keeps an Agent Teams pane on the same Claude identity once the lead hook reports', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'claude-agent-teams',
        agentStatusEntry: entry({
          paneKey,
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'lead-1' }
        }),
        ptyId: 'pty-1'
      })
    ).toEqual({
      agent: 'claude',
      sessionId: 'lead-1',
      transcriptPath: null,
      ptyId: 'pty-1',
      paneKey
    })
  })

  it('returns null for a non-agent pane (no launchAgent, no entry)', () => {
    expect(
      resolveNativeChatSession({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        launchAgent: null,
        ptyId: 'pty-1'
      })
    ).toBeNull()
  })

  it('falls back to the resume checkpoint once the live row is gone', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: null,
        ptyId: 'pty-1',
        sleepingRecord: {
          agent: 'codex',
          providerSession: {
            key: 'session_id',
            id: 'thread-9',
            transcriptPath: '/t/thread-9.jsonl'
          }
        }
      })
    ).toEqual({
      agent: 'codex',
      sessionId: 'thread-9',
      transcriptPath: '/t/thread-9.jsonl',
      ptyId: 'pty-1',
      paneKey
    })
  })

  it('prefers the live row over the checkpoint', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    expect(
      resolveNativeChatSession({
        paneKey,
        agentStatusEntry: entry({
          paneKey,
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'live-1' }
        }),
        ptyId: 'pty-1',
        sleepingRecord: { agent: 'codex', providerSession: { key: 'session_id', id: 'old-1' } }
      })?.sessionId
    ).toBe('live-1')
  })
})

it('uses the recorded Codex resume identity before the first hook, with live hooks taking precedence', () => {
  const resumeSession = {
    agent: 'codex' as const,
    providerSession: {
      key: 'session_id' as const,
      id: 'resumed',
      transcriptPath: '/test/rollout.jsonl'
    }
  }
  const input = { paneKey: 'tab:leaf', ptyId: 'pty', launchAgent: 'codex' as const, resumeSession }
  expect(resolveNativeChatSession(input)).toMatchObject({
    sessionId: 'resumed',
    transcriptPath: '/test/rollout.jsonl'
  })
  expect(
    resolveNativeChatSession({
      ...input,
      agentStatusEntry: entry({
        paneKey: input.paneKey,
        agentType: 'codex',
        providerSession: { key: 'session_id', id: 'new-session' }
      })
    })
  ).toMatchObject({ sessionId: 'new-session' })
  expect(resolveNativeChatSession({ ...input, launchAgent: 'claude' })).toMatchObject({
    sessionId: null
  })
})
