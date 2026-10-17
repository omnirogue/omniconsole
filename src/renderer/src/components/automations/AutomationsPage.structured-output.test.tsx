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

describe('routine structured-output editor persistence', () => {
  it('hydrates a saved choice and sends explicit off when it is cleared', async () => {
    const structuredOutput = { provider: 'typesafe', contract: 'classification.v1' } as const
    const automation = makeAutomation({ id: 'a-1', structuredOutput })
    api.automations.list.mockResolvedValue([automation])
    scopedList([automation])
    api.automations.update.mockResolvedValue(automation)
    await renderPage()
    await act(async () => {
      mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    expect(mocks.editorDialog?.draft).toMatchObject({ structuredOutput })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as object),
        structuredOutput: null
      }))
    })
    await act(async () => {
      await mocks.editorDialog?.onSave()
    })
    expect(api.automations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: automation.id,
        updates: expect.objectContaining({ structuredOutput: null })
      })
    )
  })

  it('leaves a legacy routine option absent during an unrelated edit', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([automation])
    scopedList([automation])
    api.automations.update.mockResolvedValue(automation)
    await renderPage()
    await act(async () => {
      mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({ ...(current as object), name: 'Renamed' }))
    })
    await act(async () => {
      await mocks.editorDialog?.onSave()
    })
    expect(api.automations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: automation.id,
        updates: expect.not.objectContaining({ structuredOutput: expect.anything() })
      })
    )
    expect(api.automations.update.mock.calls[0][0].updates).not.toHaveProperty('structuredOutput')
  })
})
