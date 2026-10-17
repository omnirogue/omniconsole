import { describe, expect, it } from 'vitest'
import { findCodexConversationLockIndex } from '../../shared/automation-terminal-chrome'
import { readScreenEvidence } from '../runtime/terminal-agent-evidence'
import { assertDeliverable } from './session-manage-deliver'
import { toSessionManageEntry } from './session-manage-inventory'
import { observeSession } from './session-manage-observe'
import { agentProcess, observeSources, sidebarRow } from './session-manage-test-fixtures'
import { parseSessionPromptScreen } from './session-prompt-screen'
import { derivePtyActivity } from './session-manage-pty-activity'

// BigMac: an unparsed Claude menu remains open below an earlier finished-turn marker.
const MENU = [
  '✻ Cooked for 22s · done 1:13 PM',
  ' ☐ Fleet setup',
  'Which should happen?',
  '❯ 1. Both (Recommended)',
  '  2. Neither for now',
  '  3. Type something.',
  '─'.repeat(80),
  '  4. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  `${'─'.repeat(60)} session-name ─`
]
const detectors = { blockedReason: () => null, readyPrompt: () => false }

describe('open menu state when option parsing is unavailable', () => {
  it.each(['local', 'ssh:worker'])(
    'refuses a queued question on %s despite idle evidence',
    async (hostId) => {
      expect(parseSessionPromptScreen('claude', MENU.join('\n'))).toBeNull()
      const proof = agentProcess({ agent: 'claude' })
      const observed = await observeSession(
        sidebarRow({ hostId }),
        observeSources({
          agentStatus: async () => ({ running: true, status: 'idle' }),
          titleStatus: () => 'idle',
          hook: () => ({
            state: 'working',
            interactivePrompt: null,
            updatedAt: 1000,
            agentPid: 200
          }),
          prompt: async () => null,
          evidence: async () => ({
            foreground: { kind: 'agent', agent: 'claude' },
            process: proof,
            tree: { kind: 'other' },
            screen: readScreenEvidence(MENU, detectors)
          })
        })
      )
      const entry = toSessionManageEntry(observed)
      expect(entry).toMatchObject({ state: 'awaiting-user', stateBasis: 'screen', verdict: 'live' })
      expect(entry.ask).toBeUndefined()
      expect(entry.waitingOn).toContain('open menu')
      expect(() => assertDeliverable({ kind: 'cli' }, { ...observed, entry }, 'ask')).toThrow()
    }
  )

  it('does not make an old footer outside the status area into a current menu', () => {
    const lines = [...MENU, ...Array.from({ length: 16 }, () => 'Later output')]
    expect(readScreenEvidence(lines, detectors).promptMenu).toBeUndefined()
  })

  it('keeps a running agent working when its output quotes a menu footer', () => {
    const screen = readScreenEvidence(
      ['Enter to select · ↑/↓ to navigate · Esc to cancel', '✻ Thinking… (esc to interrupt)'],
      detectors
    )
    expect(screen.promptMenu).toBeUndefined()
    expect(
      derivePtyActivity({
        status: { running: true, status: null },
        title: null,
        hook: null,
        lastHook: null,
        screen,
        foregroundAgent: 'claude',
        agentInForeground: true
      })
    ).toEqual({ activity: { kind: 'working' }, basis: 'screen' })
  })

  it('recognizes an ANSI-colored or wrapped footer despite an old ready marker', () => {
    const evidence = readScreenEvidence(
      ['done', '\x1b[2mEnter to select · ↑/↓ to navi', 'gate · Esc to cancel\x1b[0m'],
      { ...detectors, readyPrompt: () => true }
    )
    expect(evidence).toMatchObject({ promptMenu: true, readyPrompt: true })
  })
})

describe('provider conversation ownership lock', () => {
  const lock = [
    'Worked for 1s · done 5:58 PM',
    '🔒 This conversation is open in another app R to Retry',
    'Close it there and press R to continue here.',
    'r retry esc/ctrl+c/q exit ctrl+t transcript'
  ]

  it.each(['local', 'ssh:worker'])(
    'blocks manager delivery on %s despite idle evidence',
    async (hostId) => {
      const observed = await observeSession(
        sidebarRow({ hostId, agent: 'codex' }),
        observeSources({
          agentStatus: async () => ({ running: true, status: 'idle' }),
          titleStatus: () => 'idle',
          prompt: async () => null,
          evidence: async () => ({
            foreground: { kind: 'agent', agent: 'codex' },
            process: agentProcess({ agent: 'codex' }),
            tree: { kind: 'other' },
            screen: readScreenEvidence(lock, {
              ...detectors,
              blockedReason: () => 'codex-interactive-prompt',
              readyPrompt: () => true
            })
          })
        })
      )
      const entry = toSessionManageEntry(observed)
      expect(entry).toMatchObject({ state: 'awaiting-user', stateBasis: 'screen', verdict: 'live' })
      expect(entry.waitingOn).toContain('conversation is open in another app')
      expect(() => assertDeliverable({ kind: 'cli' }, { ...observed, entry }, 'ask')).toThrow()
    }
  )

  it('does not mistake an interrupted turn or a bare quote for an ownership lock', () => {
    for (const lines of [
      ['■ Conversation interrupted'],
      ['This conversation is open in another app']
    ]) {
      expect(readScreenEvidence(lines, detectors).conversationLocked).toBeUndefined()
    }
    expect(
      readScreenEvidence([...lock, ...Array(16).fill('Later output')], detectors).conversationLocked
    ).toBeUndefined()
  })
})

describe('quoted ownership banners', () => {
  const text = [
    'This conversation is open in another app R to Retry',
    'r retry esc/ctrl+c/q exit ctrl+t transcript'
  ]
  const evidence = (lines: string[]) =>
    readScreenEvidence(lines, {
      readyPrompt: () => false,
      blockedReason: (value) =>
        findCodexConversationLockIndex(value) === null ? null : 'codex-interactive-prompt'
    })
  const activity = (screen: ReturnType<typeof readScreenEvidence>, running: boolean) =>
    derivePtyActivity({
      status: { running, status: null },
      title: null,
      hook: null,
      lastHook: null,
      screen,
      foregroundAgent: running ? 'codex' : null,
      agentInForeground: running
    })

  it.each(['• Working (1s • esc to interrupt)', '✻ Thinking… (0s)'])(
    'keeps working after quoted lock text: %s',
    (spinner) => {
      const screen = evidence([...text, spinner])
      expect(screen.conversationLocked).toBeUndefined()
      expect(screen.blocked).toBeNull()
      expect(activity(screen, true)).toEqual({ activity: { kind: 'working' }, basis: 'screen' })
    }
  )

  it('does not infer a running agent from a lock banner', () => {
    expect(activity(evidence(text), false).activity.kind).toBe('unknown')
  })
})
