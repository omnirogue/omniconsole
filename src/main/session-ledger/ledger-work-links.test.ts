import { describe, expect, it } from 'vitest'
import type { LedgerEventDetail } from '../../shared/session-ledger-contract'
import { LedgerPaneRegistry } from './ledger-identity'
import { LedgerWorkLinks } from './ledger-work-links'

const PANE = 'tab-1:leaf-1'
const SLITE = 'https://example.slite.com/app/docs/X3P_WfcLxXPaiG'
const CLAUDE = 'https://claude.ai/artifact/abcdef12'

function setup() {
  const registry = new LedgerPaneRegistry()
  const { entry } = registry.stamp(PANE, { ptyId: 'pty-1' })
  const sent: [string, LedgerEventDetail][] = []
  const links = new LedgerWorkLinks(registry, (row, event) => sent.push([row.ledgerId, event]))
  return { registry, ledgerId: entry.ledgerId, sent, links }
}

describe('LedgerWorkLinks', () => {
  it("records each document a started row's replies name, once per row", () => {
    const { registry, ledgerId, sent, links } = setup()
    registry.update(PANE, { started: true, pendingStart: null })
    links.noteReply(PANE, `Plan: ${SLITE}`, null)
    links.noteReply(PANE, `Again ${SLITE} and the deck ${CLAUDE}`, null)
    expect(sent).toEqual([
      [ledgerId, { kind: 'work_link', detail: { url: SLITE } }],
      [ledgerId, { kind: 'work_link', detail: { url: CLAUDE } }]
    ])
  })

  it('records nothing for a pane with no row, a row not started yet, or an ended one', () => {
    const { registry, sent, links } = setup()
    links.noteReply('tab-2:leaf-1', `Plan: ${SLITE}`, null)
    links.noteReply(PANE, `Plan: ${SLITE}`, null)
    registry.update(PANE, { started: true, pendingStart: null, ended: true })
    links.noteReply(PANE, `Plan: ${SLITE}`, null)
    expect(sent).toEqual([])
  })
})
