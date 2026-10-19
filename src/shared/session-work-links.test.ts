import { describe, expect, it } from 'vitest'
import { extractSessionWorkLinks } from './session-work-links'

const ORIGIN = 'https://app.omnisi.ai'
const SLITE = 'https://example.slite.com/app/docs/X3P_WfcLxXPaiG'
const PAGE = `${ORIGIN}/a/1a0d4b88dfada7c9d`
const CLAUDE = 'https://claude.ai/code/artifact/0b1c2d3e-4f5a-6b7c'

describe('extractSessionWorkLinks', () => {
  it('names each Slite doc, omnios page and Claude artifact once, in canonical form', () => {
    const reply = [
      `Plan: ${SLITE} (see ${SLITE}#next-steps).`,
      `Review: ${PAGE}.`,
      `Deck: ${CLAUDE}?utm=1 and ${CLAUDE}`,
      'Not documents: https://claude.ai/chat/0b1c2d3e-4f5a https://example.slite.com.evil.example/app/docs/abcdefgh'
    ].join('\n')
    expect(extractSessionWorkLinks(reply, ORIGIN)).toEqual([SLITE, PAGE, CLAUDE])
  })

  it('reads omnios pages only from the omnios origin this app talks to', () => {
    expect(extractSessionWorkLinks(`Review: ${PAGE}`, null)).toEqual([])
    expect(extractSessionWorkLinks('https://other.example/a/1a0d4b88dfada7c9d', ORIGIN)).toEqual([])
  })
})
