// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UpNextChainView } from './UpNextChain'
import { agentFixture, upNextFixture } from './up-next-fixture'
import { blockSecondary, clockLabel } from './up-next-labels'
import { useSessionFolders } from '@/store/session-folders'
import { emptySessionFolderMetadata, SAVED_SESSIONS_FOLDER_ID } from '@/lib/session-folders'
import type { UpNextController } from './use-up-next'
import { UP_NEXT_MAX_SEATS_PER_STAGE } from '../../../../shared/up-next-types'

afterEach(() => {
  cleanup()
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata() })
})
function controller(scenario: string): UpNextController {
  const write = () => vi.fn(async () => true)
  return {
    view: upNextFixture(scenario),
    disabled: false,
    error: null,
    setWhenFinished: write(),
    append: write(),
    update: write(),
    reorder: write(),
    remove: write(),
    commit: write(),
    discardDrafts: write(),
    configureAfter: write()
  }
}
function row(id: string) {
  return document.querySelector(`[data-up-next-block="${id}"]`)! as HTMLElement
}
function open(id: string) {
  fireEvent.click(document.querySelector(`[data-up-next-row="${id}"]`)!)
}

it.each([
  ['custom-folder-uuid', 'Acceptance'],
  [SAVED_SESSIONS_FOLDER_ID, 'Saved Sessions'],
  ['missing-uuid', 'a folder']
])('resolves saved folder %s without leaking ids', (folderId, name) => {
  useSessionFolders.setState({
    metadata: {
      ...emptySessionFolderMetadata(),
      folders: [{ id: 'custom-folder-uuid', name: 'Acceptance' }]
    }
  })
  const c = controller('done')
  const done = c.view!.blocks.find((b) => b.kind === 'done')!
  if (done.kind !== 'done') {
    throw new Error('missing done')
  }
  done.finish = 'save'
  done.folderId = folderId
  render(<UpNextChainView controller={c} />)
  expect(row('done')).toBeNull()
  expect(screen.getByRole('button', { name: 'Save session' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(document.querySelector('[data-next-action-when-finished]')!.textContent).not.toContain(
    'uuid'
  )
  expect(
    blockSecondary(done, c.view!, (id) => (id === 'custom-folder-uuid' ? 'Acceptance' : undefined))
  ).toBe(`then save to ${name}`)
})

it('shows elapsed duration and toggles the completed strip glyph', () => {
  render(<UpNextChainView controller={controller('running')} />)
  expect(row('review').textContent).toContain('14m')
  const strip = screen.getByRole('button', { name: '✓ 1 done · 9m ▸' })
  fireEvent.click(strip)
  expect(strip.textContent).toBe('✓ 1 done · 9m ▾')
  expect(row('first')).toBeTruthy()
})

it('shows one finished header', () => {
  render(<UpNextChainView controller={controller('closed')} />)
  expect(screen.getAllByText(`✓ Done · closed ${clockLabel(1)}`)).toHaveLength(1)
})

it('restricts prompt queue arrows to adjacent queued prompt queue entries', () => {
  const c = controller('chain')
  const prompt = c.view!.blocks.find((b) => b.kind === 'prompt')!
  c.view!.blocks = [
    { ...prompt, id: 'pq:first' },
    { ...prompt, id: 'pq:last' },
    agentFixture('stage')
  ]
  render(<UpNextChainView controller={c} />)
  expect(
    within(row('pq:first')).getByRole('button', { name: 'Move up' }).hasAttribute('disabled')
  ).toBe(true)
  expect(
    within(row('pq:first')).getByRole('button', { name: 'Move down' }).hasAttribute('disabled')
  ).toBe(false)
  expect(
    within(row('pq:last')).getByRole('button', { name: 'Move down' }).hasAttribute('disabled')
  ).toBe(true)
})

it('paints lifecycle tags and review rail separately from the person icon', () => {
  const c = controller('chain')
  const { rerender } = render(<UpNextChainView controller={c} />)
  expect(within(row('improve')).queryByText('queued')).toBeNull()
  expect(row('person').textContent).toContain('👤')
  // Each class of stop has its own tag; only an open request is amber and says "needs you".
  rerender(<UpNextChainView controller={controller('failed')} />)
  expect(within(row('verify')).getByText('failed').className).toContain('border-destructive')
  expect(row('verify').textContent).not.toContain('needs you')
  expect(row('verify').textContent).not.toContain('🔒')
  rerender(<UpNextChainView controller={controller('needs-you')} />)
  expect(within(row('verify')).getByText('needs you').className).toContain('border-status-warning')
  rerender(<UpNextChainView controller={controller('recovering')} />)
  expect(within(row('verify')).getByText('recovering').className).toContain('border-status-info')
  expect(within(row('improve')).getByText('waiting')).toBeTruthy()
  const review = controller('review')
  const person = review.view!.blocks[0]!
  if (person.kind !== 'person') {
    throw new Error('missing person')
  }
  person.waiting = { replied: 1, total: 2, sinceMs: 180000 }
  rerender(<UpNextChainView controller={review} />)
  expect(within(row('person')).getByText('👥')).toBeTruthy()
  expect(within(row('person')).getByText('↩')).toBeTruthy()
  expect(within(row('person')).getByText('⏸ 1 of 2 replied · 3m')).toBeTruthy()
  rerender(<UpNextChainView controller={controller('done')} />)
  expect(row('done')).toBeNull()
  rerender(<UpNextChainView controller={controller('running')} />)
  expect(within(row('review')).getByText('🔒')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /✓ 1 done/ }))
  expect(within(row('first')).queryByText('done')).toBeNull()
})

it.each(['all', 'any'] as const)('uses count-aware review wording for %s', (waitRule) => {
  const view = upNextFixture('review')
  const person = view.blocks[0]!
  if (person.kind !== 'person') {
    throw new Error('missing person')
  }
  person.waitRule = waitRule
  for (const count of [0, 1, 2, 3]) {
    person.people = Array.from({ length: count }, (_, i) => ({
      id: String(i),
      initials: 'S',
      name: i ? `Person ${i}` : 'Sal'
    }))
    if (!count) {
      expect(blockSecondary(person, view)).toBe('pick one or more people')
      person.relationship = 'handoff'
      expect(blockSecondary(person, view)).toBe('pick a person')
      person.relationship = 'review'
      continue
    }
    const clause =
      count === 1
        ? 'Sal replies'
        : waitRule === 'any'
          ? 'anyone replies'
          : count === 2
            ? 'both reply'
            : 'all 3 reply'
    expect(blockSecondary(person, view)).toBe(`continues when ${clause} → 2 · Improve`)
  }
})

it('explains stage and review prompt delivery when expanded', () => {
  const { rerender } = render(<UpNextChainView controller={controller('chain')} />)
  open('prompt')
  expect(screen.getByText('Runs when 2 · Review runs. Nothing to schedule.')).toBeTruthy()
  const named = controller('review')
  rerender(<UpNextChainView controller={named} />)
  open('resume')
  expect(
    screen.getByText(
      'Delivered to claude when it resumes after Sal, Iris reply. Nothing to schedule.'
    )
  ).toBeTruthy()
  const unnamed = controller('review')
  unnamed.view!.now = { kind: 'idle' }
  // The row stays open across the rerender: opening it again would fold it shut.
  rerender(<UpNextChainView controller={unnamed} />)
  expect(
    screen.getByText(
      'Delivered to the current agent when it resumes after Sal, Iris reply. Nothing to schedule.'
    )
  ).toBeTruthy()
})

it('keeps the done strip folded when clicking current work or a queued notation segment', () => {
  const c = controller('running')
  c.view!.now = { kind: 'current-work', agent: 'claude', label: 'Implement' }
  c.view!.blocks = c.view!.blocks.filter((b) => b.state !== 'running')
  render(<UpNextChainView controller={c} />)
  const current = screen.getByTitle('Current work')
  expect(current.tagName).toBe('SPAN')
  fireEvent.click(current)
  expect(document.querySelector('[data-up-next-block="first"]')).toBeNull()
  fireEvent.click(screen.getByTitle('Improve'))
  expect(document.querySelector('[data-up-next-block="first"]')).toBeNull()
  fireEvent.click(screen.getByTitle('Improve · 9m'))
  expect(row('first')).toBeTruthy()
})

it('flashes a retargeted prompt once and clears the notice on opening it', async () => {
  const c = controller('chain')
  const { rerender } = render(<UpNextChainView controller={c} />)
  await act(async () => {
    fireEvent.click(within(row('prompt')).getByRole('button', { name: 'Move up' }))
  })
  const blocks = c.view!.blocks
  const i = blocks.findIndex((b) => b.id === 'prompt')
  ;[blocks[i - 1], blocks[i]] = [blocks[i]!, blocks[i - 1]!]
  rerender(<UpNextChainView controller={{ ...c, view: { ...c.view!, blocks: [...blocks] } }} />)
  expect(row('prompt').className).toContain('motion-safe:animate-pulse')
  expect(row('prompt').className).toContain('[animation-iteration-count:1]')
  open('prompt')
  expect(row('prompt').className).not.toContain('animate-pulse')
})

it.each(['council', 'best-of', 'parallel', 'custom'] as const)(
  'offers a bounded stepper only for variable shape %s',
  (shape) => {
    const c = controller('chain')
    c.view!.blocks = [agentFixture('stage', { shape, n: 2 })]
    const { rerender } = render(<UpNextChainView controller={c} />)
    open('stage')
    if (shape === 'council' || shape === 'best-of') {
      expect(screen.queryByRole('group', { name: 'Number of agents' })).toBeNull()
      return
    }
    const fewer = screen.getByRole('button', { name: 'Fewer agents' })
    expect(fewer.hasAttribute('disabled')).toBe(true)
    fireEvent.click(fewer)
    expect(c.update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'More agents' }))
    expect(c.update).toHaveBeenLastCalledWith('stage', { kind: 'agent', n: 3 })
    c.view!.blocks = [agentFixture('stage', { shape, n: UP_NEXT_MAX_SEATS_PER_STAGE })]
    rerender(<UpNextChainView controller={{ ...c }} />)
    expect(screen.getByRole('button', { name: 'More agents' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Fewer agents' }))
    expect(c.update).toHaveBeenLastCalledWith('stage', {
      kind: 'agent',
      n: UP_NEXT_MAX_SEATS_PER_STAGE - 1
    })
  }
)

it.each([
  [10_800_000, '3h'],
  [3_660_000, '1h 1m'],
  [3_599_000, '1h'],
  [1_200_000, '20m']
])('rolls a %sms span over into hours (S-22)', (sinceMs, span) => {
  const c = controller('review')
  const person = c.view!.blocks[0]!
  if (person.kind !== 'person') {
    throw new Error('missing person')
  }
  person.waiting = { replied: 1, total: 2, sinceMs }
  render(<UpNextChainView controller={c} />)
  expect(within(row('person')).getByText(`⏸ 1 of 2 replied · ${span}`)).toBeTruthy()
})

it('shows a finish setting without Finish now alongside completed work', () => {
  const c = controller('done')
  c.view!.blocks = [
    agentFixture('first', {
      state: 'done',
      locked: true,
      progress: { durationMs: 120000 }
    }),
    agentFixture('second', {
      state: 'done',
      locked: true,
      progress: { durationMs: 60000 }
    }),
    ...c.view!.blocks.filter((block) => block.kind === 'done')
  ]
  render(<UpNextChainView controller={c} />)
  expect(screen.getByRole('button', { name: '✓ 2 done · 3m ▸' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Finish now' })).toBeNull()
})

it('does not count a legacy finish preference as a queue draft', () => {
  const c = controller('done')
  render(<UpNextChainView controller={c} />)
  expect(screen.getByRole('button', { name: 'Up to date' })).toBeTruthy()
})
