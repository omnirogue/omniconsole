import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { detectAgentStartupIntervention } from '../../../../shared/agent-startup-intervention'
import { readTerminalCurrentScreenText } from './terminal-current-screen-text'

describe('native chat current terminal screen', () => {
  const terminals: Terminal[] = []
  afterEach(() => terminals.splice(0).forEach((terminal) => terminal.dispose()))

  const create = () => {
    const terminal = new Terminal({ cols: 120, rows: 6, allowProposedApi: true })
    terminals.push(terminal)
    return terminal
  }
  const write = (terminal: Terminal, text: string) =>
    new Promise<void>((resolve) => terminal.write(text, resolve))

  it('recognizes onboarding and selected trust through cursor-positioned spaces', async () => {
    const terminal = create()
    await write(terminal, 'Choose\x1b[Cthe\x1b[Ctext\x1b[Cstyle that looks best with your terminal')
    expect(
      detectAgentStartupIntervention('claude', readTerminalCurrentScreenText(terminal))?.kind
    ).toBe('onboarding')
    await write(
      terminal,
      '\x1b[2J\x1b[HDo you trust the files in this folder?\r\n❯\x1b[CYes,\x1b[CI\x1b[Ctrust this folder'
    )
    const trust = detectAgentStartupIntervention('claude', readTerminalCurrentScreenText(terminal))
    expect(trust?.kind).toBe('trust-prompt')
    expect(trust?.actions[0]?.keys).toBe('\r')
  })

  it('ignores old onboarding in scrollback even when the viewport is scrolled up', async () => {
    const terminal = create()
    await write(terminal, `Choose the text style\r\n${'ordinary work\r\n'.repeat(12)}`)
    terminal.scrollToTop()
    expect(terminal.buffer.active.viewportY).toBeLessThan(terminal.buffer.active.baseY)
    expect(
      detectAgentStartupIntervention('claude', readTerminalCurrentScreenText(terminal))
    ).toBeNull()
  })

  it('reads the alternate screen without stale normal-screen prompts', async () => {
    const terminal = create()
    await write(terminal, 'Choose the text style\x1b[?1049h\x1b[H❯ Ready')
    expect(readTerminalCurrentScreenText(terminal)).toContain('❯ Ready')
    expect(
      detectAgentStartupIntervention('claude', readTerminalCurrentScreenText(terminal))
    ).toBeNull()
  })

  it('joins soft-wrapped rows so a selected trust option keeps its Enter key', async () => {
    const terminal = new Terminal({ cols: 12, rows: 12, allowProposedApi: true })
    terminals.push(terminal)
    await write(terminal, 'Do you trust the files in this folder?\r\n❯ Yes, I trust this folder')
    const screen = readTerminalCurrentScreenText(terminal)
    expect(screen).toContain('❯ Yes, I trust this folder')
    const trust = detectAgentStartupIntervention('claude', screen)
    expect(trust?.kind).toBe('trust-prompt')
    expect(trust?.actions[0]?.keys).toBe('\r')
  })
})
