// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionFollowUpDeliverables } from '../../../../shared/session-follow-up-rule'
import { NextStepWorkFiles, type NextStepTranscriptOption } from './NextStepWorkFiles'

vi.mock('@/components/quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({ files: [], loading: false, loadError: null })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

afterEach(cleanup)

function Panel({ option }: { option?: Partial<NextStepTranscriptOption> }) {
  const [included, setIncluded] = useState(false)
  const [value, setValue] = useState<SessionFollowUpDeliverables | null>({
    kind: 'files',
    paths: []
  })
  return (
    <NextStepWorkFiles
      worktreeId="folder:f1"
      workspacePath="/w"
      deliverables={value}
      defaults={null}
      transcript={{ included, onToggle: setIncluded, ...option }}
      onChange={setValue}
    />
  )
}

it('offers the transcript with its consent sentence, unticked', () => {
  render(<Panel />)
  const checkbox = screen.getByRole('checkbox', {
    name: 'Include the session transcript (redacted)'
  })
  expect(checkbox.getAttribute('data-state')).toBe('unchecked')
  expect(
    screen.getByText(
      'The transcript can include file contents and command output from this session. It is redacted for secrets and sent as a file the recipient can open.'
    )
  ).toBeTruthy()
})

it('records the consent when a person ticks it', () => {
  const onToggle = vi.fn()
  render(<Panel option={{ onToggle }} />)
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Include the session transcript (redacted)' })
  )
  expect(onToggle).toHaveBeenCalledWith(true)
})

it('shows the size and message count only once the transcript is included', () => {
  const preview = { messageCount: 12, sizeBytes: 4096 }
  const { rerender } = render(
    <NextStepWorkFiles
      worktreeId="folder:f1"
      workspacePath="/w"
      deliverables={{ kind: 'files', paths: [] }}
      defaults={null}
      transcript={{ included: false, onToggle: () => {}, preview }}
      onChange={() => {}}
    />
  )
  expect(screen.queryByText(/12 messages/)).toBeNull()
  rerender(
    <NextStepWorkFiles
      worktreeId="folder:f1"
      workspacePath="/w"
      deliverables={{ kind: 'files', paths: [] }}
      defaults={null}
      transcript={{ included: true, onToggle: () => {}, preview }}
      onChange={() => {}}
    />
  )
  expect(screen.getByText('12 messages, 4.0 KiB — sent as one file.')).toBeTruthy()
})

it("shows the redactor's refusal in place of a size", () => {
  render(
    <NextStepWorkFiles
      worktreeId="folder:f1"
      workspacePath="/w"
      deliverables={{ kind: 'files', paths: [] }}
      defaults={null}
      transcript={{
        included: true,
        onToggle: () => {},
        preview: { messageCount: 12, sizeBytes: 4096 },
        error:
          'This transcript contains 1 value the redactor treats as a secret, so it was not sent (transcript_contains_protected_data).'
      }}
      onChange={() => {}}
    />
  )
  expect(screen.getByRole('alert').textContent).toContain('transcript_contains_protected_data')
  expect(screen.queryByText(/12 messages/)).toBeNull()
})

it('says so while the transcript is still being prepared', () => {
  render(<Panel option={{ included: true, pending: true }} />)
  expect(screen.getByText('Preparing the transcript…')).toBeTruthy()
})

it('is absent when no transcript is offered', () => {
  render(
    <NextStepWorkFiles
      worktreeId="folder:f1"
      workspacePath="/w"
      deliverables={{ kind: 'files', paths: [] }}
      defaults={null}
      onChange={() => {}}
    />
  )
  expect(screen.queryByRole('checkbox')).toBeNull()
})
