import { describe, expect, it } from 'vitest'
import { formatTerminalRead } from './terminal-format'

describe('formatTerminalRead draft separation', () => {
  it('labels composer drafts outside terminal output', () => {
    const output = formatTerminalRead({
      terminal: {
        handle: 'term_1',
        status: 'running',
        tail: ['Build passed', '❯'],
        truncated: false,
        nextCursor: null,
        source: 'screen',
        draft: 'proceed with the release'
      }
    })

    expect(output).toContain('draft: "proceed with the release"')
    expect(output).toContain('\n\nBuild passed\n❯')
  })

  it('says when the agent suggested the draft and nobody typed it', () => {
    const output = formatTerminalRead({
      terminal: {
        handle: 'term_1',
        status: 'running',
        tail: ['❯'],
        truncated: false,
        nextCursor: null,
        source: 'screen',
        draft: 'send the gamma credits',
        draftSuggested: true
      }
    })

    expect(output).toContain(
      'draft: "send the gamma credits" (the agent suggested it; nobody typed it)'
    )
  })
})
