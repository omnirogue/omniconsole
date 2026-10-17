import { createHash } from 'node:crypto'
import { canonicalJson } from '../../../../../shared/decision-contracts/decision-calibration-summary'
import { resolveAgentTemplateParam } from '../agent-templates'
import { defineMethod, type RpcAnyMethod } from '../../core'
import { rpcTerminalLaunchCause } from '../../terminal-launch-cause'
import {
  navigationTargetsHost,
  resolveRuntimeNavigationTarget
} from '../../../../../shared/runtime-navigation'
import { withTerminalCloseAttribution } from '../../terminal-close-attribution'
import {
  AgentTeamsPrepareLaunch,
  AgentTeamsTmuxCompat,
  TerminalCreateParams,
  TerminalFocus,
  TerminalHandle,
  TerminalSleep,
  TerminalSplit,
  TerminalStop,
  TerminalStopExact,
  TerminalWait
} from './unary-schemas'
import { TerminalResizeForClient } from './stream-schemas'

export const TERMINAL_LIFECYCLE_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.wait',
    params: TerminalWait,
    handler: async (params, { runtime, signal }) => ({
      wait: await runtime.waitForTerminal(params.terminal, {
        condition: params.for,
        timeoutMs: params.timeoutMs,
        signal
      })
    })
  }),
  defineMethod({
    name: 'terminal.create',
    params: TerminalCreateParams,
    handler: async (
      params,
      {
        runtime,
        pairedDeviceId,
        clientId,
        clientKind,
        keepAliveWhileWaiting,
        requestId,
        orchestrationCompatibilityEvidence
      }
    ) => ({
      terminal: await runtime.dedupeTerminalCreate(
        pairedDeviceId ?? clientId ?? 'local',
        params.worktree,
        params.clientMutationId,
        params.reconcileExisting === true,
        (canonicalWorktreeSelector, preAllocatedHandle, onPtySpawnCommitted) =>
          runtime.createTerminal(canonicalWorktreeSelector, {
            command: params.command,
            startupCommandDelivery: params.startupCommandDelivery,
            env: params.env,
            envToDelete: params.envToDelete,
            ...(params.launchConfig ? { launchConfig: params.launchConfig } : {}),
            ...(params.resumeProviderSession
              ? { resumeProviderSession: params.resumeProviderSession }
              : {}),
            ...(params.launchToken ? { launchToken: params.launchToken } : {}),
            ...(params.launchAgent ? { launchAgent: params.launchAgent } : {}),
            // Why inside the create: a reconciled retry replays without resolving it again.
            ...(params.agentTemplateId
              ? { agentTemplate: resolveAgentTemplateParam(runtime, params.agentTemplateId) }
              : {}),
            ...(params.terminalColorQueryReplies
              ? { terminalColorQueryReplies: params.terminalColorQueryReplies }
              : {}),
            title: params.title,
            // Why unknown: `terminal create` names its tab; an older CLI says nothing about whose words.
            ...(params.title ? { titleOrigin: params.titleOrigin ?? 'unknown' } : {}),
            focus: params.focus === true,
            rendererBacked: params.rendererBacked === true,
            activate: params.activate === true,
            presentation: params.presentation,
            tabId: params.tabId,
            leafId: params.leafId,
            launchCause: rpcTerminalLaunchCause(
              { pairedDeviceId, clientKind, requestId, orchestrationCompatibilityEvidence },
              'terminal-create',
              params.clientMutationId,
              params.launchCause
            ),
            ...(preAllocatedHandle ? { preAllocatedHandle } : {}),
            ...(onPtySpawnCommitted ? { onPtySpawnCommitted } : {}),
            // Why: an agent start can wait for an app-wide admission slot (3 per 10 s); a CLI or
            // orchestrator create must not be dropped by an idle socket timer while it waits.
            ...(keepAliveWhileWaiting ? { onAgentLaunchQueued: keepAliveWhileWaiting } : {}),
            // Why: a phone's new terminal is a person asking for it now (admission person lane).
            ...(clientKind === 'mobile' ? { agentLaunchPriority: 'person' as const } : {})
          }),
        ...(clientKind !== 'mobile' &&
        params.worktree &&
        params.tabId === undefined &&
        params.leafId === undefined &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          params.clientMutationId ?? ''
        )
          ? ([
              createHash('sha256')
                .update(
                  canonicalJson({
                    ...params,
                    worktree: undefined,
                    clientMutationId: undefined,
                    reconcileExisting: undefined
                  })
                )
                .digest('hex')
            ] as const)
          : [])
      )
    })
  }),
  defineMethod({
    name: 'terminal.split',
    params: TerminalSplit,
    handler: async (
      params,
      { runtime, clientKind, pairedDeviceId, requestId, orchestrationCompatibilityEvidence }
    ) => ({
      split: await runtime.splitTerminal(params.terminal, {
        direction: params.direction,
        command: params.command,
        env: params.env,
        telemetrySource: params.telemetrySource,
        launchCause: rpcTerminalLaunchCause(
          {
            pairedDeviceId,
            clientKind,
            requestId,
            orchestrationCompatibilityEvidence
          },
          'terminal-split'
        )
      })
    })
  }),
  defineMethod({
    name: 'terminal.stop',
    params: TerminalStop,
    handler: async (params, { runtime }) => runtime.stopTerminalsForWorktree(params.worktree)
  }),
  defineMethod({
    name: 'terminal.sleep',
    params: TerminalSleep,
    handler: async (params, { runtime }) => runtime.sleepTerminalsForWorktree(params.worktree)
  }),
  defineMethod({
    name: 'terminal.stopExact',
    params: TerminalStopExact,
    handler: async (params, { runtime }) =>
      runtime.stopExactTerminalsForWorktree(params.worktree, params.expectedPtyIds, {
        keepHistory: params.keepHistory,
        targetOnly: params.targetOnly
      })
  }),
  defineMethod({
    name: 'terminal.resizeForClient',
    params: TerminalResizeForClient,
    handler: async (params, { runtime }) => {
      // Why: a stale handle must fail with terminal_handle_stale, not resize the wrong PTY (#7718).
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      const result = await runtime.resizeForClient(
        leaf.ptyId,
        params.mode,
        params.clientId,
        params.mode === 'mobile-fit' ? params.cols : undefined,
        params.mode === 'mobile-fit' ? params.rows : undefined
      )
      return {
        terminal: {
          handle: params.terminal,
          ...result
        }
      }
    }
  }),
  defineMethod({
    name: 'terminal.focus',
    params: TerminalFocus,
    handler: async (params, { runtime, clientKind }) => ({
      focus: await runtime.focusTerminal(params.terminal, {
        navigateHost: navigationTargetsHost(
          resolveRuntimeNavigationTarget({ navigation: params.navigation, clientKind })
        )
      })
    })
  }),
  defineMethod({
    name: 'terminal.close',
    params: TerminalHandle,
    handler: async (params, context) => ({
      close: await withTerminalCloseAttribution(
        'terminal.close',
        context,
        'terminal',
        params.terminal,
        () => context.runtime.closeTerminal(params.terminal)
      )
    })
  }),
  defineMethod({
    name: 'terminal.closeTab',
    params: TerminalHandle,
    handler: async (params, context) => ({
      close: await withTerminalCloseAttribution(
        'terminal.closeTab',
        context,
        'terminal-tab',
        params.terminal,
        () => context.runtime.closeTerminalTab(params.terminal)
      )
    })
  }),
  defineMethod({
    name: 'agentTeams.tmuxCompat',
    params: AgentTeamsTmuxCompat,
    handler: async (params, { runtime }) => ({
      tmux: await runtime.handleAgentTeamsTmuxCompat(params)
    })
  }),
  defineMethod({
    name: 'agentTeams.prepareLaunch',
    params: AgentTeamsPrepareLaunch,
    handler: async (params, { runtime }) => ({
      launch: await runtime.prepareClaudeAgentTeamsLeader({
        paneKey: params.paneKey,
        baseEnv: params.env
      })
    })
  })
]
