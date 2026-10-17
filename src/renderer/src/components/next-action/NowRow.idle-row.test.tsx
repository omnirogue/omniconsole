// @vitest-environment happy-dom
/**
 * The idle Now row says who is waiting, not just that nothing is running.
 *
 * The mockup's row reads "Now · idle · Claude Code · waiting for you"
 * (`pages/mockup-next-action-panel.html`), and the panel rendered a bare "Now · idle": the
 * `idle` variant could not even carry an agent (S-21). What the host cannot name is still
 * left out rather than guessed.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NowRow } from './NowRow'
import { upNextFixture } from './up-next-fixture'

afterEach(cleanup)

const row = (): HTMLElement => document.querySelector('[data-up-next-now]')! as HTMLElement

it('names the agent that is waiting on the person', () => {
  const view = upNextFixture('done')
  view.now = { kind: 'idle', agent: 'Claude Code' }

  render(<NowRow view={view} />)

  expect(row().textContent).toContain('idle')
  expect(row().textContent).toContain('Claude Code · waiting for you')
})

it('says only what it knows when the host cannot name the agent', () => {
  const view = upNextFixture('done')
  view.now = { kind: 'idle' }

  render(<NowRow view={view} />)

  expect(row().textContent).toContain('waiting for you')
  expect(row().textContent).not.toContain('·')
})

it('does not hand the person a turn while the run waits on someone else or recovers', () => {
  for (const scenario of ['waiting', 'recovering', 'failed']) {
    const view = upNextFixture(scenario)
    view.now = { kind: 'idle', agent: 'Claude Code' }

    render(<NowRow view={view} />)

    expect(row().textContent).toContain('Claude Code')
    expect(row().textContent).not.toContain('waiting for you')
    cleanup()
  }
})
