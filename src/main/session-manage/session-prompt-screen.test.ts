import { describe, expect, it, vi } from 'vitest'
import type * as NativeChatAsk from '../../shared/native-chat-ask'
import { selectSessionAnswer } from './session-manage-answer'
import { parseSessionPromptScreen, screenShowsPromptMenu } from './session-prompt-screen'

const keys = vi.hoisted(() => ({ override: null as null | (() => { raw: string }[]) }))

vi.mock('../../shared/native-chat-ask', async (original) => {
  const actual = await original<typeof NativeChatAsk>()
  return {
    ...actual,
    buildAskAnswerKeys: (...args: Parameters<typeof actual.buildAskAnswerKeys>) =>
      keys.override ? keys.override() : actual.buildAskAnswerKeys(...args)
  }
})

const CLAUDE_PERMISSION = `Bash command
  git status --short
  Inspect the working tree

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for git status commands
  3. No
Esc to cancel · Tab to amend`

const CODEX_PERMISSION = `Would you like to run the following command?

  $ git status --short

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with git status (p)
  3. No, and tell Codex what to do differently (esc)
Press enter to confirm or esc to cancel`

const CLAUDE_QUESTION = `Which parser should I use?
❯ 1. Existing parser
  2. A new parser
  3. Type something.
Enter to select · ↑/↓ to navigate · Esc to cancel`

const CODEX_QUESTION = `Which parser should I use?
› 1. Existing parser
  2. A new parser
  3. Other
Enter to submit · ↑/↓ to navigate · Tab to add notes · Esc to cancel`

describe('session prompt screen parsing', () => {
  it.each([
    ['claude', CLAUDE_PERMISSION, '1'],
    ['codex', CODEX_PERMISSION, 'y']
  ])('reads the %s permission command and only marks the one-time allow', (agent, screen, key) => {
    const prompt = parseSessionPromptScreen(agent, screen)!
    expect(prompt.ask).toMatchObject({
      kind: 'permission',
      text: expect.stringContaining('git status --short')
    })
    expect(prompt.options.filter((option) => option.role === 'allow-once')).toEqual([
      expect.objectContaining({ n: 1, value: key })
    ])
    expect(prompt.options[1]?.role).toBeUndefined()
    expect(prompt.options[2]).toMatchObject({ n: 3, role: 'deny', value: '\x1b' })
  })

  it.each([
    ['claude', CLAUDE_QUESTION],
    ['codex', CODEX_QUESTION]
  ])('reads the %s single-choice question and excludes the editor row', (agent, screen) => {
    const prompt = parseSessionPromptScreen(agent, screen)!
    expect(prompt.ask).toMatchObject({
      kind: 'question',
      text: 'Which parser should I use?',
      options: [
        { n: 1, label: 'Existing parser' },
        { n: 2, label: 'A new parser' }
      ]
    })
    expect(prompt.options[1]?.value).toBe('2')
  })

  it('uses a matching full question hook and refuses a stale or grouped hook', () => {
    const question = {
      question: 'Which parser should I use?',
      options: [{ label: 'Existing parser' }, { label: 'A new parser' }]
    }
    expect(
      parseSessionPromptScreen('claude', CLAUDE_QUESTION, JSON.stringify({ questions: [question] }))
    ).not.toBeNull()
    expect(
      parseSessionPromptScreen(
        'claude',
        CLAUDE_QUESTION,
        JSON.stringify({ questions: [question, question] })
      )
    ).toBeNull()
    expect(
      parseSessionPromptScreen(
        'claude',
        CLAUDE_QUESTION,
        JSON.stringify({ questions: [{ ...question, question: 'Deploy now?' }] })
      )
    ).toBeNull()
  })

  it('preserves wrapped option descriptions so their actions are checked', () => {
    const screen = CLAUDE_QUESTION.replace(
      '  2. A new parser',
      '  2. A new parser\n     Deploy the app afterwards'
    )
    expect(parseSessionPromptScreen('claude', screen)?.ask.options[1]?.label).toContain(
      'Deploy the app afterwards'
    )
  })

  it('does not reinterpret a permission menu as a question to bypass --allow checks', () => {
    const screen = CLAUDE_PERMISSION.replace(
      'Esc to cancel · Tab to amend',
      'Enter to select · ↑/↓ to navigate · Esc to cancel'
    )
    expect(parseSessionPromptScreen('claude', screen)).toBeNull()
  })

  it('accepts indented prompt chrome without trimming command contents', () => {
    const screen = CLAUDE_PERMISSION.replace('Bash command', ' Bash command').replace(
      'Esc to cancel · Tab to amend',
      ' Esc to cancel · Tab to amend'
    )
    expect(parseSessionPromptScreen('claude', screen)?.ask.kind).toBe('permission')
  })

  it('uses a matching approval hook and classifies its full command on its own', () => {
    const hook = JSON.stringify({ approval: { tool: 'Bash', summary: 'git status --short' } })
    const screen = CLAUDE_PERMISSION.replace('\n  Inspect the working tree', '')
    const prompt = parseSessionPromptScreen('claude', screen, hook)!
    expect(prompt.ask.text).toMatch(/^Bash: git status --short\nBash command/)
    expect(prompt.commandText).toEqual([
      'git status --short',
      'git status --short',
      'git status --short'
    ])
    expect(prompt.readable).toBe(true)
  })

  it.each([
    "git status --short; g''it p''ush origin main",
    'git status --short\n  touch extra-file'
  ])('refuses extra executable screen content outside a short hook: %s', (command) => {
    const screen = CLAUDE_PERMISSION.replace(
      'git status --short\n  Inspect the working tree',
      command
    )
    const hook = JSON.stringify({ approval: { tool: 'Bash', summary: 'git status --short' } })
    expect(parseSessionPromptScreen('claude', screen, hook)).toBeNull()
  })

  it('does not presume that an additional command-block line is a harmless description', () => {
    const hook = JSON.stringify({ approval: { tool: 'Bash', summary: 'git status --short' } })
    expect(parseSessionPromptScreen('claude', CLAUDE_PERMISSION, hook)).toBeNull()
    expect(parseSessionPromptScreen('claude', CLAUDE_PERMISSION)?.readable).toBe(false)
  })

  // BLOCKER-1: the hook's command is what the agent will run; a screen that disagrees with it may
  // be the truncated one, so the prompt is refused outright, as a disagreeing question hook is.
  it.each([
    [
      'names more than the screen shows',
      { tool: 'Bash', summary: 'git log && git push --force origin main' }
    ],
    ['is clipped, so it cannot vouch for the full command', { tool: 'Bash', summary: 'git lo…' }],
    ['is for another tool', { tool: 'Write', summary: 'git log' }],
    ['has no command', { tool: 'Bash' }]
  ])('refuses a permission whose hook %s', (_name, approval) => {
    const screen = CLAUDE_PERMISSION.replace('git status --short', 'git log')
    const hook = JSON.stringify({ approval })
    expect(parseSessionPromptScreen('claude', screen, hook)).toBeNull()
  })

  it.each(['{not json', JSON.stringify({ questions: [] }), JSON.stringify(null), '[]'])(
    'refuses a permission screen with an unusable hook %s',
    (hook) => {
      expect(parseSessionPromptScreen('claude', CLAUDE_PERMISSION, hook)).toBeNull()
    }
  )

  it('keeps the screen alone when the agent sent no approval report', () => {
    for (const hook of [null, undefined, '']) {
      expect(parseSessionPromptScreen('claude', CLAUDE_PERMISSION, hook)?.ask.text).toMatch(
        /^Bash command\n/
      )
    }
  })

  // MAJOR-2-B: a clipped persistent label still reads as "skip it", so --allow must not proceed.
  it('makes the whole menu unreadable when any option label is clipped', () => {
    const screen = CLAUDE_PERMISSION.replace(
      "2. Yes, and don't ask again for git status commands",
      "2. Yes, and don't ask again for git st…"
    )
    const prompt = parseSessionPromptScreen('claude', screen)!
    expect(prompt.readable).toBe(false)
    expect(() => selectSessionAnswer(asPty(prompt), { kind: 'allow' }, { kind: 'cli' })).toThrow(
      'cannot be read completely'
    )
    expect(selectSessionAnswer(asPty(prompt), { kind: 'deny' }, { kind: 'cli' }).value).toBe('\x1b')
  })

  it('never marks a persistent first option as the one-time allow', () => {
    const screen = [
      'Bash command',
      '  git status --short',
      '',
      'Do you want to proceed?',
      "❯ 1. Yes, and don't ask again for git status",
      '  2. No',
      'Esc to cancel · Tab to amend'
    ].join('\n')
    const prompt = parseSessionPromptScreen('claude', screen)!
    expect(prompt.options.filter((option) => option.role === 'allow-once')).toEqual([])
    expect(() => selectSessionAnswer(asPty(prompt), { kind: 'allow' }, { kind: 'cli' })).toThrow(
      'no unambiguous one-time allow'
    )
  })

  // MAJOR-3-B: a free-entry row opens an editor; only the menu's own trailing one is set aside.
  it.each(['Other', 'None of the above', 'Other (specify)', 'Type something.', 'Something else'])(
    'refuses a question with a %s row before the last option',
    (row) => {
      const screen = [
        'Which branch should I use?',
        '❯ 1. Continue',
        `  2. ${row}`,
        '  3. Cancel',
        'Enter to select · ↑/↓ to navigate · Esc to cancel'
      ].join('\n')
      expect(parseSessionPromptScreen('claude', screen)).toBeNull()
    }
  )

  it('gives every question option exactly its own digit', () => {
    for (const [agent, screen] of [
      ['claude', CLAUDE_QUESTION],
      ['codex', CODEX_QUESTION]
    ] as const) {
      for (const option of parseSessionPromptScreen(agent, screen)!.options) {
        expect(option.value).toBe(String(option.n))
      }
    }
  })

  it('drops a key that is not exactly the option digit, so that option cannot be chosen', () => {
    keys.override = () => [{ raw: '1\r' }]
    try {
      const prompt = parseSessionPromptScreen('claude', CLAUDE_QUESTION)!
      expect(prompt.options.map((option) => option.value)).toEqual(['', ''])
      expect(() =>
        selectSessionAnswer(asPty(prompt), { kind: 'choose', choice: 1 }, { kind: 'cli' })
      ).toThrow('no single verified key')
    } finally {
      keys.override = null
    }
  })

  it('sets a trailing Other aside, so its number is not an option at all', () => {
    const screen = CLAUDE_QUESTION.replace('  3. Type something.', '  3. Other')
    const prompt = parseSessionPromptScreen('claude', screen)!
    expect(prompt.options.map((option) => option.label)).toEqual([
      'Existing parser',
      'A new parser'
    ])
    expect(() =>
      selectSessionAnswer(asPty(prompt), { kind: 'choose', choice: 3 }, { kind: 'cli' })
    ).toThrow('not offered')
  })

  it('recognizes a menu footer still on screen even when the menu cannot be parsed', () => {
    expect(screenShowsPromptMenu(`⏺ partial redraw\n  Esc to cancel · Tab to amend`)).toBe(true)
    expect(screenShowsPromptMenu('⏺ Bash(git status --short)\n  ⎿  clean\n> ')).toBe(false)
  })

  // MINOR-R2-3: colored or wrapped, a footer is still a footer.
  it.each([
    ['colored', '\x1b[2mEnter to select · ↑/↓ to navigate · Esc to cancel\x1b[0m'],
    ['wrapped mid-word', 'Enter to select · ↑/↓ to navi\ngate · Esc to can\ncel'],
    ['a colored Codex permission', '\x1b[1mPress enter to confirm\x1b[22m or esc to cancel']
  ])('recognizes a %s footer', (_name, screen) => {
    expect(screenShowsPromptMenu(screen)).toBe(true)
  })

  it('hashes kind, text and options but not the selected row', () => {
    const original = parseSessionPromptScreen('claude', CLAUDE_PERMISSION)!.ask.fingerprint
    const moved = CLAUDE_PERMISSION.replace('❯ 1.', '  1.').replace('  3.', '❯ 3.')
    expect(parseSessionPromptScreen('claude', moved)?.ask.fingerprint).toBe(original)
    expect(
      parseSessionPromptScreen('claude', CLAUDE_PERMISSION.replace('git status --short', 'pwd'))
        ?.ask.fingerprint
    ).not.toBe(original)
    expect(original).toMatch(/^[a-f0-9]{64}$/)
  })

  it('marks truncated command text unreadable so only denial can proceed', () => {
    const prompt = parseSessionPromptScreen(
      'codex',
      CODEX_PERMISSION.replace('git status --short', 'git status …')
    )!
    expect(prompt.readable).toBe(false)
  })

  it.each([
    `${CLAUDE_PERMISSION}\nuser@host % `,
    CLAUDE_PERMISSION.replace('Esc to cancel · Tab to amend', 'unknown footer'),
    CLAUDE_PERMISSION.replace('  3. No', '  4. No'),
    CLAUDE_PERMISSION.replace('❯ 1.', '  1.'),
    CLAUDE_QUESTION.replace('  2. A new parser', '  2. [ ] A new parser'),
    `\x1b[2J${CLAUDE_PERMISSION}`
  ])('refuses stale, unrecognized or ambiguous screens', (screen) => {
    expect(parseSessionPromptScreen('claude', screen)).toBeNull()
  })

  it('refuses the captured preview/grouped selector from native-chat-ask-screen.test.ts', () => {
    const screen = [
      '←  ☒ Placement  ☐ Scheduler scope  ✔ Submit  →',
      "│ Routines only run while the IDE is open — the scheduler lives in the app's main process. How far should I go?",
      '❯ 1. Fix the in-app bugs          ┌──────────────────────┐',
      '    (Recommended)                 │ FIXES                │',
      '  2. Also run without the app     └──────────────────────┘',
      '                                  Notes: press n to add notes',
      '  Chat about this',
      'Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel'
    ].join('\n')
    expect(parseSessionPromptScreen('claude', screen)).toBeNull()
  })

  it('refuses golden-stub startup trust prompts and other providers', () => {
    const trust =
      'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, exit\nEnter to confirm · Esc to cancel'
    expect(parseSessionPromptScreen('codex', trust)).toBeNull()
    expect(parseSessionPromptScreen('grok', CLAUDE_PERMISSION)).toBeNull()
  })
  it('requires matching visible hook headers, fingerprints them and checks their hard stops', () => {
    const question = {
      question: 'Which parser should I use?',
      header: 'Deploy',
      options: [{ label: 'Existing parser' }, { label: 'A new parser' }]
    }
    const hook = JSON.stringify({ questions: [question] })
    expect(parseSessionPromptScreen('claude', CLAUDE_QUESTION, hook)).toBeNull()
    const screen = `Deploy\n${CLAUDE_QUESTION}`
    const prompt = parseSessionPromptScreen('claude', screen, hook)!
    expect(prompt.commandText).toEqual(['Deploy'])
    expect(prompt.ask.fingerprint).not.toBe(
      parseSessionPromptScreen('claude', screen)!.ask.fingerprint
    )
    expect(() =>
      selectSessionAnswer(
        { ...prompt, delivery: { kind: 'pty', handle: 't', ptyId: 'p', screen } },
        { kind: 'choose', choice: 1 },
        { kind: 'cli' }
      )
    ).toThrow('hard stop')
    expect(
      parseSessionPromptScreen(
        'claude',
        `Deplo…\n${CLAUDE_QUESTION}`,
        JSON.stringify({ questions: [{ ...question, header: 'Deplo…' }] })
      )
    ).toBeNull()
  })
})

function asPty(prompt: NonNullable<ReturnType<typeof parseSessionPromptScreen>>) {
  return {
    ...prompt,
    delivery: { kind: 'pty' as const, handle: 'term_1', ptyId: 'pty-1', screen: '' }
  }
}
