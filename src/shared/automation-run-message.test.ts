import { describe, expect, it } from 'vitest'
import { readAutomationRunMessage } from './automation-run-message'
import {
  describeDeadAutomationTerminal,
  hasAutomationTerminalChrome,
  stripAutomationTerminalChrome
} from './automation-terminal-chrome'

/** Shapes taken from the local Advertising routine on 2026-09-20 (runs 7 and 8). */
const REPORT = `**Old AI Creator Secrets: $421.89 spent today.**

WebinarJam failed on page 20; no retry was made.

[Full report](/Users/maintainer/report.md). Five-line memory entry appended.`

const CLEAN_BLOCK = `\`\`\`omni-actions
[
  {
    "id": "a1",
    "kind": "pause",
    "label": "Pause US Home UnlimitedUse",
    "nativeId": "120254545222220416",
    "name": "US-Sep20-DTC — AS01-UnlimitedUseNoCaps399Life",
    "reason": "UnlimitedUse has 21 links, 0 registrations and 1 checkout at $30.12."
  }
]
\`\`\``

const SCRAPE = `%${' '.repeat(70)}
${' '}

maintainer@mac-studio Marketing % >....
- End with exactly one fenced \`omni-actions\` block and nothing after it.

╭───────────────────────────────────────╮│ >_ OpenAI Codex (v0.155.1)            ││                                       ││ model:     loading   /model to change ││ directory: loading                    │╰───────────────────────────────────────╯  Resuming session… › Ask Codex to do anything   ? for shortcuts
╭─────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.155.1)                      │
│                                                 │
│ model:       gpt-6-astra low   /model to change │
│ directory:   ~/Work/OmniRogue/Marketing         │
│ permissions: YOLO mode                          │
╰─────────────────────────────────────────────────╯

  Tip: You can resume a previous conversation by running codex resume
Earlier messages are available — press ctrl + t to view the full transcript

• Ran /Users/maintainer/.local/bin/orca status --json

  Old AI Creator Secrets: $421.89 spent today; $2,105/day configured.

  \`\`\`omni-actions
  [
    {
      "id": "a1",
      "kind": "pause",
      "label": "Pause US Home UnlimitedUse",
      "nativeId": "120254545222220416",
      "name": "US-Sep20-DTC-LIFE399-SD25-Home-CBO300-5AS-OldACS — AS01-
      UnlimitedUseNoCaps399Life",
      "reason": "UnlimitedUse has 21 links, 0 registrations and 1 checkout at
      $30.12."
    }
  ]
  \`\`\`

  Worked for 8m 30s · done 4:08 PM

■ Conversation interrupted - tell the model what to do differently. Something
went wrong? Hit \`/feedback\` to report the issue.    🔒  This conversation is open in another app                      R to Retry      Close it there and press R to continue here.    r retry   esc/ctrl+c/q exit   ctrl+t transcript%`

describe('automation terminal chrome', () => {
  it('recognises the Codex screen scrape and describes the dead pane in words', () => {
    expect(hasAutomationTerminalChrome(SCRAPE)).toBe(true)
    expect(hasAutomationTerminalChrome(`${REPORT}\n\n${CLEAN_BLOCK}`)).toBe(false)
    expect(describeDeadAutomationTerminal(SCRAPE)).toMatch(/open in another app/)
    expect(describeDeadAutomationTerminal(SCRAPE)).not.toMatch(/[│╭■]/)
    expect(describeDeadAutomationTerminal(REPORT)).toBeNull()
  })
  it('strips the banner, key hints, launch box, prompt and status footer', () => {
    const stripped = stripAutomationTerminalChrome(SCRAPE)
    expect(stripped).toContain('Old AI Creator Secrets: $421.89 spent today')
    expect(stripped).toContain('Ran /Users/maintainer/.local/bin/orca status --json')
    for (const chrome of [
      'Conversation interrupted',
      'R to Retry',
      'ctrl+t transcript',
      'Worked for 8m 30s',
      'OpenAI Codex',
      'Resuming session',
      'Ask Codex to do anything',
      'Tip: You can resume',
      'Earlier messages are available',
      'maintainer@mac-studio',
      '╭',
      '│'
    ]) {
      expect(stripped).not.toContain(chrome)
    }
    expect(stripped.startsWith('%')).toBe(false)
    expect(stripped.endsWith('%')).toBe(false)
  })
})

describe('readAutomationRunMessage', () => {
  it('separates a clean report from its block', () => {
    const message = readAutomationRunMessage(`${REPORT}\n\n${CLEAN_BLOCK}`)
    expect(message).toMatchObject({ recommendations: 'ready', scraped: false })
    expect(message.actions.map((action) => action.id)).toEqual(['a1'])
    expect(message.text).toBe(REPORT)
    expect(message.text).not.toContain('omni-actions')
  })
  it('never parses actions out of a scrape, even when a fence is visible', () => {
    const message = readAutomationRunMessage(SCRAPE)
    expect(message).toMatchObject({ recommendations: 'unreadable', scraped: true, actions: [] })
    expect(message.text).not.toContain('R to Retry')
  })
  it('reports an empty block as no changes and a broken one as unreadable', () => {
    expect(readAutomationRunMessage(`${REPORT}\n\`\`\`omni-actions\n[]\n\`\`\``)).toMatchObject({
      recommendations: 'empty',
      text: REPORT
    })
    expect(
      readAutomationRunMessage(`${REPORT}\n\`\`\`omni-actions\n[{"id": \n\`\`\``)
    ).toMatchObject({ recommendations: 'unreadable', text: REPORT })
    expect(readAutomationRunMessage(REPORT)).toMatchObject({ recommendations: 'none' })
  })
  it('trims long output head and tail without ever cutting the fence', () => {
    const long = `${'lead line\n'.repeat(3_000)}${REPORT}\n\n${CLEAN_BLOCK}`
    const message = readAutomationRunMessage(long, { maxChars: 8_000 })
    expect(message.recommendations).toBe('ready')
    expect(message.text.length).toBeLessThanOrEqual(8_000)
    expect(message.text).toContain('[… output trimmed …]')
    expect(message.text).toContain('Five-line memory entry appended.')
    expect(message.text).not.toContain('omni-actions')
    expect(message.text.startsWith('lead line')).toBe(true)
  })
})
