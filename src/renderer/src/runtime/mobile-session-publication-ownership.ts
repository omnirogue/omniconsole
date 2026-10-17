import {
  isPublishableSessionInventoryTab,
  type SessionInventoryWorkspaceProvenance
} from '../../../shared/session-inventory-ownership'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { OpenFile } from '../store/slices/editor'

export type MobileSessionPublicationOwnership = {
  isTerminalPublishable: (
    terminal: Pick<TerminalTab, 'id' | 'ptyId'>,
    layout: Pick<TerminalLayoutSnapshot, 'ptyIdsByLeafId'> | undefined
  ) => boolean
  isEditorPublishable: (
    file: Pick<OpenFile, 'id' | 'mirroredFromRuntimeSession' | 'runtimeEnvironmentId'>,
    unifiedTab?: Pick<Tab, 'id' | 'executionHostId'>
  ) => boolean
  isBrowserPublishable: (
    browserWorkspaceId: string,
    unifiedTab?: Pick<Tab, 'id' | 'executionHostId'>
  ) => boolean
}

/**
 * Per-tab provenance for the desktop publication, applying the shared session-inventory rule:
 * a paired runtime's mirrors (stamped unified tabs, remote PTYs, web-terminal mirrors and
 * mirrored editors) stay visible here but are never republished as this computer's inventory.
 */
export function createMobileSessionPublicationOwnership(
  workspace: SessionInventoryWorkspaceProvenance,
  unifiedTabs: readonly Tab[]
): MobileSessionPublicationOwnership {
  const unifiedByEntity = new Map<string, Tab>()
  for (const tab of unifiedTabs) {
    const key = `${tab.contentType}\0${tab.entityId}`
    if (!unifiedByEntity.has(key)) {
      unifiedByEntity.set(key, tab)
    }
  }
  return {
    isTerminalPublishable: (terminal, layout) =>
      isPublishableSessionInventoryTab(workspace, {
        tabId: terminal.id,
        executionHostId: unifiedByEntity.get(`terminal\0${terminal.id}`)?.executionHostId,
        ptyIds: [terminal.ptyId, ...Object.values(layout?.ptyIdsByLeafId ?? {})]
      }),
    isEditorPublishable: (file, unifiedTab) =>
      isPublishableSessionInventoryTab(workspace, {
        tabId: unifiedTab?.id ?? null,
        executionHostId: (
          unifiedTab ??
          unifiedByEntity.get(`editor\0${file.id}`) ??
          unifiedByEntity.get(`diff\0${file.id}`)
        )?.executionHostId,
        // Why: a file mirrored from a paired session is that environment's surface; republishing it
        // is how editors multiplied across computers (E3). A routing env alone is not provenance.
        mirroredFromEnvironmentId:
          file.mirroredFromRuntimeSession === true
            ? file.runtimeEnvironmentId?.trim() || 'unknown-runtime-environment'
            : null
      }),
    isBrowserPublishable: (browserWorkspaceId, unifiedTab) =>
      isPublishableSessionInventoryTab(workspace, {
        tabId: unifiedTab?.id ?? null,
        executionHostId: (unifiedTab ?? unifiedByEntity.get(`browser\0${browserWorkspaceId}`))
          ?.executionHostId
      })
  }
}
