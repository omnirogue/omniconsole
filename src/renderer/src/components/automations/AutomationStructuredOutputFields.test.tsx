// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationStructuredOutputFields } from './AutomationStructuredOutputFields'

// Keep these tests focused on draft updates rather than Radix portal behavior.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

afterEach(cleanup)

const BASE_DRAFT: AutomationDraft = {
  name: 'Daily review',
  prompt: 'Review current performance',
  agentId: 'codex',
  projectId: 'repo-1',
  workspaceMode: 'existing',
  workspaceId: 'workspace-1',
  baseBranch: '',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '30',
  preset: 'daily',
  time: '09:15',
  dayOfWeek: '1',
  customSchedule: '',
  missedRunGraceMinutes: '720',
  scheduleWarning: null
}

const ADVERTISING_DRAFT: AutomationDraft = {
  ...BASE_DRAFT,
  structuredOutput: {
    provider: 'typesafe',
    contract: 'advertising.v1',
    advertising: {
      company: 'omnirogue',
      accountId: 'act_123456',
      minConfidence: 0.9,
      maxEvidenceAgeSeconds: 180
    }
  }
}

function renderFields(initialDraft = BASE_DRAFT): { current: AutomationDraft } {
  const state = { current: initialDraft }
  function ControlledFields(): React.JSX.Element {
    const [draft, setDraft] = React.useState(initialDraft)
    state.current = draft
    return (
      <AutomationStructuredOutputFields
        draft={draft}
        onDraftChange={setDraft}
        pickerTriggerClassName=""
      />
    )
  }
  render(<ControlledFields />)
  return state
}

describe('AutomationStructuredOutputFields', () => {
  it('enables classification without changing the selected agent or prompt', async () => {
    const user = userEvent.setup()
    const state = renderFields()
    expect(screen.getByDisplayValue('Off')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('Classification')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByDisplayValue('Off'), 'typesafe')

    expect(state.current).toEqual({
      ...BASE_DRAFT,
      structuredOutput: { provider: 'typesafe', contract: 'classification.v1' }
    })
    await user.selectOptions(screen.getByDisplayValue('Classification'), 'advertising.v1')

    expect(screen.getByRole('textbox', { name: 'Ad account ID' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Ad account ID' })).toBeRequired()
  })

  it('preserves saved confidence and evidence age while editing advertising scope', async () => {
    const user = userEvent.setup()
    const state = renderFields(ADVERTISING_DRAFT)

    await user.selectOptions(screen.getByDisplayValue('OmniRogue'), 'betacorp')
    const account = screen.getByRole('textbox', { name: 'Ad account ID' })
    await user.clear(account)
    await user.type(account, 'act_456789')

    expect(state.current).toEqual({
      ...BASE_DRAFT,
      structuredOutput: {
        provider: 'typesafe',
        contract: 'advertising.v1',
        advertising: {
          company: 'betacorp',
          accountId: 'act_456789',
          minConfidence: 0.9,
          maxEvidenceAgeSeconds: 180
        }
      }
    })
  })

  it('explicitly clears saved output settings when switched off', async () => {
    const user = userEvent.setup()
    const state = renderFields(ADVERTISING_DRAFT)

    await user.selectOptions(screen.getByDisplayValue('Structured decisions (Typesafe)'), 'off')

    expect(state.current).toEqual({ ...BASE_DRAFT, structuredOutput: null })
    expect(screen.queryByRole('textbox', { name: 'Ad account ID' })).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('Advertising')).not.toBeInTheDocument()
  })
})
