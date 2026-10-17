// @vitest-environment happy-dom
/**
 * "Send to a person" on the track. What was composed behind a send that does not wait sits below
 * where the track ends, marked "won't run", still the person's to move or delete, and the primary
 * button never counts it. A sent block states its one status line on the row itself — a review
 * that came back stays in view — and a send that did not go out offers the host's Resume.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const resume = vi.hoisted(() => vi.fn(async (args: { id: string }) => ({ id: args.id })))
const registry = vi.hoisted(() => ({ chain: null as unknown }))
vi.mock('@/components/next-step/next-step-outcome-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resumeSessionOutcomes: resume
}))
vi.mock('@/lib/session-chain-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionChain: () => registry.chain,
  setSessionChainEntry: vi.fn(),
  publishSessionChains: vi.fn()
}))

import { UpNextChainView } from './UpNextChain'
import { UpNextOutcomeContext } from './up-next-outcome-context'
import { agentFixture, upNextFixture } from './up-next-fixture'
import type { UpNextController } from './use-up-next'
import type { UpNextBlock, UpNextPersonBlock } from '../../../../shared/up-next-types'

afterEach(cleanup)

function send(patch: Partial<UpNextPersonBlock> = {}): UpNextPersonBlock {
  return {
    id: 'draft:send',
    kind: 'person',
    state: 'draft',
    number: '1',
    locked: false,
    relationship: 'handoff',
    people: [{ id: 'emp_gamma', name: 'Gamma', initials: 'GA' }],
    receive: { files: true, transcript: true, createTaskCard: false },
    ...patch
  }
}

function controller(...blocks: UpNextBlock[]): UpNextController {
  const write = () => vi.fn(async () => true)
  return {
    view: { ...upNextFixture('busy'), blocks },
    disabled: false,
    error: null,
    append: write(),
    update: write(),
    reorder: write(),
    remove: write(),
    commit: write(),
    discardDrafts: write(),
    configureAfter: write()
  }
}

const row = (id: string) => document.querySelector(`[data-up-next-block="${id}"]`) as HTMLElement

it('puts what follows an unticked send below where the track ends, marked "won\'t run"', () => {
  const c = controller(send(), agentFixture('draft:after', { state: 'draft' }))
  render(<UpNextChainView controller={c} />)

  const after = row('draft:after')
  expect(after.getAttribute('data-wont-run')).toBe('true')
  expect(within(after).getByText("won't run")).toBeTruthy()
  expect(within(after).queryByText('not queued yet')).toBeNull()
  expect(row('draft:send').getAttribute('data-wont-run')).toBeNull()
  // The track ends at the send; the stranded draft is drawn after that mark.
  const stop = document.querySelector('[data-up-next-stop]')!
  expect(stop.textContent).toBe('ends here')
  expect(stop.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  // Still the person's draft: it can be moved above the send or deleted.
  expect(within(after).getByRole('button', { name: 'Move up' })).toBeTruthy()
  // The one thing the primary button queues is the send.
  expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false)
})

it('states the status line on a sent row, and keeps a review that came back in view', () => {
  render(
    <UpNextChainView
      controller={controller(
        send({ id: 'step:ok', state: 'done', locked: true, relationship: 'review' }),
        agentFixture('node:fix', { state: 'queued' })
      )}
    />
  )
  expect(row('step:ok').textContent).toContain('Gamma said OK. Your steps are running now.')
  cleanup()
  render(
    <UpNextChainView
      controller={controller(send({ id: 'step:queued', state: 'queued', relationship: 'handoff' }))}
    />
  )
  expect(
    row('step:queued').querySelector('[data-up-next-send-status="pending"]')!.textContent
  ).toBe('Sends when the work before it is done.')
})

it('offers Try again on a send that did not go out, through the host Resume', async () => {
  registry.chain = { id: 'chain-1', outcomeSet: { revision: 7 } }
  // Failed before capture: nothing left, so it is still queued work the person may take back.
  const c = controller(
    send({ id: 'step:failed', state: 'queued', locked: false, sendFailure: 'failed' })
  )
  render(
    <UpNextOutcomeContext value="chain-1">
      <UpNextChainView controller={c} />
    </UpNextOutcomeContext>
  )
  expect(row('step:failed').textContent).toContain("Didn't send. Nothing changed.")
  fireEvent.click(within(row('step:failed')).getByRole('button', { name: 'Remove' }))
  expect(c.remove).toHaveBeenCalledWith('step:failed')
  await act(async () => {
    fireEvent.click(within(row('step:failed')).getByRole('button', { name: 'Try again' }))
  })
  expect(resume).toHaveBeenCalledWith({
    id: 'chain-1',
    owner: registry.chain,
    expectedRevision: 7
  })
})

it('says who a send already reached, and offers Try again for the rest', () => {
  registry.chain = { id: 'chain-1', outcomeSet: { revision: 7 } }
  render(
    <UpNextOutcomeContext value="chain-1">
      <UpNextChainView
        controller={controller(
          send({
            id: 'step:part',
            state: 'running',
            locked: true,
            people: [
              { id: 'emp_uma', name: 'Uma', initials: 'UM' },
              { id: 'emp_gamma', name: 'Gamma', initials: 'GA' }
            ],
            sendFailure: 'recovering',
            reachedIds: ['emp_uma']
          })
        )}
      />
    </UpNextOutcomeContext>
  )
  const status = row('step:part').querySelector('[data-up-next-send-status]')!
  expect(status.getAttribute('data-up-next-send-status')).toBe('part-sent')
  expect(status.textContent).toContain("Sent to Uma. Didn't reach Gamma.")
  expect(status.textContent).not.toContain('Nothing changed')
  expect(within(row('step:part')).getByRole('button', { name: 'Try again' })).toBeTruthy()
})

it('keeps a send below work already queued: it cannot climb above that work', () => {
  const draftSend = send({ relationship: null })
  render(
    <UpNextChainView
      controller={controller(
        agentFixture('node:one', { state: 'running', locked: true }),
        agentFixture('node:two'),
        draftSend
      )}
    />
  )
  const up = () => within(row('draft:send')).getByRole('button', { name: 'Move up' })
  expect(up().hasAttribute('disabled')).toBe(true)
  cleanup()
  // Above a composed block it may still move: that block is held behind it.
  render(
    <UpNextChainView
      controller={controller(
        agentFixture('node:one'),
        agentFixture('draft:two', { state: 'draft' }),
        draftSend
      )}
    />
  )
  expect(up().hasAttribute('disabled')).toBe(false)
})

it('lets the person drop what an unticked send left behind once the run has finished', () => {
  const closed = upNextFixture('closed')
  const c = controller()
  c.view = {
    ...closed,
    blocks: [
      send({ id: 'step:gave', state: 'done', locked: true, sentAt: 1 }),
      agentFixture('draft:left', { state: 'draft' }),
      agentFixture('draft:also', { state: 'draft' })
    ],
    draftCount: 2
  }
  render(<UpNextChainView controller={c} />)

  const left = row('draft:left')
  expect(left.getAttribute('data-wont-run')).toBe('true')
  expect(document.querySelector('[data-up-next-stop]')!.textContent).toBe('ended here')
  const remove = within(left).getByRole('button', { name: 'Remove' })
  expect(remove.hasAttribute('disabled')).toBe(false)
  fireEvent.click(remove)
  expect(c.remove).toHaveBeenCalledWith('draft:left')
  // It may still trade places with the other leftover, never climb above the send it followed.
  expect(within(left).getByRole('button', { name: 'Move down' }).hasAttribute('disabled')).toBe(
    false
  )
  expect(within(left).getByRole('button', { name: 'Move up' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'discard drafts' }))
  expect(c.discardDrafts).toHaveBeenCalled()
  // A finished run queues nothing: there is no primary button to press.
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Up to date' })).toBeNull()
})
