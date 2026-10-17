import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { defineMethod, type RpcAnyMethod } from '../core'
import {
  assertProjectedSessionTabVisible,
  isProjectedSessionTabVisible,
  translateProjectedSessionTabMove
} from './session-tab-browser-placement-projection'
import { projectSessionTabsForClient } from './session-tabs-inventory'
import { ActivateTab, MoveTab, SetTabProps, UpdatePaneLayout } from './session-tabs-schemas'

export const SESSION_TAB_MUTATION_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'session.tabs.activate',
    params: ActivateTab,
    handler: async (params, { runtime, clientKind, pairedDeviceId, clientCapabilities }) => {
      if (clientKind) {
        const raw = await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId)
        const visible = projectSessionTabsForClient(raw, clientKind, clientCapabilities)
        if (!isProjectedSessionTabVisible(visible, params.tabId)) {
          // Why: a capability-hidden row stays `tab_not_found`; only a row the owner has not
          // proven absent (reloading window, unpublished workspace) is a retryable refusal.
          if (!isProjectedSessionTabVisible(raw, params.tabId)) {
            await runtime.rejectMissingSessionTabActivation(params.worktree)
          }
          assertProjectedSessionTabVisible(visible, params.tabId)
        }
      }
      const result = await runtime.activateMobileSessionTab(
        params.worktree,
        params.tabId,
        params.leafId,
        {
          notifyClients: params.notifyClients !== false,
          clientNavigationId: pairedDeviceId,
          ...(params.intent ? { intent: params.intent } : {}),
          // Why: only a paired computer's activation is refused a fresh agent for a
          // restored pane; the phone's wake and in-process callers keep their path.
          ...(clientKind ? { clientKind } : {}),
          navigation: resolveRuntimeNavigationTarget({
            navigation: params.navigation,
            notifyClients: params.notifyClients,
            clientKind
          })
        }
      )
      return projectSessionTabsForMutationClient(result, clientKind, clientCapabilities)
    }
  }),
  defineMethod({
    name: 'session.tabs.move',
    params: MoveTab,
    handler: async (params, { runtime, pairedDeviceId, clientCapabilities, clientKind }) => {
      let translated: Parameters<typeof translateProjectedSessionTabMove>[2] = params
      if (clientKind) {
        const raw = await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId)
        const projected = projectSessionTabsForClient(raw, clientKind, clientCapabilities)
        translated = translateProjectedSessionTabMove(raw, projected, params)
      }
      const base = { tabId: translated.tabId, targetGroupId: translated.targetGroupId }
      if (translated.kind === 'reorder') {
        return runtime.moveMobileSessionTab(params.worktree, {
          ...base,
          kind: 'reorder',
          tabOrder: translated.tabOrder
        })
      }
      if (translated.kind === 'split') {
        return runtime.moveMobileSessionTab(params.worktree, {
          ...base,
          kind: 'split',
          splitDirection: translated.splitDirection
        })
      }
      return runtime.moveMobileSessionTab(params.worktree, {
        ...base,
        kind: 'move-to-group',
        index: translated.index
      })
    }
  }),
  defineMethod({
    name: 'session.tabs.updatePaneLayout',
    params: UpdatePaneLayout,
    handler: async (params, { runtime, pairedDeviceId, clientCapabilities, clientKind }) => {
      await assertVisibleMutationTab(
        runtime,
        params.worktree,
        params.tabId,
        pairedDeviceId,
        clientKind,
        clientCapabilities
      )
      return runtime.updateMobileSessionPaneLayout(params.worktree, {
        tabId: params.tabId,
        root: params.root,
        expandedLeafId: params.expandedLeafId ?? null,
        titlesByLeafId: params.titlesByLeafId
      })
    }
  }),
  defineMethod({
    name: 'session.tabs.setTabProps',
    params: SetTabProps,
    handler: async (params, { runtime, pairedDeviceId, clientCapabilities, clientKind }) => {
      await assertVisibleMutationTab(
        runtime,
        params.worktree,
        params.tabId,
        pairedDeviceId,
        clientKind,
        clientCapabilities
      )
      return runtime.setMobileSessionTabProps(params.worktree, {
        tabId: params.tabId,
        ...(params.color !== undefined ? { color: params.color } : {}),
        ...(params.isPinned !== undefined ? { isPinned: params.isPinned } : {}),
        ...(params.viewMode !== undefined ? { viewMode: params.viewMode } : {})
      })
    }
  })
]

const projectSessionTabsForMutationClient = projectSessionTabsForClient

async function assertVisibleMutationTab(
  runtime: OrcaRuntimeService,
  worktree: string,
  tabId: string,
  pairedDeviceId: string | undefined,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: Parameters<typeof projectSessionTabsForClient>[2]
): Promise<void> {
  if (!clientKind) {
    return
  }
  const visible = projectSessionTabsForClient(
    await runtime.listMobileSessionTabs(worktree, pairedDeviceId),
    clientKind,
    clientCapabilities
  )
  assertProjectedSessionTabVisible(visible, tabId)
}
