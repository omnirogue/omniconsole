import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimeTerminalRead } from '../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from './omni-runtime'
import { collectTerminalAgentEvidence } from './terminal-agent-evidence-reader'
import { findWorkspaceTrustPromptIndex } from './terminal-workspace-trust'
import {
  classifyForegroundProcess,
  readScreenEvidence,
  type TerminalForegroundEvidence
} from './terminal-agent-evidence'

function classify(input: {
  name: string | null | Error
  confirmed?: string | null
  shell?: boolean | Error
  expectedAgent?: string
}): Promise<TerminalForegroundEvidence> {
  const settle = <T>(value: T | Error): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value)
  return classifyForegroundProcess({
    read: () => settle(input.name),
    ...(input.confirmed !== undefined ? { confirm: () => settle(input.confirmed!) } : {}),
    confirmShell: () => settle(input.shell ?? false),
    expectedAgent: input.expectedAgent ?? null
  })
}

describe('classifyForegroundProcess', () => {
  it('names the agents laptop runs by their process names', async () => {
    expect(await classify({ name: 'codex' })).toEqual({ kind: 'agent', agent: 'codex' })
    // Measured 2026-09-24: Grok Build's process carries its version.
    expect(await classify({ name: 'grok-1.0.40' })).toEqual({ kind: 'agent', agent: 'grok' })
  })

  it('names a wrapper or version-titled agent by its command line in a fresh scan', async () => {
    // Claude's native build: the kernel says "2.1.281", the command line `…/bin/claude`.
    expect(await classify({ name: '2.1.281', confirmed: 'claude' })).toEqual({
      kind: 'agent',
      agent: 'claude'
    })
    expect(await classify({ name: 'node', confirmed: 'codex' })).toEqual({
      kind: 'agent',
      agent: 'codex'
    })
    // A stale shell reading loses to a scan that finds the agent.
    expect(await classify({ name: 'zsh', confirmed: 'claude' })).toEqual({
      kind: 'agent',
      agent: 'claude'
    })
  })

  it('reads a version-titled process as Claude only for a Claude pane no scan could check', async () => {
    const version = { name: '2.1.281', confirmed: null, expectedAgent: 'claude' }
    expect(await classify(version)).toEqual({ kind: 'agent', agent: 'claude' })
    expect(await classify({ ...version, expectedAgent: 'codex' })).toEqual({
      kind: 'program',
      process: '2.1.281'
    })
    // A scan that ran and found no agent outranks the pane's launch identity.
    expect(await classify({ ...version, confirmed: '2.1.281' })).toEqual({
      kind: 'program',
      process: '2.1.281'
    })
  })

  it('reads a shell as the agent gone only when the process table confirms it', async () => {
    expect(await classify({ name: 'zsh', shell: true })).toEqual({ kind: 'shell' })
    expect(await classify({ name: '-zsh', confirmed: 'zsh', shell: true })).toEqual({
      kind: 'shell'
    })
    expect(await classify({ name: 'zsh', shell: false })).toEqual({ kind: 'unavailable' })
    expect(await classify({ name: 'zsh', shell: new Error('ps failed') })).toEqual({
      kind: 'unavailable'
    })
  })

  it('never guesses from an unreadable foreground, and names any other program', async () => {
    expect(await classify({ name: null })).toEqual({ kind: 'unavailable' })
    expect(await classify({ name: new Error('daemon gone') })).toEqual({ kind: 'unavailable' })
    expect(await classify({ name: 'vim', confirmed: null })).toEqual({
      kind: 'program',
      process: 'vim'
    })
  })
})

// Real screens, laptop 2026-09-24. Codex paints braille sparkles over blank cells even when idle.
const CODEX_DONE = [
  '  Worked for 8m 8s · done Sep 15 at 5:54 AM',
  '• You have 1 usage limit reset available. Run /usage to use one.',
  '                            ⠈                    ⠄         ⠄      ⠠           ⡀   ⡀    ⠁',
  '›⠁Ask Codex to do anything           ⠂                                ⠄    ⠂        ⠁⠐',
  '        ⠐                           ⠠        ⢀      ⠠ ⠄⠂                  ⠄    ⠄',
  '  gpt-6-astra max · ~/omni/workspaces/omni-ide/transfer-startup-volume-0915 · Report task outcome'
]
const CODEX_UPDATE = [
  '  ✨ Update available! 0.155.1 -> 0.156.1',
  '  Release notes: https://github.com/openai/codex/releases/latest',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '  Press enter to continue'
]
// Claude Code 2.1.281 after a one-second turn, and mid-turn (no "esc to interrupt" in either).
const CLAUDE_DONE = [
  '❯ Reply with the single word hi. Do not use any tools.',
  '⏺ hi',
  '✻ Cogitated for 1s · done 10:08 AM',
  '─'.repeat(80),
  '❯',
  '─'.repeat(80),
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #684'
]
const CLAUDE_WORKING = [
  '❯ Reply with the single word hi. Do not use any tools.',
  '✻ Whirlpooling… (peers… 1/2 · 0s)',
  '─'.repeat(80),
  '❯',
  '─'.repeat(80)
]
const CLAUDE_QUIET = ['─'.repeat(80), '❯']
// Codex mid-turn: its composer shows its placeholder while it works, so that proves nothing.
const CODEX_WORKING = [
  '⚠ MCP startup incomplete (failed: notion, omni-console, omniconsole_workspace)',
  '• Working (1s • esc to interrupt)',
  '› Ask Codex to do anything',
  '  gpt-6-astra medium · ~'
]
// Canonical 256×79 provider frame, 2026-09-26: the short reply has no duration line.
const CODEX_SHORT_REPLY = 'ACK_SHORT_REPLY'
const CODEX_SHORT_DONE = [
  '› Reply with the exact acknowledgement.',
  `• ${CODEX_SHORT_REPLY}`,
  '3:00 PM',
  'Tip: Use /help to see available commands.',
  '› Ask Codex to do anything',
  'gpt-6-astra medium · ~/workspace',
  '? for shortcuts'
]
const GROK_IDLE = [
  '  ╭────────────────────────────────────────────╮',
  '  │ ❯                                          │',
  '  ╰──────────────── Grok 4.6 (high) · always-approve ─╯',
  '  Shift+Tab:mode  │  Ctrl+x:shortcuts'
]

const detectors = {
  blockedReason: (text: string) =>
    /update available/i.test(text) && /press enter to continue/i.test(text)
      ? ('codex-update-prompt' as const)
      : null,
  readyPrompt: (text: string) => text.includes('OpenAI Codex')
}

describe('readScreenEvidence', () => {
  it('requires the complete current recap range through blank, status and border filtering', () => {
    const recap = ['  ↳ Recap: Earlier work is complete.', '           The result is retained.']
    const lines = [...CODEX_SHORT_DONE.slice(0, 3), ...recap, ...CODEX_SHORT_DONE.slice(3)]
    const proof = [{ kind: 'codex-recap' as const, startRow: 3, endRow: 4 }]
    expect(readScreenEvidence(lines, detectors, CODEX_SHORT_REPLY, proof).readyPrompt).toBe(true)
    const bordered = ['', ...lines.slice(0, 3), '────────', ...lines.slice(3)]
    expect(
      readScreenEvidence(bordered, detectors, CODEX_SHORT_REPLY, [
        { ...proof[0], startRow: 5, endRow: 6 }
      ]).readyPrompt
    ).toBe(true)
    expect(readScreenEvidence(lines, detectors, CODEX_SHORT_REPLY).readyPrompt).toBe(false)
    expect(
      readScreenEvidence(lines, detectors, CODEX_SHORT_REPLY, [
        { ...proof[0], startRow: 2, endRow: 3 }
      ]).readyPrompt
    ).toBe(false)
    for (const replaced of [
      [recap[0], '────────'],
      [recap[0], ''],
      [recap[0], '• Working (3s • esc to interrupt)'],
      [recap[0], 'Update available\nPress enter to continue']
    ]) {
      expect(
        readScreenEvidence(
          [...lines.slice(0, 3), ...replaced, ...lines.slice(5)],
          detectors,
          CODEX_SHORT_REPLY,
          proof
        ).readyPrompt
      ).toBe(false)
    }
    for (const intervening of [
      '› Later submitted input',
      '• Queued follow-up inputs',
      'unexpected output'
    ]) {
      const changed = [...lines.slice(0, 3), intervening, ...lines.slice(3)]
      expect(
        readScreenEvidence(changed, detectors, CODEX_SHORT_REPLY, [
          { ...proof[0], startRow: 4, endRow: 5 }
        ]).readyPrompt
      ).toBe(false)
    }
    expect(
      readScreenEvidence(
        lines.map((line) => (line.startsWith('› Ask') ? '› Recap: typed draft' : line)),
        detectors,
        CODEX_SHORT_REPLY,
        proof
      ).readyPrompt
    ).toBe(false)
    const clipped = [
      ...CODEX_SHORT_DONE.slice(0, 3),
      recap[0],
      ...Array.from({ length: 14 }, () => recap[1]),
      ...CODEX_SHORT_DONE.slice(3)
    ]
    expect(
      readScreenEvidence(clipped, detectors, CODEX_SHORT_REPLY, [{ ...proof[0], endRow: 17 }])
        .readyPrompt
    ).toBe(false)
  })

  it('requires the current completed reply as well as short-turn Codex chrome', () => {
    expect(readScreenEvidence(CODEX_SHORT_DONE, detectors, CODEX_SHORT_REPLY)).toMatchObject({
      turnDone: true,
      readyPrompt: true,
      working: false
    })
    for (const reply of [undefined, null, 'a different completed turn']) {
      expect(readScreenEvidence(CODEX_SHORT_DONE, detectors, reply)).toMatchObject({
        turnDone: false,
        readyPrompt: false
      })
    }
    for (const lines of [
      CODEX_SHORT_DONE.slice(2),
      CODEX_SHORT_DONE.filter((line) => !line.startsWith('gpt-')),
      CODEX_SHORT_DONE.filter((line) => !line.startsWith('› Ask')),
      [
        ...CODEX_SHORT_DONE.slice(0, 3),
        '› A newer submitted request',
        ...CODEX_SHORT_DONE.slice(3)
      ],
      [...CODEX_SHORT_DONE, '› A newer submitted request'],
      [
        ...CODEX_SHORT_DONE.slice(0, 3),
        '↳ Recap: Earlier work is complete.',
        ...CODEX_SHORT_DONE.slice(3)
      ],
      [...CODEX_SHORT_DONE.slice(0, 3), ...CODEX_WORKING],
      [...CODEX_SHORT_DONE.slice(0, 3), ...CODEX_UPDATE],
      [...CODEX_SHORT_DONE.slice(0, 3), 'unaccounted output', ...CODEX_SHORT_DONE.slice(3)]
    ]) {
      expect(readScreenEvidence(lines, detectors, CODEX_SHORT_REPLY)).toMatchObject({
        turnDone: false,
        readyPrompt: false
      })
    }
  })

  it('reads a finished turn from Codex’s and Claude’s own "for … · done" lines', () => {
    for (const screen of [
      CODEX_DONE,
      CLAUDE_DONE,
      ['Worked for 3m 35s · 11:26 AM', ...CODEX_DONE.slice(1)],
      ['Worked for 4s • 9:28 AM', ...CODEX_DONE.slice(1)],
      ['Worked for 6s • 9:29 AM', ...CODEX_DONE.slice(1)],
      ['│ Worked for 3m 35s · 11:26 AM · 24.1k tokens │', ...CODEX_DONE.slice(1)]
    ]) {
      expect(readScreenEvidence(screen, detectors)).toEqual({
        blocked: null,
        working: false,
        turnDone: true,
        readyPrompt: false
      })
    }
  })

  it('reads nothing from a screen with neither marker: a quiet screen is not an idle one', () => {
    for (const screen of [CLAUDE_QUIET, GROK_IDLE]) {
      expect(readScreenEvidence(screen, detectors)).toEqual({
        blocked: null,
        working: false,
        turnDone: false,
        readyPrompt: false
      })
    }
  })

  it('reads a turn in flight from Claude’s spinner line and Codex’s status line', () => {
    for (const screen of [CLAUDE_WORKING, CODEX_WORKING]) {
      expect(readScreenEvidence(screen, detectors)).toMatchObject({
        working: true,
        turnDone: false
      })
    }
    // The last turn's "done" line stays on screen while the next one runs: working wins.
    expect(
      readScreenEvidence([...CODEX_DONE.slice(0, 1), ...CODEX_WORKING], detectors)
    ).toMatchObject({ working: true, turnDone: false })
    expect(
      readScreenEvidence(['Worked for 4s • 9:28 AM', ...CODEX_WORKING], detectors)
    ).toMatchObject({ working: true, turnDone: false })
  })

  it('hands the startup detector the whole screen', () => {
    expect(readScreenEvidence(CODEX_UPDATE, detectors).blocked).toBe('codex-update-prompt')
  })

  it('reads "esc to interrupt" in the status area as a turn in flight', () => {
    // Claude's spinner line and Codex's status indicator (samples from this repo's tests).
    for (const line of [
      '✳ Thinking… (esc to interrupt)',
      'Starting MCP servers (0/2): codex_apps, computer-use (2s  esc to interrupt)',
      '•⠂Working (12s • esc⠂to interrupt)'
    ]) {
      expect(readScreenEvidence([...CLAUDE_QUIET, line], detectors).working).toBe(true)
    }
  })

  it('ignores a marker or a ready banner that scrolled out of the status area', () => {
    const history = Array.from({ length: 16 }, (_, index) => `output line ${index}`)
    const stale = readScreenEvidence(
      ['>_ OpenAI Codex', '✳ Thinking… (esc to interrupt)', ...history],
      detectors
    )
    expect(stale).toMatchObject({ working: false, readyPrompt: false })
    expect(readScreenEvidence([...history, '>_ OpenAI Codex'], detectors).readyPrompt).toBe(true)
  })
})

describe('current Codex completion evidence', () => {
  function fixture() {
    const row: AgentStatusIpcPayload = {
      state: 'done',
      prompt: 'Reply briefly.',
      agentType: 'codex',
      agentPid: 42,
      paneKey: 'pane',
      connectionId: null,
      receivedAt: 3000,
      stateStartedAt: 3000,
      lastAssistantMessage: CODEX_SHORT_REPLY,
      providerSession: { key: 'session_id', id: 'current-conversation' }
    }
    const owner = {
      readTerminalAgentForeground: vi.fn(async () => ({ kind: 'agent' as const, agent: 'codex' })),
      readTerminalProcessEvidence: vi.fn<OrcaRuntimeService['readTerminalProcessEvidence']>(
        async () => ({
          proof: {
            ptyId: 'pty',
            incarnationId: 'incarnation',
            rootPid: 40,
            pid: 42,
            pgid: 42,
            startTimeMs: 2000,
            agent: 'codex',
            via: 'hook-report' as const
          },
          tree: { kind: 'other' as const }
        })
      ),
      readTerminal: vi.fn(async (): Promise<RuntimeTerminalRead> => ({
        handle: 'term',
        status: 'running' as const,
        tail: [
          ...CODEX_SHORT_DONE.slice(0, 3),
          '  ↳ Recap: The result is retained.',
          ...CODEX_SHORT_DONE.slice(3)
        ],
        screenDecorations: [{ kind: 'codex-recap', startRow: 3, endRow: 3 }],
        truncated: false,
        nextCursor: null,
        source: 'screen' as const
      })),
      getTerminalPaneKey: () => 'pane',
      getTerminalProcessIncarnation: () => 'pty:incarnation',
      getLastAgentHookRowForPane: () => row,
      getFreshAgentHookStatusForHandle: () => ({
        ...row,
        lastAssistantMessage: row.lastAssistantMessage ?? null,
        interactivePrompt: row.interactivePrompt ?? null,
        updatedAt: row.receivedAt
      }),
      getReportedProviderSessionsForPane: () => [
        { key: 'session_id' as const, id: 'current-conversation' }
      ],
      assertTerminalAgentProcess: vi.fn(async () => {})
    }
    return {
      row,
      owner,
      read: () => collectTerminalAgentEvidence(owner, 'term', 'codex', detectors)
    }
  }

  it('correlates the canonical frame to the still-owning process and its completed turn', async () => {
    const test = fixture()
    expect((await test.read()).screen).toMatchObject({ readyPrompt: true, turnDone: true })
    expect(test.owner.assertTerminalAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 42, startTimeMs: 2000, incarnationId: 'incarnation' }),
      'pty'
    )
  })

  it('uses a re-proved native reporter only for completion and preserves the ordinary wrapper proof', async () => {
    const test = fixture()
    const original = (await test.owner.readTerminalProcessEvidence('term'))!
    test.owner.readTerminalProcessEvidence.mockResolvedValue({
      ...original,
      proof: { ...original.proof!, pid: 41, startTimeMs: 1000, via: 'command-line' },
      completionProof: original.proof
    })
    const evidence = await test.read()
    expect(evidence.screen).toMatchObject({ readyPrompt: true, turnDone: true })
    expect(evidence.process).toMatchObject({ pid: 41, startTimeMs: 1000, via: 'command-line' })
    expect(test.owner.readTerminalProcessEvidence).toHaveBeenLastCalledWith('term', {
      pid: 42,
      completedAt: 3000,
      incarnation: 'pty:incarnation'
    })
    expect(test.owner.assertTerminalAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 42, startTimeMs: 2000 }),
      'pty'
    )
  })

  it('does not substitute an unproved persisted PID for its ordinary wrapper', async () => {
    const test = fixture()
    const original = (await test.owner.readTerminalProcessEvidence('term'))!
    test.owner.readTerminalProcessEvidence.mockResolvedValue({
      ...original,
      proof: { ...original.proof!, pid: 41, startTimeMs: 1000, via: 'command-line' },
      completionProof: null
    })
    expect((await test.read()).screen?.readyPrompt).toBe(false)
    expect(test.owner.assertTerminalAgentProcess).not.toHaveBeenCalled()
  })

  it('rejects a changed completion candidate during the asynchronous process sample', async () => {
    const changed = fixture()
    const original = changed.owner.readTerminalProcessEvidence.getMockImplementation()!
    changed.owner.readTerminalProcessEvidence.mockImplementation(async (...args) => {
      changed.row.stateStartedAt += 1
      return original(...args)
    })
    expect((await changed.read()).screen?.readyPrompt).toBe(false)
    expect(changed.owner.assertTerminalAgentProcess).not.toHaveBeenCalled()

    const replaced = fixture()
    const sample = replaced.owner.readTerminalProcessEvidence.getMockImplementation()!
    replaced.owner.readTerminalProcessEvidence.mockImplementation(async (...args) => {
      replaced.owner.getTerminalProcessIncarnation = () => 'pty:replacement'
      return sample(...args)
    })
    expect((await replaced.read()).screen?.readyPrompt).toBe(false)
  })

  it('does not request completion recovery without matching fresh reporter and provider identity', async () => {
    const stale = fixture()
    const fresh = stale.owner.getFreshAgentHookStatusForHandle
    stale.owner.getFreshAgentHookStatusForHandle = () => ({ ...fresh(), agentPid: 43 })
    expect((await stale.read()).screen?.readyPrompt).toBe(false)
    expect(stale.owner.readTerminalProcessEvidence).toHaveBeenCalledWith('term', undefined)

    const other = fixture()
    other.row.providerSession = { key: 'session_id', id: 'other-conversation' }
    expect((await other.read()).screen?.readyPrompt).toBe(false)
    expect(other.owner.readTerminalProcessEvidence).toHaveBeenCalledWith('term', undefined)
  })

  it('refuses stale, replaced, failed, interrupted and non-assistant hook evidence', async () => {
    for (const patch of [
      { agentPid: 41 },
      { stateStartedAt: 1000 },
      { state: 'working' as const },
      { restoredUnconfirmed: true },
      { failed: true },
      { interrupted: true },
      { sessionBoundary: true },
      { lastAssistantMessageIsToolOutput: true },
      { interactivePrompt: '{}' },
      { providerSession: { key: 'session_id' as const, id: 'old' } }
    ]) {
      const test = fixture()
      Object.assign(test.row, patch)
      expect((await test.read()).screen).toMatchObject({ readyPrompt: false, turnDone: false })
    }
  })

  it('refuses a turn change during screen capture or process ownership loss', async () => {
    const changed = fixture()
    const original = changed.owner.readTerminal.getMockImplementation()!
    changed.owner.readTerminal.mockImplementation(async () => {
      changed.row.stateStartedAt += 1
      return original()
    })
    expect((await changed.read()).screen?.readyPrompt).toBe(false)
    const replaced = fixture()
    replaced.owner.assertTerminalAgentProcess.mockRejectedValue(new Error('process replaced'))
    expect((await replaced.read()).screen?.readyPrompt).toBe(false)
  })
})

// Captured from a completed session on 2026-09-26: narration had been read as a current ask.
it('retires historical trust reports while preserving wrapped dialogs and provider banners', () => {
  expect(
    findWorkspaceTrustPromptIndex(
      [
        'The sweeper is stuck on Claude’s folder-trust prompt.',
        'Yes, I trust this folder is now selected.',
        'The sweeper got stuck on Claude’s “trust this folder?” prompt, so I answered yes for it.',
        ...CLAUDE_DONE
      ].join('\n')
    )
  ).toBeNull()
  for (const dialog of [
    'Do you trust this workspace directory?\n1. Yes\n2. No',
    'Do you trust the files in this\nfolder?\n1. Yes\n2. No',
    'Trusted workspace required\nPress t to trust',
    'Accessing workspace:\n/private/tmp/repo\n❯ 1. Yes, I trust this folder\n  2. No, exit',
    'Do you trust the contents of this directory?\n  ▶ [a] Trust this workspace\n    [q] Quit'
  ]) {
    expect(findWorkspaceTrustPromptIndex(dialog)).not.toBeNull()
    expect(findWorkspaceTrustPromptIndex(`${dialog}\n${CLAUDE_DONE.join('\n')}`)).toBeNull()
    expect(findWorkspaceTrustPromptIndex(`${dialog}\n${CODEX_WORKING.join('\n')}`)).toBeNull()
  }
})
