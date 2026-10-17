import { findLaunchHistory } from '../../../../launch-ledger/launch-ledger'
import { isTerminalLeafId, makePaneKey } from '../../../../../shared/stable-pane-id'
import { defineMethod, type RpcAnyMethod } from '../../core'
import {
  TerminalHandle,
  TerminalListParams,
  TerminalRead,
  TerminalRecoverPane,
  TerminalRename,
  TerminalResolveActive,
  TerminalResolvePane
} from './unary-schemas'

export const TERMINAL_QUERY_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.list',
    params: TerminalListParams,
    handler: async (params, { runtime }) =>
      runtime.listTerminals(params.worktree, params.limit, {
        handles: params.handles,
        requireFreshPtyLiveness: params.requireFreshPtyLiveness,
        includeVisualLayouts: params.includeVisualLayouts
      })
  }),
  defineMethod({
    name: 'terminal.resolveActive',
    params: TerminalResolveActive,
    handler: async (params, { runtime }) => ({
      handle: await runtime.resolveActiveTerminal(params.worktree)
    })
  }),
  defineMethod({
    name: 'terminal.resolvePane',
    params: TerminalResolvePane,
    handler: async (params, { runtime }) => ({
      terminal: runtime.resolveTerminalPane(params.paneKey, params.worktreeId)
    })
  }),
  defineMethod({
    name: 'terminal.recoverPane',
    params: TerminalRecoverPane,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.recoverTerminalPane(
        params.paneKey,
        params.worktreeId,
        params.expectedTerminal
      )
    })
  }),
  defineMethod({
    name: 'terminal.show',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.showTerminal(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.why',
    params: TerminalHandle,
    handler: async (params, { runtime }) => {
      const terminal = await runtime.showTerminal(params.terminal)
      const processIncarnation = runtime.getTerminalProcessIncarnation(params.terminal)
      const incarnationId =
        terminal.ptyId && processIncarnation?.startsWith(`${terminal.ptyId}:`)
          ? processIncarnation.slice(terminal.ptyId.length + 1)
          : undefined
      const paneKey =
        terminal.tabId &&
        !terminal.tabId.includes(':') &&
        terminal.leafId &&
        isTerminalLeafId(terminal.leafId)
          ? makePaneKey(terminal.tabId, terminal.leafId)
          : null
      return {
        why: {
          terminal: params.terminal,
          ptyId: terminal.ptyId ?? null,
          paneKey,
          ...(await findLaunchHistory({
            ptyId: terminal.ptyId ?? undefined,
            paneKey: paneKey ?? undefined,
            incarnationId
          }))
        }
      }
    }
  }),
  defineMethod({
    name: 'terminal.read',
    params: TerminalRead,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.readTerminal(params.terminal, {
        cursor: params.cursor,
        limit: params.limit,
        screen: params.screen
      })
    })
  }),
  defineMethod({
    name: 'terminal.inspectProcess',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      process: await runtime.inspectTerminalProcess(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.isRunningAgent',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      isRunningAgent: await runtime.isTerminalRunningAgent(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.agentStatus',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      agentStatus: await runtime.getTerminalAgentStatus(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.rename',
    params: TerminalRename,
    handler: async (params, { runtime }) => ({
      rename: await runtime.renameTerminal(params.terminal, params.title || null, {
        ...(params.titleOrigin ? { origin: params.titleOrigin } : {}),
        ...(params.titleSource ? { source: params.titleSource } : {})
      })
    })
  }),
  defineMethod({
    name: 'terminal.clearBuffer',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      clear: await runtime.clearTerminalBuffer(params.terminal)
    })
  })
]
