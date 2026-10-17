// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalWorkflowFollowUp } from './LocalWorkflowFollowUp'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values?.[key] ?? '')
}))
afterEach(cleanup)

describe('workflow follow-up composer', () => {
  it('keeps the single-model reply and an explicit repeat workflow action in one composer', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const onNewTurn = vi.fn()
    render(
      <LocalWorkflowFollowUp
        label="Claude"
        onSubmit={onSubmit}
        onNewTurn={onNewTurn}
        newTurnLabel="Run Council again"
      />
    )

    expect(screen.getByText('Ask Claude')).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Follow up with Claude' }), {
      target: { value: 'What evidence supports the ranking?' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send follow-up' }))
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith('What evidence supports the ranking?')
    )
    expect(onNewTurn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Run Council again' }))
    expect(onNewTurn).toHaveBeenCalledTimes(1)
  })
})
