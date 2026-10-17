// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FleetFallbackFields } from './FleetFallbackFields'
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))
const primary = 'google/gemini-pro'
const grok = 'x-ai/grok-code'
const kimi = 'moonshotai/kimi-code'
const choices = [primary, grok, kimi].map((id) => ({ id, label: id }))
afterEach(cleanup)
function Editor() {
  const [candidates, setCandidates] = useState<string[]>()
  return (
    <FleetFallbackFields
      primary={primary}
      candidates={candidates}
      choices={choices}
      problem={null}
      canEnable
      onChange={setCandidates}
    />
  )
}

describe('explicit fleet fallback choices', () => {
  it('starts fixed-only and only adds/reorders routes on explicit operator choices', () => {
    render(<Editor />)
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: `Add ${grok}` }))
    fireEvent.click(screen.getByRole('button', { name: `Add ${kimi}` }))
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `1. ${primary}`,
      `2. ${grok}`,
      `3. ${kimi}`
    ])
    fireEvent.click(screen.getByRole('button', { name: `Move ${kimi} earlier` }))
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `1. ${primary}`,
      `2. ${kimi}`,
      `3. ${grok}`
    ])
    fireEvent.click(screen.getByRole('button', { name: `Remove ${kimi} from fallback list` }))
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `1. ${primary}`,
      `2. ${grok}`
    ])
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('preserves unavailable saved models and order when host evidence disappears', () => {
    const onChange = vi.fn()
    const rendered = render(
      <FleetFallbackFields
        primary={primary}
        candidates={[primary, kimi, grok]}
        choices={choices}
        problem={null}
        canEnable
        onChange={onChange}
      />
    )
    rendered.rerender(
      <FleetFallbackFields
        primary={primary}
        candidates={[primary, kimi, grok]}
        choices={[]}
        problem="Choose an available host or remove this list."
        canEnable={false}
        onChange={onChange}
      />
    )
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `1. ${primary}`,
      `2. ${kimi}`,
      `3. ${grok}`
    ])
    expect(screen.getByRole('alert').textContent).toContain('Choose an available host')
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('requires explicit repair after the selected primary model changes', () => {
    const onChange = vi.fn()
    render(
      <FleetFallbackFields
        primary={kimi}
        candidates={[primary, grok, kimi]}
        choices={choices}
        problem="The selected model must be first."
        canEnable
        onChange={onChange}
      />
    )
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use selected model first' }))
    expect(onChange).toHaveBeenCalledWith([kimi, primary, grok])
  })

  it('cannot opt in without verified choices and an explicit model', () => {
    render(
      <FleetFallbackFields
        primary={null}
        candidates={undefined}
        choices={[]}
        problem="Choose a verified model."
        canEnable={false}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(true)
  })
})

it('refuses a seventeenth candidate without truncating or changing the saved order', () => {
  const candidates = Array.from({ length: 16 }, (_, index) => `x-ai/reviewed-${index}`)
  const onChange = vi.fn()
  render(
    <FleetFallbackFields
      primary={candidates[0]!}
      candidates={candidates}
      choices={[{ id: kimi, label: kimi }]}
      problem={null}
      canEnable
      onChange={onChange}
    />
  )
  const add = screen.getByRole('button', { name: `Add ${kimi}` })
  expect(add.hasAttribute('disabled')).toBe(true)
  fireEvent.click(add)
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(
    candidates.map((candidate, index) => `${index + 1}. ${candidate}`)
  )
})
