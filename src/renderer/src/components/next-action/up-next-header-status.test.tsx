// @vitest-environment happy-dom
/**
 * The line under UP NEXT says what the RUN is doing, from the one policy
 * (`docs/reference/session-run-lifecycle.md`).
 *
 * The evidence this pins: the dispatch watchdog's "No activity was observed for 180s…" sentence
 * was printed as "Stopped at stage 1 of 2 · needs you", with "Add an Agent to fix it" beside it,
 * for a stall the host can retry by itself; and every finished chain read "✓ Done · closed".
 * "Needs you" now appears only with an open request and says what is asked, with the way to
 * meet it; technical text lives under Details; nothing is "closed" by merely finishing.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { UpNextAttention, UpNextHeader } from '../../../../shared/up-next-types'
import { UpNextChainView } from './UpNextChain'
import { UpNextOutcomeContext } from './up-next-outcome-context'
import { UpNextHeaderStatus } from './up-next-header-status'
import { ATTENTION_FIXTURE, FIXTURE_NOW, STALL_DIAGNOSTIC, upNextFixture } from './up-next-fixture'
import { clockLabel } from './up-next-labels'
import type { UpNextController } from './use-up-next'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))

const run = vi.hoisted(() => vi.fn())
vi.mock('./up-next-attention-actions', () => ({
  runUpNextAttentionAction: run,
  upNextAttentionDoors: (focusComposer: () => void) => ({ focusComposer })
}))

const retryDisposition = vi.hoisted(() => vi.fn(async (_chain: unknown) => {}))
vi.mock('./finished-session-disposition', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  retryFinishedSessionDisposition: retryDisposition
}))

afterEach(() => {
  cleanup()
  run.mockReset()
  retryDisposition.mockClear()
})

function controller(scenario: string): UpNextController {
  const write = () => vi.fn(async () => true)
  return {
    view: upNextFixture(scenario),
    error: null,
    disabled: false,
    append: write(),
    update: write(),
    reorder: write(),
    remove: write(),
    commit: write(),
    discardDrafts: write(),
    configureAfter: write()
  }
}

const panel = (): HTMLElement => document.querySelector('[data-up-next-chain]')! as HTMLElement
const FIX_HINT = 'Add an Agent Handoff to fix it.'

it('says a 180 s stall is recovering, with a countdown, and never "needs you"', () => {
  render(<UpNextHeaderStatus header={upNextFixture('recovering').header} now={FIXTURE_NOW} />)
  expect(screen.getByRole('status').textContent).toBe(
    'Recovering automatically · next attempt in 45s'
  )
  expect(document.body.textContent).not.toMatch(/needs you/i)
  expect(document.querySelector('[data-up-next-diagnostic]')).toBeNull()
})

it('keeps the watchdog’s sentence under Details on a recovering track, and offers no fix', () => {
  render(<UpNextChainView controller={controller('recovering')} />)
  expect(document.querySelector('[data-up-next-header-status="recovering"]')).toBeTruthy()
  expect(panel().textContent).toContain('Recovering automatically')
  expect(panel().textContent).not.toMatch(/needs you/i)
  expect(panel().textContent).not.toContain('Stopped at stage')
  expect(panel().textContent).not.toContain('No activity was observed')
  // The host is already fixing it: handing the fix to the person would be wrong.
  expect(panel().textContent).not.toContain(FIX_HINT)
  const stage = document.querySelector('[data-up-next-diagnostic="stage"]') as HTMLElement
  fireEvent.click(within(stage).getByRole('button', { name: /Details/ }))
  expect(stage.querySelector('[data-up-next-diagnostic-text]')!.textContent).toBe(STALL_DIAGNOSTIC)
})

it('says an exhausted recovery FAILED in plain words, the raw diagnostic only under Details', () => {
  render(<UpNextChainView controller={controller('failed')} />)
  const status = document.querySelector('[data-up-next-header-status="failed"]') as HTMLElement
  expect(within(status).getByRole('status').textContent).toBe(
    'Failed · The agent stopped responding'
  )
  expect(panel().textContent).not.toMatch(/needs you/i)
  expect(panel().textContent).not.toContain('No activity was observed')
  const details = within(status).getByRole('button', { name: /Details/ })
  expect(details.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(details)
  expect(details.getAttribute('aria-expanded')).toBe('true')
  expect(status.querySelector('[data-up-next-diagnostic-text]')!.textContent).toBe(STALL_DIAGNOSTIC)
  expect(status.querySelector('[data-up-next-diagnostic-code]')!.textContent).toBe('worker-stalled')
  // An honest failure nothing will retry IS the person's move, so the fix hint shows.
  expect(panel().textContent).toContain(FIX_HINT)
})

it('prints "Needs you: <ask>" with the request’s own action button, wired to its door', () => {
  const c = controller('needs-you')
  render(<UpNextChainView controller={c} />)
  const status = screen.getByRole('status')
  expect(status.textContent).toContain(`Needs you: ${ATTENTION_FIXTURE.ask}`)
  expect(status.querySelector('[data-up-next-attention]')!.getAttribute('title')).toBe(
    ATTENTION_FIXTURE.why
  )
  // A clarification says exactly what to do; it does not ask the person to re-plan.
  expect(panel().textContent).not.toContain(FIX_HINT)
  fireEvent.click(within(status).getByRole('button', { name: 'Answer' }))
  expect(run).toHaveBeenCalledTimes(1)
  const [request, context, doors] = run.mock.calls[0]!
  expect(request).toEqual(ATTENTION_FIXTURE)
  // The fixture's track belongs to the conversation in pane `pane`; no pursuit is in context.
  expect(context).toEqual({ ownPaneKey: 'pane', chainId: null })
  // "Open Up next" puts the person on the composer's add bar.
  ;(doors as { focusComposer: () => void }).focusComposer()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '+ Prompt' }))
})

it('hands the pressed request to its caller, one button per request', () => {
  const onAction = vi.fn()
  const decide: UpNextAttention = {
    id: 'att_review-findings_o1_y2',
    kind: 'decision',
    ask: 'Decide what happens to 2 open review findings.',
    why: 'All 2 authorized review rounds are used; another one needs your say.',
    action: { kind: 'open-up-next', label: 'Decide' }
  }
  render(
    <UpNextHeaderStatus
      header={{ state: 'needs-you', attention: [ATTENTION_FIXTURE, decide] }}
      onAction={onAction}
    />
  )
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Decide' }))
  expect(onAction).toHaveBeenCalledWith(decide)
})

it('shows the fix hint for a request that asks the person to DECIDE the next stage', () => {
  const c = controller('needs-you')
  c.view!.header = {
    state: 'needs-you',
    attention: [{ ...ATTENTION_FIXTURE, kind: 'decision' }]
  }
  render(<UpNextChainView controller={c} />)
  expect(panel().textContent).toContain(FIX_HINT)
})

it('says who a waiting run waits for', () => {
  render(<UpNextHeaderStatus header={upNextFixture('waiting').header} />)
  expect(screen.getByRole('status').textContent).toBe('Waiting for Jordan Taylor')
  expect(document.body.textContent).not.toMatch(/needs you/i)
})

it('reads a finished run as Completed — closed only when a close was applied', () => {
  render(<UpNextHeaderStatus header={upNextFixture('completed').header} />)
  const completed = document.querySelector('[data-up-next-header-status="completed"]')!
  expect(completed.textContent).toBe(`✓ Completed ${clockLabel(1)}`)
  expect(completed.textContent).not.toContain('closed')
  cleanup()
  render(<UpNextHeaderStatus header={upNextFixture('closed').header} />)
  expect(document.querySelector('[data-up-next-header-status="closed"]')!.textContent).toBe(
    `✓ Done · closed ${clockLabel(1)}`
  )
  cleanup()
  render(<UpNextHeaderStatus header={upNextFixture('saved').header} />)
  expect(document.querySelector('[data-up-next-header-status="completed"]')!.textContent).toBe(
    `✓ Completed ${clockLabel(1)} · saved`
  )
})

it('never reports Closed before it happened: a pending close stays Completed', () => {
  render(
    <UpNextHeaderStatus
      header={{
        state: 'completed',
        disposition: { intent: 'close', state: 'pending' }
      }}
    />
  )
  expect(document.body.textContent).toBe('✓ Completed · closing the session…')
  expect(document.querySelector('[data-session-disposition-failed]')).toBeNull()
})

const closeFailed: UpNextHeader = {
  state: 'completed',
  completedAt: 1,
  disposition: {
    intent: 'close',
    state: 'failed',
    error: 'The tab is pinned.'
  }
}

it('keeps a run whose close ran out of retries Completed, with a quiet way to try again', async () => {
  const onRetry = vi.fn(async () => {})
  render(<UpNextHeaderStatus header={closeFailed} onRetryDisposition={onRetry} />)
  const status = document.querySelector('[data-up-next-header-status="completed"]') as HTMLElement
  // The run's own line is untouched: the work is complete, whatever became of its window.
  expect(status.querySelector('p')!.textContent).toBe(`✓ Completed ${clockLabel(1)}`)
  const quiet = status.querySelector('[data-session-disposition-failed="close"]') as HTMLElement
  expect(quiet.textContent).toContain('Could not close this session')
  expect(quiet.className).toContain('text-muted-foreground')
  expect(quiet.className).not.toContain('text-destructive')
  // It is neither a request nor a failure of the work, and the host's reason is not a headline.
  expect(status.textContent).not.toMatch(/needs you|failed/i)
  expect(document.querySelector('[data-up-next-attention]')).toBeNull()
  expect(status.textContent).not.toContain('The tab is pinned.')
  fireEvent.click(within(quiet).getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(within(quiet).getByRole('button', { name: 'Try again' })).toBeTruthy())
  fireEvent.click(within(quiet).getByRole('button', { name: /Details/ }))
  expect(quiet.querySelector('[data-up-next-diagnostic-text]')!.textContent).toBe(
    'The tab is pinned.'
  )
})

it('says a save that did not happen the same quiet way, and shows why a retry was refused', async () => {
  const onRetry = vi.fn(async () => {
    throw new Error('The execution host is not reachable.')
  })
  render(
    <UpNextHeaderStatus
      header={{
        state: 'completed',
        disposition: { intent: 'save', state: 'failed' }
      }}
      onRetryDisposition={onRetry}
    />
  )
  const quiet = document.querySelector('[data-session-disposition-failed="save"]') as HTMLElement
  expect(quiet.textContent).toContain('Could not save this session')
  // No reason was recorded, so there is nothing to fold under Details.
  expect(within(quiet).queryByRole('button', { name: /Details/ })).toBeNull()
  fireEvent.click(within(quiet).getByRole('button', { name: 'Try again' }))
  expect((await within(quiet).findByRole('alert')).textContent).toBe(
    'The execution host is not reachable.'
  )
})

it('offers no retry where the surface cannot reach the run', () => {
  render(<UpNextHeaderStatus header={closeFailed} />)
  expect(document.body.textContent).toContain('Could not close this session')
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})

it('wires Try again on the finished track to the pursuit in context', async () => {
  const c = controller('completed')
  c.view!.header = closeFailed
  render(
    <UpNextOutcomeContext value="source_1">
      <UpNextChainView controller={c} />
    </UpNextOutcomeContext>
  )
  expect(document.querySelector('[data-up-next-header-status="completed"]')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(retryDisposition).toHaveBeenCalledWith('source_1'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy())
})

it('says nothing while the run is simply running or idle', () => {
  const { container } = render(<UpNextHeaderStatus header={{ state: 'running' }} />)
  expect(container.textContent).toBe('')
})
