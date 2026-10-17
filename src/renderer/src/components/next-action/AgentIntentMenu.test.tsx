// @vitest-environment happy-dom
/**
 * + Agent Review and + Agent Handoff: two intents, two menus, no shared item. Review stages
 * inspect the work and report; handoff stages give it to the next agent to act on. Both append
 * the same agent stage the engine already runs, carrying the template picked.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UpNextChainView } from './UpNextChain'
import { upNextFixture } from './up-next-fixture'
import type { UpNextController } from './use-up-next'
import { defaultNextStepInstructions } from '../../../../shared/next-step-draft'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))

afterEach(cleanup)

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

/** The menu's item titles, without the one-line hint under each. */
function openMenu(button: string, menu: string): { menu: HTMLElement; titles: string[] } {
  fireEvent.click(screen.getByRole('button', { name: button }))
  const element = screen.getByRole('menu', { name: menu })
  const titles = within(element)
    .getAllByRole('menuitem')
    .map((item) => item.querySelector('span span')?.textContent ?? '')
  return { menu: element, titles }
}

it('offers only inspection stages under + Agent Review', () => {
  render(<UpNextChainView controller={controller('busy')} />)
  expect(openMenu('+ Agent Review', 'Agent Review').titles).toEqual([
    'Review',
    'Adversarial Review',
    'Verify'
  ])
})

it('offers only next-stage work under + Agent Handoff, and no Judge', () => {
  render(<UpNextChainView controller={controller('busy')} />)
  const { titles } = openMenu('+ Agent Handoff', 'Agent Handoff')
  expect(titles).toEqual(['Implement', 'Improve', 'Research', 'Plan', 'Custom'])
  expect(titles).not.toContain('Judge')
  expect(titles).not.toContain('Review')
  expect(titles).not.toContain('Verify')
})

it('adds the picked review stage in one click, as the ordinary agent stage', () => {
  const c = controller('busy')
  render(<UpNextChainView controller={c} />)
  const { menu } = openMenu('+ Agent Review', 'Agent Review')
  fireEvent.click(within(menu).getByRole('menuitem', { name: /^Verify/ }))
  expect(c.append).toHaveBeenCalledWith({
    kind: 'agent',
    template: 'verify',
    shape: 'solo',
    n: 1,
    instruction: defaultNextStepInstructions('verify')
  })
})

it('adds the picked handoff stage in one click; Custom starts from a real instruction', () => {
  const c = controller('busy')
  render(<UpNextChainView controller={c} />)
  let { menu } = openMenu('+ Agent Handoff', 'Agent Handoff')
  fireEvent.click(within(menu).getByRole('menuitem', { name: /^Improve/ }))
  expect(c.append).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: 'agent', template: 'improve' })
  )
  ;({ menu } = openMenu('+ Agent Handoff', 'Agent Handoff'))
  fireEvent.click(within(menu).getByRole('menuitem', { name: /^Custom/ }))
  expect(c.append).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: 'agent',
      template: 'custom',
      instruction: defaultNextStepInstructions('implement')
    })
  )
})

it('marks each stage card with its intent: REVIEW inspects, HANDOFF acts', () => {
  render(<UpNextChainView controller={controller('chain')} />)
  const intentOf = (id: string): [string | null, string] => {
    const row = document.querySelector<HTMLElement>(`[data-up-next-block="${id}"]`)!
    return [row.getAttribute('data-intent'), row.textContent ?? '']
  }
  const [improve, improveText] = intentOf('improve')
  const [review, reviewText] = intentOf('review')
  const [verify] = intentOf('verify')
  expect([improve, review, verify]).toEqual(['handoff', 'review', 'review'])
  expect(improveText).toContain('Handoff')
  expect(reviewText).toContain('Review')
  // The two intents are drawn in different colours on the rail.
  const border = (id: string): string =>
    document.querySelector(`[data-up-next-block="${id}"]`)!.className
  expect(border('review')).toContain('border-l-ai-action-accent')
  expect(border('improve')).toContain('border-l-status-info')
})

it('keeps both agent intents available beside a legacy finish preference', () => {
  render(<UpNextChainView controller={controller('done')} />)
  for (const name of ['+ Agent Review', '+ Agent Handoff']) {
    const button = screen.getByRole('button', { name })
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.title).toBe('')
  }
})
