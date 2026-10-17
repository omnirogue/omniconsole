// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import {
  api,
  installAutomationsPageHarness,
  listedRow,
  mocks,
  renderPage,
  scopedList
} from './automations-page-test-harness'
import { makeAutomation } from './automations-page-fixtures'

installAutomationsPageHarness()

describe('automation editor launch preferences', () => {
  it('hydrates preferences and writes changed preferences into the update input', async () => {
    const automation = makeAutomation({
      id: 'a-1',
      agentId: 'codex',
      launchPreferences: { model: 'gpt-6-astra', effort: 'high' }
    })
    api.automations.list.mockResolvedValue([automation])
    scopedList([automation])
    api.automations.update.mockResolvedValue(automation)
    await renderPage()
    await act(async () => {
      mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    expect(mocks.editorDialog?.draft).toMatchObject({
      launchPreferences: automation.launchPreferences
    })
    const launchPreferences = { model: 'gpt-6-astra', effort: 'xhigh', codexAccountId: 'account-1' }
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as object),
        launchPreferences
      }))
    })
    await act(async () => {
      await mocks.editorDialog?.onSave()
    })
    expect(api.automations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: automation.id,
        updates: expect.objectContaining({ launchPreferences })
      })
    )
  })
})
