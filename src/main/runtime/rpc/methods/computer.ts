import {
  observeTerminalAccessibleSnapshot,
  performTerminalAccessibleAction,
  resetTerminalAccessibleSnapshots
} from '../../../computer/terminal-accessible-actions'
import { z } from 'zod'
import {
  callComputerSidecarCapabilities,
  callComputerSidecarListApps,
  callComputerSidecarListWindows,
  resetComputerSidecarForTest
} from '../../../computer/sidecar-client'
import { defineMethod, type RpcMethod } from '../core'
import {
  Click,
  ComputerObserveTarget,
  ComputerPermissions,
  Drag,
  Hotkey,
  ListApps,
  ListWindows,
  PasteText,
  PerformSecondaryAction,
  PressKey,
  Scroll,
  SetValue,
  TypeText
} from './computer-schemas'

export function resetComputerSessionsForTest(): void {
  resetComputerSidecarForTest()
  resetTerminalAccessibleSnapshots()
}

export const COMPUTER_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'computer.capabilities',
    params: z.object({}),
    handler: async () => {
      return await callComputerSidecarCapabilities()
    }
  }),
  defineMethod({
    name: 'computer.listApps',
    params: ListApps,
    handler: async () => {
      return await callComputerSidecarListApps()
    }
  }),
  defineMethod({
    name: 'computer.permissions',
    params: ComputerPermissions,
    handler: async (params) => {
      const { openComputerUsePermissions } =
        await import('../../../computer/macos-computer-use-permissions')
      return openComputerUsePermissions(params.id)
    }
  }),
  defineMethod({
    name: 'computer.permissionsStatus',
    params: z.object({}),
    handler: async () => {
      const { getComputerUsePermissionStatus } =
        await import('../../../computer/macos-computer-use-permissions')
      return getComputerUsePermissionStatus()
    }
  }),
  defineMethod({
    name: 'computer.listWindows',
    params: ListWindows,
    handler: async (params) => {
      return await callComputerSidecarListWindows(params)
    }
  }),
  defineMethod({
    name: 'computer.getAppState',
    params: ComputerObserveTarget,
    handler: async (params, { runtime }) => {
      return await observeTerminalAccessibleSnapshot(params, runtime)
    }
  }),
  defineMethod({
    name: 'computer.click',
    params: Click,
    handler: async (params, { runtime }) => {
      return await performTerminalAccessibleAction('click', params, runtime)
    }
  }),
  defineMethod({
    name: 'computer.performSecondaryAction',
    params: PerformSecondaryAction,
    handler: async (params, { runtime }) => {
      return await performTerminalAccessibleAction('performSecondaryAction', params, runtime)
    }
  }),
  defineMethod({
    name: 'computer.scroll',
    params: Scroll,
    handler: async (params, { runtime }) => {
      return await performTerminalAccessibleAction('scroll', params, runtime)
    }
  }),
  defineMethod({
    name: 'computer.drag',
    params: Drag,
    handler: async (params, { runtime }) => {
      return await performTerminalAccessibleAction('drag', params, runtime)
    }
  }),
  defineMethod({
    name: 'computer.typeText',
    params: TypeText,
    handler: async (params, { runtime }) => {
      return await performTerminalAccessibleAction('typeText', params, runtime)
    }
  }),
  defineMethod({
    name: 'computer.pressKey',
    params: PressKey,
    handler: async (params, { runtime }) => {
      return await performTerminalAccessibleAction('pressKey', params, runtime)
    }
  }),
  defineMethod({
    name: 'computer.hotkey',
    params: Hotkey,
    handler: async (params, { runtime }) => {
      return await performTerminalAccessibleAction('hotkey', params, runtime)
    }
  }),
  defineMethod({
    name: 'computer.pasteText',
    params: PasteText,
    handler: async (params, { runtime }) => {
      return await performTerminalAccessibleAction('pasteText', params, runtime)
    }
  }),
  defineMethod({
    name: 'computer.setValue',
    params: SetValue,
    handler: async (params, { runtime }) => {
      return await performTerminalAccessibleAction('setValue', params, runtime)
    }
  })
]
