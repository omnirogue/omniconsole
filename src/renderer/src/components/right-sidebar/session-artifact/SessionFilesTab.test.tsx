// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace('{{count}}', String(values?.count ?? ''))
}))
vi.mock('./SessionFilePreview', () => ({
  SessionFilePreview: ({ item }: { item: { path: string } }) => (
    <p data-testid="preview">{item.path}</p>
  )
}))
vi.mock('@/components/next-action/SessionFilesAndLinksCard', () => ({
  SessionFilesAndLinksCard: ({ card }: { card: { key: string } }) => <li>{card.key}</li>
}))

import { SessionFilesTab, type SessionPanelFile } from './SessionFilesTab'

const file = (path: string): SessionPanelFile => ({
  kind: 'file',
  key: `file:${path}`,
  at: 1,
  path,
  context: {} as never,
  name: path.split('/').at(-1)!,
  location: 'docs'
})
const outputs = { cards: [], liveness: new Map(), target: null }

function tab(pickedKey: string | null = null, revision = 0) {
  return (
    <SessionFilesTab
      files={[file('/w/docs/plan.md'), file('/w/docs/report.html')]}
      links={[{ type: 'pull-request', key: 'pr:1' } as never]}
      outputs={outputs}
      worktreeId="w"
      hostId={null}
      visible
      pickedKey={pickedKey}
      selectionRevision={revision}
    />
  )
}

afterEach(() => cleanup())

describe('SessionFilesTab', () => {
  it('lists the files, previews one in place, and goes back to the list', () => {
    render(tab())
    expect(screen.getByText('plan.md')).toBeTruthy()
    expect(screen.getByText('pr:1')).toBeTruthy()
    fireEvent.click(screen.getByText('report.html'))
    expect(screen.getByTestId('preview').textContent).toBe('/w/docs/report.html')
    fireEvent.click(screen.getByRole('button', { name: 'All files (2)' }))
    expect(screen.queryByTestId('preview')).toBeNull()
  })

  it('opens straight into a file the person clicked in the conversation', () => {
    const { rerender } = render(tab())
    rerender(tab('file:/w/docs/plan.md', 1))
    expect(screen.getByTestId('preview').textContent).toBe('/w/docs/plan.md')
  })
})
