// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, text: string) => text }))
const { readHandoffVersionText } = vi.hoisted(() => ({ readHandoffVersionText: vi.fn() }))
vi.mock('./handoff-client', () => ({ readHandoffVersionText }))

import { HandoffFilePreview, previewKind } from './HandoffFilePreview'

afterEach(() => {
  cleanup()
  readHandoffVersionText.mockReset()
})

const file = {
  id: 'hfv_662184a200a44ebf9956',
  path: 'uploads/handoff-test.md',
  name: 'handoff-test.md',
  sha256: 'c4efb59a0f4777f54808d3dfdf8923f769f1c7525f9aaf0b083e34f64a74b480',
  size: 161,
  version: 1,
  parent_version_id: null,
  current: true,
  available: true
}

it('classifies files by what can be shown inline', () => {
  expect(previewKind('handoff-test.md')).toBe('markdown')
  expect(previewKind('notes.txt')).toBe('text')
  expect(previewKind('build.zip')).toBeNull()
})

it('renders a markdown handoff file as formatted markdown, not raw text', async () => {
  const body = '# Handoff test\n\nPlease reply **Received**.\n\n- one\n- two\n'
  readHandoffVersionText.mockResolvedValue(body)
  render(<HandoffFilePreview threadId="hth_28bd24c083fd4b49aaac" file={file} />)
  expect(await screen.findByRole('heading', { name: 'Handoff test' })).toBeInTheDocument()
  expect(screen.getByText('Received').tagName).toBe('STRONG')
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(screen.queryByText('# Handoff test')).not.toBeInTheDocument()
  expect(readHandoffVersionText).toHaveBeenCalledWith('hth_28bd24c083fd4b49aaac', file)
})

it('shows the refusal when the file cannot be read', async () => {
  readHandoffVersionText.mockRejectedValue(new Error('version revoked'))
  render(<HandoffFilePreview threadId="hth_x" file={file} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('version revoked')
})

it('does not fetch binaries or oversized files', () => {
  render(<HandoffFilePreview threadId="hth_x" file={{ ...file, name: 'build.zip' }} />)
  expect(screen.getByText(/No inline preview/)).toBeInTheDocument()
  render(<HandoffFilePreview threadId="hth_x" file={{ ...file, size: 10_000_000 }} />)
  expect(screen.getByText(/Too large/)).toBeInTheDocument()
  expect(readHandoffVersionText).not.toHaveBeenCalled()
})
