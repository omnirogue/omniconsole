// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { NextStepRecipientList } from './NextStepRecipientList'
import { NextStepPeopleCard } from './NextStepPersonCard'
import { NextStepAgentCard } from './NextStepAgentCard'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RecipientAvatar, recipientPhoto } from './recipient-avatar'
import { emptyNextStepDraft, type NextStepRecipient } from '../../../../shared/next-step-draft'

vi.mock('@/components/build-review/BuildReviewAgentFields', () => ({
  BuildReviewModelEffortFields: () => null,
  CatalogModelEffortFields: () => null
}))
vi.mock('@/components/agent/AgentAccountSelect', () => ({ AgentAccountSelect: () => null }))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
const me = vi.fn()
const people = [
  { id: 'employee-7', name: 'Taylor Rivera' },
  { id: 'employee-9', name: 'Jordan Lee' }
]
const chart = [
  { id: 'chart-7', employee_id: 'employee-7', photo_url: 'https://example.test/taylor.jpg' }
]
const agents = getAgentCatalog().filter((entry) => ['claude', 'codex'].includes(entry.id))
const toggle = vi.fn()
function Picker({ oneAgentOnly = false }: { oneAgentOnly?: boolean }) {
  const [selected, setSelected] = useState<NextStepRecipient[]>([])
  return (
    <NextStepRecipientList
      agents={{ phase: 'ready', value: agents }}
      people={{ phase: 'ready', value: people }}
      orgPeople={chart}
      selected={selected}
      oneAgentOnly={oneAgentOnly}
      onRetry={() => {}}
      onTogglePerson={(person, ensure) => {
        toggle(person, ensure)
        setSelected((current) =>
          current.some((entry) => entry.kind === 'person' && entry.id === person.id)
            ? ensure
              ? current
              : current.filter((entry) => entry.kind !== 'person' || entry.id !== person.id)
            : [...current, { ...person, kind: 'person', key: person.id }]
        )
      }}
      onToggleAgent={(agent) =>
        setSelected((current) =>
          current.some((entry) => entry.kind === 'agent' && entry.agent === agent.id)
            ? current.filter((entry) => entry.kind !== 'agent' || entry.agent !== agent.id)
            : [
                ...current,
                {
                  kind: 'agent',
                  key: agent.id,
                  agent: agent.id,
                  presetId: 'implement',
                  instructions: '',
                  rounds: 1
                }
              ]
        )
      }
    />
  )
}
beforeEach(() => {
  toggle.mockClear()
  me.mockReset().mockResolvedValue({
    ok: true,
    data: { ok: true, user: { employee_id: 'employee-7', name: 'Wrong Name' } }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { consoleCompanies: { me } } })
})
afterEach(cleanup)
describe('recipient front door', () => {
  it('binds distinct identity styles to semantic colors rather than neutral or status ramps', () => {
    const recipientStyles = readFileSync(
      join(process.cwd(), 'src/renderer/src/assets/main.css'),
      'utf8'
    )
    expect(recipientStyles).toMatch(
      /\.recipient-identity-human,\s*\n\.recipient-identity-human:hover,\s*\n\.recipient-identity-human:focus-visible\s*\{\s*background-color: var\(--recipient-human\);\s*color: var\(--recipient-human-foreground\);/
    )
    expect(recipientStyles).toMatch(
      /\.recipient-identity-ai,\s*\n\.recipient-identity-ai:hover,\s*\n\.recipient-identity-ai:focus-visible\s*\{\s*background-color: color-mix\(in srgb, var\(--ai-action-accent\) 25%, var\(--background\)\);\s*color: var\(--foreground\);/
    )
  })
  it("restates the identity tint on :hover and :focus-visible so the shadcn outline button's own hover:/focus-visible: utilities (same specificity, same properties) cannot flip a category button back to the neutral accent ramp", () => {
    const recipientStyles = readFileSync(
      join(process.cwd(), 'src/renderer/src/assets/main.css'),
      'utf8'
    )
    expect(recipientStyles).toMatch(/\.recipient-identity-human:hover\b/)
    expect(recipientStyles).toMatch(/\.recipient-identity-human:focus-visible\b/)
    expect(recipientStyles).toMatch(/\.recipient-identity-ai:hover\b/)
    expect(recipientStyles).toMatch(/\.recipient-identity-ai:focus-visible\b/)
  })
  it('colors all three category buttons consistently before and after selection', async () => {
    render(<Picker />)
    await waitFor(() => expect(toggle).toHaveBeenCalled())
    for (const choice of ['me', 'people', 'ai']) {
      fireEvent.click(screen.getByTestId(`recipient-category-${choice}`))
      for (const category of ['me', 'people', 'ai']) {
        const button = screen.getByTestId(`recipient-category-${category}`)
        expect(
          button.classList.contains(`recipient-identity-${category === 'ai' ? 'ai' : 'human'}`)
        ).toBe(true)
        expect(
          button.classList.contains(`recipient-identity-${category === 'ai' ? 'human' : 'ai'}`)
        ).toBe(false)
      }
    }
  })
  it('retains human color on photo failure, initials and unnamed icon fallback', () => {
    const { rerender } = render(<RecipientAvatar name="Taylor Rivera" photoUrl="broken.jpg" />)
    fireEvent.error(screen.getByTestId('recipient-human').querySelector('img')!)
    expect(screen.getByTestId('recipient-human').textContent).toBe('TR')
    expect(
      screen.getByTestId('recipient-human').classList.contains('recipient-identity-human')
    ).toBe(true)
    rerender(<RecipientAvatar />)
    expect(screen.getByTestId('recipient-human').querySelector('svg')).toBeTruthy()
    expect(
      screen.getByTestId('recipient-human').classList.contains('recipient-identity-human')
    ).toBe(true)
    rerender(<RecipientAvatar agent />)
    expect(screen.getByTestId('recipient-robot').classList.contains('recipient-identity-ai')).toBe(
      true
    )
    expect(screen.getByText('AI').classList.contains('sr-only')).toBe(true)
  })

  it('defaults to Me using only the signed-in employee mapping, without repeated toggles', async () => {
    render(<Picker />)
    await waitFor(() => expect(toggle).toHaveBeenCalledWith(people[0], true))
    expect(me).toHaveBeenCalledTimes(1)
    expect(screen.getByText('included')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(toggle).toHaveBeenCalledTimes(1)
  })
  it.each([null, 'not-in-roster'])(
    'disables Me with a reason for mapping %s and keeps other choices usable',
    async (employee_id) => {
      me.mockResolvedValue({ ok: true, data: { user: { employee_id, name: 'Taylor Rivera' } } })
      render(<Picker />)
      await screen.findByText(
        'Me is unavailable: your console profile has no matching employee in this roster.'
      )
      expect((screen.getByRole('button', { name: 'Me' }) as HTMLButtonElement).disabled).toBe(true)
      expect(toggle).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Someone else' }))
      expect(screen.getByRole('textbox')).toBeTruthy()
      expect(screen.getByRole('checkbox', { name: 'Jordan Lee' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'AI' }))
      expect(
        within(screen.getByRole('checkbox', { name: 'Claude' })).getByTestId('recipient-robot')
      ).toBeTruthy()
    }
  )
  it('reports a roster load failure as a roster error with a retry, never as "no matching employee"', async () => {
    const onRetry = vi.fn()
    function ErrorPicker() {
      const [selected, setSelected] = useState<NextStepRecipient[]>([])
      return (
        <NextStepRecipientList
          agents={{ phase: 'ready', value: agents }}
          people={{ phase: 'error', message: 'The roster service is unavailable.' }}
          orgPeople={chart}
          selected={selected}
          oneAgentOnly={false}
          onRetry={onRetry}
          onTogglePerson={(person, ensure) => {
            setSelected((current) =>
              current.some((entry) => entry.kind === 'person' && entry.id === person.id)
                ? ensure
                  ? current
                  : current.filter((entry) => entry.kind !== 'person' || entry.id !== person.id)
                : [...current, { ...person, kind: 'person', key: person.id }]
            )
          }}
          onToggleAgent={() => {}}
        />
      )
    }
    render(<ErrorPicker />)
    expect(
      await screen.findByText("Couldn't load your team: The roster service is unavailable.")
    ).toBeTruthy()
    expect(
      screen.queryByText(
        'Me is unavailable: your console profile has no matching employee in this roster.'
      )
    ).toBeNull()
    expect((screen.getByRole('button', { name: 'Me' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
  it('reports a failed profile read (e.g. an expired hub session) as a sign-in error with a retry, never as "no matching employee"', async () => {
    me.mockReset().mockResolvedValue({
      ok: false,
      error: { code: 'capability_unavailable', message: 'Hub session expired.' }
    })
    render(<Picker />)
    expect(
      await screen.findByText("Couldn't check your sign-in: Hub session expired.")
    ).toBeTruthy()
    expect(
      screen.queryByText(
        'Me is unavailable: your console profile has no matching employee in this roster.'
      )
    ).toBeNull()
    expect((screen.getByRole('button', { name: 'Me' }) as HTMLButtonElement).disabled).toBe(true)
    const callsBefore = me.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(me.mock.calls.length).toBeGreaterThan(callsBefore))
  })
  it('reports a valid-but-refused profile read ({ ok: false } payload) the same way, distinct from "no matching employee"', async () => {
    me.mockReset().mockResolvedValue({
      ok: true,
      data: { ok: false, reason: 'expired_session' }
    })
    render(<Picker />)
    expect(await screen.findByText("Couldn't check your sign-in: expired_session")).toBeTruthy()
    expect(
      screen.queryByText(
        'Me is unavailable: your console profile has no matching employee in this roster.'
      )
    ).toBeNull()
  })
  it('drops the unconfirmed Me default on leaving it, then preserves explicit picks across switches, showing joined photos and initials', async () => {
    render(<Picker />)
    await waitFor(() => expect(toggle).toHaveBeenCalled())
    // Why: Me auto-selected on mount but was never explicitly confirmed; leaving for
    // Someone else must drop it rather than silently riding along on another handoff.
    fireEvent.click(screen.getByRole('button', { name: 'Someone else' }))
    const self = screen.getByRole('checkbox', { name: 'Taylor Rivera' })
    expect(self.querySelector('img')?.getAttribute('src')).toBe(chart[0].photo_url)
    expect(self.getAttribute('aria-checked')).toBe('false')
    const other = screen.getByRole('checkbox', { name: 'Jordan Lee' })
    expect(within(other).getByTestId('recipient-human').textContent).toBe('JL')
    expect(
      within(other).getByTestId('recipient-human').classList.contains('recipient-identity-human')
    ).toBe(true)
    fireEvent.click(other)
    fireEvent.click(screen.getByRole('button', { name: 'AI' }))
    expect(
      within(screen.getByRole('checkbox', { name: 'Claude' }))
        .getByTestId('recipient-robot')
        .classList.contains('recipient-identity-ai')
    ).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Someone else' }))
    // Why: with an explicit pick (Jordan Lee) plus agents already selected, switching
    // views must not touch any of them.
    expect(screen.getByRole('checkbox', { name: 'Jordan Lee' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(screen.queryByRole('checkbox', { name: 'Taylor Rivera' })?.getAttribute('aria-checked')).toBe(
      'false'
    )
    fireEvent.click(screen.getByRole('button', { name: 'AI' }))
    expect(screen.getByRole('checkbox', { name: 'Claude' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(screen.getByRole('checkbox', { name: 'Codex' }).getAttribute('aria-checked')).toBe(
      'true'
    )
  })
  it('an explicit click on Me is a shortcut to "include me" (ensures selection, never removes) and, by touching the latch, keeps you selected across later view switches', async () => {
    render(<Picker />)
    await waitFor(() => expect(toggle).toHaveBeenCalled())
    expect(screen.getByText('included')).toBeTruthy()
    // Clicking Me while already selected (from the default) is a no-op on selection,
    // but it IS an interaction: the latch is touched, so a later transition to
    // Someone else/AI never re-evaluates (and so never drops) this pick.
    fireEvent.click(screen.getByRole('button', { name: 'Me' }))
    expect(screen.getByText('included')).toBeTruthy()
    expect(toggle).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Someone else' }))
    expect(
      screen.getByRole('checkbox', { name: 'Taylor Rivera' }).getAttribute('aria-checked')
    ).toBe('true')
  })
  it('removing yourself is done from the roster row, like removing anyone else, not from the Me button', async () => {
    render(<Picker />)
    await waitFor(() => expect(toggle).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Someone else' }))
    // Why: the first transition away from Me drops the still-provisional default.
    const self = screen.getByRole('checkbox', { name: 'Taylor Rivera' })
    expect(self.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(self)
    expect(self.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(self)
    expect(self.getAttribute('aria-checked')).toBe('false')
  })
  it('ticking yourself in the roster after dropping the provisional Me is a real, confirmed pick that survives switching to AI', async () => {
    render(<Picker />)
    await waitFor(() => expect(toggle).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Someone else' }))
    const self = screen.getByRole('checkbox', { name: 'Taylor Rivera' })
    expect(self.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(self)
    expect(self.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'AI' }))
    fireEvent.click(screen.getByRole('button', { name: 'Someone else' }))
    expect(
      screen.getByRole('checkbox', { name: 'Taylor Rivera' }).getAttribute('aria-checked')
    ).toBe('true')
  })

  it('keeps the card/thread agent lock', () => {
    render(<Picker oneAgentOnly />)
    fireEvent.click(screen.getByRole('button', { name: 'AI' }))
    expect(
      within(screen.getByRole('checkbox', { name: 'Claude' }))
        .getByTestId('recipient-robot')
        .classList.contains('recipient-identity-ai')
    ).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude' }))
    expect((screen.getByRole('checkbox', { name: 'Codex' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })
  it('uses matching photos and human/robot identity in selected cards', () => {
    const person = { ...people[0], kind: 'person' as const, key: 'person' }
    render(
      <NextStepPeopleCard
        people={[person]}
        draft={emptyNextStepDraft()}
        included=""
        taskTitle={null}
        onChange={() => {}}
        photoFor={(entry) => recipientPhoto(entry, chart)}
      />
    )
    expect(screen.getByTestId('recipient-human').querySelector('img')?.getAttribute('src')).toBe(
      chart[0].photo_url
    )
    render(
      <NextStepAgentCard
        recipient={{
          kind: 'agent',
          key: 'agent',
          agent: 'claude',
          presetId: null,
          instructions: '',
          rounds: 1
        }}
        worktreeSelector={null}
        roundsAllowed={false}
        problem={false}
        onChange={() => {}}
      />
    )
    expect(screen.getByTestId('recipient-robot').querySelector('svg')).toBeTruthy()
    expect(screen.getByTestId('recipient-robot').classList.contains('recipient-identity-ai')).toBe(
      true
    )
    expect(
      screen.getByTestId('recipient-human').classList.contains('recipient-identity-human')
    ).toBe(true)
  })
  it('joins by email when IDs differ and falls back when no photo exists', () => {
    expect(
      recipientPhoto({ ...people[0], email: 'TAYLOR@example.test' }, [
        { id: 'different', email: 'taylor@example.test', photo_url: 'photo' }
      ])
    ).toBe('photo')
    expect(recipientPhoto(people[1], chart)).toBeUndefined()
  })
})
