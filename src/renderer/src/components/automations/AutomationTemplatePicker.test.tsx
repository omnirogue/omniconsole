// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { AutomationEditorDialogHeader } from './AutomationEditorDialogHeader'
import { getAutomationTemplates } from './automation-templates'
import { applyAutomationTemplate } from './automation-template-draft'
import { buildAutomationEditDraft } from './automation-edit-draft'
import { makeAutomation } from './automations-page-fixtures'
import type { AutomationDraft } from './AutomationEditorDialog'
it('selects a template, prefills the draft, and preserves user edits', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let latest: AutomationDraft | undefined
  function Harness() {
    const [draft, setDraft] = useState(buildAutomationEditDraft(makeAutomation()))
    const [open, setOpen] = useState(false)
    latest = draft
    return (
      <Dialog open>
        <DialogContent>
          <AutomationEditorDialogHeader
            isEditing={false}
            isEditingExternal={false}
            isHermesCreate={false}
            isCreateMode
            createTarget="omni"
            templateOpen={open}
            templates={getAutomationTemplates()}
            segmentedGroupClassName=""
            segmentedItemClassName=""
            onCreateTargetChange={() => {}}
            onTemplateOpenChange={setOpen}
            onApplyTemplate={(template) => {
              setDraft((current) => applyAutomationTemplate(current, template))
              setOpen(false)
            }}
          />
          <button
            onClick={() =>
              setDraft((current) => ({ ...current, name: 'My briefing', outputFormat: 'html' }))
            }
          >
            Edit draft
          </button>
        </DialogContent>
      </Dialog>
    )
  }
  try {
    await act(async () => {
      root.render(<Harness />)
    })
    const click = async (text: string) => {
      await act(async () => {
        Array.from(document.querySelectorAll('button'))
          .find((button) => button.textContent?.includes(text))!
          .click()
      })
    }
    await click('Start from template')
    await click('Briefing')
    expect(latest).toMatchObject({
      name: 'Briefing',
      preset: 'weekdays',
      time: '08:30',
      notify: { onFinish: true, onlyWhenNotable: true, channels: [{ kind: 'desktop' }] },
      outputFormat: 'markdown',
      delivery: [{ kind: 'chat' }]
    })
    expect(latest?.prompt).toContain('Generate a briefing to help me catch up.')
    expect(latest?.tools?.mcpServers).toEqual(
      expect.arrayContaining(['calendar', 'email', 'slack'])
    )
    await click('Edit draft')
    expect(latest).toMatchObject({ name: 'My briefing', outputFormat: 'html', time: '08:30' })
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
