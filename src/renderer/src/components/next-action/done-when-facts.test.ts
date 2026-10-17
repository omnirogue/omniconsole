/**
 * The Outcome head names open conditions for a person, not for a machine: a handoff condition
 * reads as the person's name the chain already knows, a file condition as its basename, and a
 * long list is counted before it is listed (Sal's screenshot, 2026-09-18: "· open:
 * emp_sal_qa_test, /Users/…/session-handoff-live-0914/hat.html").
 */
import { expect, it } from 'vitest'
import { doneWhenFacts, doneWhenOpenParts, type DoneWhenFacts } from './done-when-facts'
import { nextActionChainFixture } from './next-action-fixture'
import type { SessionChain } from '../../../../shared/session-chain-types'

const HAT =
  '/Users/maintainer/omni/workspaces/next-actions-live-20260913/session-handoff-live-0914/hat.html'

/** The head's open line as `OutcomeLine` lays it out: the lead, then the names in order. */
function openLine(facts: Pick<DoneWhenFacts, 'open'>): string {
  const parts = doneWhenOpenParts(facts)
  return `${parts.lead} ${parts.names.map((name) => name.label).join(', ')}`
}

/** The screenshot's chain: two unlabelled conditions, and a handoff step that names the person. */
function screenshotChain(): SessionChain {
  const chain = nextActionChainFixture(0)
  chain.outcomeSet!.outcomes[0]!.conditions = [
    {
      id: 'person',
      kind: 'handoff',
      target: 'emp_sal_qa_test',
      recipientId: 'emp_sal_qa_test'
    },
    { id: 'file', kind: 'file', target: HAT }
  ]
  chain.steps = [
    {
      kind: 'handoff',
      id: 'handoff_1',
      status: 'queued',
      handoff: {
        revision: 1,
        taskId: null,
        taskTitle: '',
        sessionLabel: 'hat',
        recipients: [
          {
            employeeId: 'emp_sal_qa_test',
            name: 'Sal Test Blake Test',
            operationId: 'op_00000001',
            delivery: 'pending'
          }
        ],
        deliverables: { kind: 'files', paths: [] },
        includeSummary: false,
        note: '',
        savedAt: 1
      }
    }
  ]
  return chain
}

it('names the person and the file, keeping the identifiers behind them', () => {
  const facts = doneWhenFacts(screenshotChain())
  expect(facts.items.map((item) => item.label)).toEqual(['Sal Test Blake Test', 'hat.html'])
  expect(facts.items.map((item) => item.detail)).toEqual(['emp_sal_qa_test', HAT])
  expect(openLine(facts)).toBe('· open: Sal Test Blake Test, hat.html')
})

it('falls back to the id when no name is known, and keeps the person’s own words when there are some', () => {
  const chain = screenshotChain()
  chain.steps = []
  chain.outcomeSet!.outcomes[0]!.conditions[1]!.label = 'the hat page renders'
  const facts = doneWhenFacts(chain)
  expect(facts.items.map((item) => item.label)).toEqual(['emp_sal_qa_test', 'the hat page renders'])
  expect(facts.items[1]!.detail).toBe(HAT)
})

it('counts a long list before naming it', () => {
  const chain = nextActionChainFixture(0)
  chain.outcomeSet!.outcomes[0]!.conditions = [
    { id: 'a', kind: 'report', target: 'receipt signed' },
    { id: 'b', kind: 'report', target: 'handoff logged' },
    { id: 'c', kind: 'file', target: '/tmp/out/report.md' },
    { id: 'd', kind: 'pr', target: 'omnirogue/omni-ide#412' }
  ]
  const facts = doneWhenFacts(chain)
  const parts = doneWhenOpenParts(facts)
  expect(parts.lead).toBe('· 4 open ·')
  expect(parts.names.map((name) => name.label)).toEqual([
    'receipt signed',
    'handoff logged',
    'report.md',
    'omnirogue/omni-ide#412'
  ])
  expect(openLine(facts)).toBe(
    '· 4 open · receipt signed, handoff logged, report.md, omnirogue/omni-ide#412'
  )
})

it('keeps the mockup wording for a short list', () => {
  expect(openLine(doneWhenFacts(nextActionChainFixture()))).toBe(
    '· open: receipt signed, handoff logged'
  )
})
