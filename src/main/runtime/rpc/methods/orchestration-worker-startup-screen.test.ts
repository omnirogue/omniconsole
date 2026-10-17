import { describe, expect, it, vi } from 'vitest'
import { visibleWorkerStartupPrompt } from './orchestration-worker-startup-screen'

function reader(tail: string[], source: string = 'screen') {
  return { readTerminal: vi.fn(async () => ({ tail, source })) }
}

describe('visibleWorkerStartupPrompt', () => {
  it("names Claude's folder-trust dialog on the rendered screen, so no prompt is typed into it", async () => {
    const runtime = reader([
      'Accessing workspace:',
      'Quick safety check: Is this a project you created or one you trust?',
      '❯ No, exit',
      '  Yes, I trust this folder',
      'Enter to confirm · Esc to cancel'
    ])
    await expect(visibleWorkerStartupPrompt(runtime, 'term_1', 'claude')).resolves.toBe(
      'codex-trust-workspace'
    )
    expect(runtime.readTerminal).toHaveBeenCalledWith('term_1', { screen: true, limit: 60 })
  })

  it("names Claude's bypass-permissions confirmation too", async () => {
    const runtime = reader([
      'WARNING: Claude Code running in Bypass Permissions mode',
      '❯ 1. No, exit',
      '  2. Yes, I accept'
    ])
    await expect(visibleWorkerStartupPrompt(runtime, 'term_1', 'claude-agent-teams')).resolves.toBe(
      'codex-interactive-prompt'
    )
  })

  it('lets a ready Claude, another agent, a stream reply or an unreadable screen through', async () => {
    await expect(
      visibleWorkerStartupPrompt(reader(['╭─ Claude Code', '> ']), 'term_1', 'claude')
    ).resolves.toBeNull()
    const trust = ['  Yes, I trust this folder', '❯ No, exit']
    const codex = reader(trust)
    await expect(visibleWorkerStartupPrompt(codex, 'term_1', 'codex')).resolves.toBeNull()
    expect(codex.readTerminal).toHaveBeenCalledOnce()
    // A stream keeps a dialog the person already answered in its scrollback.
    await expect(
      visibleWorkerStartupPrompt(reader(trust, 'screen-unavailable'), 'term_1', 'claude')
    ).resolves.toBeNull()
    const failing = {
      readTerminal: vi.fn(async (): Promise<{ tail: string[] }> => {
        throw new Error('gone')
      })
    }
    await expect(visibleWorkerStartupPrompt(failing, 'term_1', 'claude')).resolves.toBeNull()
  })

  it("does not read a dialog's words in a reused terminal's transcript as the dialog", async () => {
    const quoted = [
      '⏺ The detector matches "Yes, I trust this folder" and the choice:',
      '    ❯ No, exit',
      ...Array.from({ length: 20 }, (_, index) => `  transcript line ${index}`),
      '╭──────────────────────────────╮',
      '│ >                            │',
      '╰──────────────────────────────╯',
      '',
      ''
    ]
    await expect(visibleWorkerStartupPrompt(reader(quoted), 'term_1', 'claude')).resolves.toBeNull()
    // The words alone, with no "No, exit" choice drawn, are prose, not the dialog.
    const prose = ['Claude asked "Is this a project you created or one you trust?" earlier.', '> ']
    await expect(visibleWorkerStartupPrompt(reader(prose), 'term_1', 'claude')).resolves.toBeNull()
  })

  it('finds a live dialog at the bottom of a screen, under earlier output and above blank rows', async () => {
    const screen = [
      ...Array.from({ length: 30 }, (_, index) => `startup line ${index}`),
      'Quick safety check: Is this a project you created or one you trust?',
      '❯ 1. Yes, I trust this folder',
      '  2. No, exit',
      'Enter to confirm · Esc to cancel',
      ...Array.from({ length: 10 }, () => '')
    ]
    await expect(visibleWorkerStartupPrompt(reader(screen), 'term_1', 'claude')).resolves.toBe(
      'codex-trust-workspace'
    )
  })

  const codexUpdate = [
    '│ >_ OpenAI Codex (v0.159.2)',
    '› Ask Codex to do anything ? for shortcuts',
    '✨ Update available! 0.159.2 -> 0.160.1',
    '› 1. Update now (runs `npm install -g @openai/codex`)',
    '  2. Skip',
    '  3. Skip until next version',
    'Press enter to continue'
  ]

  it.each([false, true])(
    'blocks the Codex updater over an idle composer (squashed=%s)',
    async (squashed) => {
      const screen = squashed ? codexUpdate.map((line) => line.replace(/ /g, '')) : codexUpdate
      await expect(visibleWorkerStartupPrompt(reader(screen), 'term_1', 'codex')).resolves.toBe(
        'codex-update-prompt'
      )
    }
  )

  it('ignores an answered Codex updater in scrollback and incomplete update prose', async () => {
    await expect(
      visibleWorkerStartupPrompt(
        reader([
          ...codexUpdate,
          ...Array.from({ length: 20 }, () => 'Completed task output'),
          '› Next task'
        ]),
        'term_1',
        'codex'
      )
    ).resolves.toBeNull()
    await expect(
      visibleWorkerStartupPrompt(
        reader(['An update available notification was shown earlier.', '› Next task']),
        'term_1',
        'codex'
      )
    ).resolves.toBeNull()
    await expect(
      visibleWorkerStartupPrompt(reader(codexUpdate, 'stream'), 'term_1', 'codex')
    ).resolves.toBeNull()
  })

  it.each([
    ['Do you trust the contents of this directory?', 'codex-trust-workspace'],
    ['Codex just got an upgrade. Press enter to continue', 'codex-model-migration-prompt'],
    ['Choose working directory to continue. Press enter to continue', 'codex-cwd-prompt'],
    ['Sign in with ChatGPT', 'codex-interactive-prompt']
  ])('retains the existing intervention classification for %s', async (screen, blocker) => {
    await expect(visibleWorkerStartupPrompt(reader([screen]), 'term_1', 'codex')).resolves.toBe(
      blocker
    )
  })
})
