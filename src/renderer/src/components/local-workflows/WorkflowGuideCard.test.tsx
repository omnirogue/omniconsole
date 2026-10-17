// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowGuideCard } from './WorkflowGuideCard'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string) => english
}))

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const what = /Looks for real problems in your code or documents/

describe('WorkflowGuideCard', () => {
  it('opens the first time a person meets a workflow, and is a click away after that', () => {
    render(<WorkflowGuideCard kind="discover" />)
    expect(screen.getByText(what)).toBeVisible()
    expect(
      screen.getByText('A full run on a large codebase took about 3 hours in our tests.')
    ).toBeVisible()
    cleanup()
    render(<WorkflowGuideCard kind="discover" />)
    expect(screen.queryByText(what)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
    expect(screen.getByText(what)).toBeVisible()
  })

  it('remembers each workflow on its own', () => {
    render(<WorkflowGuideCard kind="discover" />)
    cleanup()
    render(<WorkflowGuideCard kind="council" />)
    expect(screen.getByText(/Several AIs answer your question separately/)).toBeVisible()
  })

  it("opens a new workflow's own guide when a setup changes kind in place", () => {
    const { rerender } = render(<WorkflowGuideCard kind="discover" />)
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
    rerender(<WorkflowGuideCard kind="council" />)
    expect(screen.getByText(/Several AIs answer your question separately/)).toBeVisible()
  })

  it('still shows the guide when the browser keeps nothing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<WorkflowGuideCard kind="improve" />)
    expect(screen.getByText(/Makes a piece of work better/)).toBeVisible()
    expect(screen.queryByText('How long it takes')).not.toBeInTheDocument()
  })
})
