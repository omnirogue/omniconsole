import { sessionAgentTemplateForChoice } from '../../../shared/session-agent-template'
import { buildRoutineRunPrompt, routineAgentTemplate } from '../../../shared/routine-run-prompt'
import { routineLaunchPreferences } from '../../../shared/automation-tool-launch'
import { AutomationLaunchUnverifiableError } from '../../../shared/automation-launch-outcome'
import { assertAutomationWorkspaceAuthority } from '@/lib/automation-workspace-hub-authority'
import { sendAutomationSessionInput } from '@/lib/automation-reused-session-input'
import { listAutomationRunsForTarget } from '@/components/automations/automation-host-client'
import { translate } from '@/i18n/i18n'
import { submitPromptToAgentPty } from '@/lib/agent-paste-draft'
import { launchAutomationAgentSession } from '@/lib/automation-thread-resume-launch'
import { observeExistingAutomationSession } from '@/lib/automation-session-observer'
import { findReusableAutomationSession } from '@/lib/automation-session-reuse'
import type { AutomationTerminalOwnership } from '@/lib/automation-terminal-ownership'
import { useAppStore } from '@/store'
import type {
  AutomationDispatchRequest,
  AutomationDispatchResult
} from '../../../shared/automations-types'
import { createAutomationDispatchCompletion } from './automation-dispatch-completion'
import {
  automationDispatchTerminalBinding,
  type AutomationDispatchTerminalBinding
} from './automation-dispatch-terminal-binding'
import {
  prepareAutomationDispatchWorkspace,
  resolveAutomationDispatchWorkspace
} from './automation-dispatch-workspace'

const activeReuseDispatchTabIds = new Set<string>()

function acquireReuseDispatchTab(tabId: string): (() => void) | null {
  if (activeReuseDispatchTabIds.has(tabId)) {
    return null
  }
  activeReuseDispatchTabIds.add(tabId)
  return () => activeReuseDispatchTabIds.delete(tabId)
}

export async function handleAutomationDispatchRequest({
  automation,
  run,
  dispatchToken,
  outputBinding,
  launchProvenance,
  projectBrief
}: AutomationDispatchRequest): Promise<void> {
  const markDispatchResult = async (result: AutomationDispatchResult): Promise<void> => {
    // Deliberately no local emit: the write publishes its own host-scoped event
    // (automation-run-writer.ts) before this reply returns, and an unscoped one
    // here would arrive second and invalidate every host in the catalog.
    await window.api.automations.markDispatchResult(result)
  }
  const state = useAppStore.getState()
  const resolved = resolveAutomationDispatchWorkspace(state, automation, run)
  let terminalOwnership: AutomationTerminalOwnership | null = null
  let launchedRunTarget: AutomationDispatchTerminalBinding | null = null
  const releaseTerminalOwnership = (): void => {
    const ownership = terminalOwnership
    terminalOwnership = null
    ownership?.release()
  }
  const finalizeTerminalOwnership = (): boolean => {
    const ownership = terminalOwnership
    terminalOwnership = null
    return ownership?.finalize() ?? false
  }

  if (!resolved.repo) {
    await markDispatchResult({
      runId: run.id,
      status: 'skipped_unavailable',
      workspaceId: run.workspaceId,
      workspaceDisplayName: run.workspaceDisplayName ?? null,
      error: translate(
        'auto.hooks.useAutomationDispatchEvents.386db94f3e',
        'The target project is no longer available.'
      )
    })
    return
  }

  try {
    assertAutomationWorkspaceAuthority(automation.workspaceId)
    const prompt = buildRoutineRunPrompt(
      automation,
      run.promptOverride ?? automation.prompt,
      routineAgentTemplate(state.settings, automation),
      projectBrief
    )
    const worktree = await prepareAutomationDispatchWorkspace({
      state,
      automation,
      run,
      dispatchToken,
      resolved: { ...resolved, repo: resolved.repo },
      markDispatchResult
    })
    if (!worktree) {
      return
    }
    assertAutomationWorkspaceAuthority(worktree.id)
    const completion = createAutomationDispatchCompletion({
      run,
      agentId: automation.agentId,
      worktree,
      precheckResult: resolved.context.precheckResult,
      markDispatchResult,
      releaseTerminalOwnership,
      finalizeTerminalOwnership
    })
    const dispatchStartedAt = Date.now()
    // Why: launch preferences apply only to fresh processes; reuse preserves the live session.
    if (automation.reuseSession) {
      const reusableSession = findReusableAutomationSession({
        automationId: automation.id,
        tools: automation.tools,
        agentId: automation.agentId,
        worktreeId: worktree.id,
        currentRunId: run.id,
        // Why: the dispatch loop only ever executes for the desktop authority,
        // so its history read addresses the local runtime explicitly.
        runs: await listAutomationRunsForTarget({ kind: 'local' }, automation.id),
        state: useAppStore.getState()
      })
      assertAutomationWorkspaceAuthority(worktree.id)
      if (reusableSession) {
        const releaseTab = acquireReuseDispatchTab(reusableSession.tabId)
        if (releaseTab) {
          completion.setReuseDispatchTabRelease(releaseTab)
          try {
            assertAutomationWorkspaceAuthority(worktree.id, reusableSession.paneKey)
            const submitted = await submitPromptToAgentPty({
              tabId: reusableSession.tabId,
              ptyId: reusableSession.ptyId,
              content: prompt,
              beforeWrite: () =>
                assertAutomationWorkspaceAuthority(worktree.id, reusableSession.paneKey),
              writePty: (text) => {
                launchedRunTarget = automationDispatchTerminalBinding(
                  worktree,
                  reusableSession,
                  false
                )
                return sendAutomationSessionInput({
                  workspaceId: worktree.id,
                  paneKey: reusableSession.paneKey,
                  ptyId: reusableSession.ptyId,
                  text,
                  ...(outputBinding ? { automationOutputBinding: outputBinding } : {})
                })
              }
            })
            if (!submitted) {
              completion.cleanupRunObservers()
              if (launchedRunTarget) {
                throw new Error('The routine prompt submission could not be confirmed.')
              }
            } else {
              launchedRunTarget = automationDispatchTerminalBinding(
                worktree,
                reusableSession,
                false
              )
              let reuseSawWorking = false
              const handleReusableAgentStatus = (
                payload: { state: string } & NonNullable<
                  Parameters<typeof completion.handleAgentDone>[0]
                >
              ): void => {
                if (payload.state === 'working') {
                  reuseSawWorking = true
                  return
                }
                if (payload.state === 'done' && reuseSawWorking) {
                  completion.handleAgentDone(payload)
                }
              }
              const reuseCompletionStartedAt = Date.now()
              completion.setSessionObserver(
                await observeExistingAutomationSession({
                  ptyId: reusableSession.ptyId,
                  paneKey: reusableSession.paneKey,
                  runId: run.id,
                  onData: completion.appendOutput,
                  onAgentStatus: (payload) => {
                    completion.captureAssistantMessage(payload.lastAssistantMessage)
                    handleReusableAgentStatus(payload)
                  },
                  onExit: completion.handleExit
                })
              )
              completion.observeAgentStatus(reusableSession.paneKey, reuseCompletionStartedAt, {
                requireWorkingAfterStart: true
              })
              await markDispatchResult({
                runId: run.id,
                status: 'dispatched',
                workspaceId: worktree.id,
                workspaceDisplayName: worktree.displayName,
                ownsTerminal: false,
                terminalSessionId: reusableSession.tabId,
                terminalPaneKey: reusableSession.paneKey,
                terminalPtyId: reusableSession.ptyId,
                precheckResult: resolved.context.precheckResult,
                error: null
              })
              await completion.settlePendingAfterDispatch()
              return
            }
          } catch (error) {
            completion.cleanupRunObservers()
            throw error
          }
        }
      }
    }
    assertAutomationWorkspaceAuthority(worktree.id)
    let freshSawWorking = false
    const launched = await launchAutomationAgentSession({
      automation,
      run,
      worktreeId: worktree.id,
      launch: {
        launchPreferences: routineLaunchPreferences(automation),
        agent: automation.agentId,
        worktreeId: worktree.id,
        prompt,
        ...(launchProvenance ? { automationLaunchProvenance: launchProvenance } : {}),
        ...(outputBinding ? { automationOutputBinding: outputBinding } : {}),
        launchSource: 'unknown',
        title: run.title,
        onData: completion.appendOutput,
        onAgentStatus: (payload) => {
          completion.captureAssistantMessage(payload.lastAssistantMessage)
          // Why: session-boundary done = launch connect, not run completion (see observeAgentStatus).
          if (payload.state === 'working') {
            freshSawWorking = true
          }
          if (payload.state !== 'done' || payload.sessionBoundary === true || !freshSawWorking) {
            return
          }
          completion.handleAgentDone(payload)
        },
        onExit: (_ptyId, code) => {
          completion.handleExit(code)
        }
      }
    })
    const result = launched.result
    if (!result) {
      throw new Error('Unable to build an agent launch plan.')
    }
    launchedRunTarget = automationDispatchTerminalBinding(worktree, result, true)
    completion.setThreadResume(launched.resume)
    terminalOwnership = result.terminalOwnership
    // Why: launch preferences apply only to fresh processes; reuse preserves the live session.
    if (automation.reuseSession) {
      // Why: the first fresh launch is the seed for later reuse and must
      // survive completion under the same policy as an already-reused tab.
      releaseTerminalOwnership()
    }
    const launchedTabId = result.tabId
    // Why only a set id: a routine saved before templates existed never chose Default.
    const agentTemplate = automation.agentTemplateId
      ? sessionAgentTemplateForChoice(state.settings?.agentTemplates, automation.agentTemplateId)
      : undefined
    if (launchedTabId && agentTemplate) {
      useAppStore.getState().setTabAgentTemplate(launchedTabId, agentTemplate)
    }
    completion.observeAgentStatus(result.paneKey, dispatchStartedAt, {
      requireWorkingAfterStart: true
    })
    try {
      await markDispatchResult({
        runId: run.id,
        status: 'dispatched',
        workspaceId: worktree.id,
        workspaceDisplayName: worktree.displayName,
        ownsTerminal: true,
        terminalSessionId: launchedTabId,
        terminalPaneKey: result.paneKey,
        terminalPtyId: result.ptyId,
        precheckResult: resolved.context.precheckResult,
        error: null,
        ...completion.providerSessionFields()
      })
      if (result.promptDeliveryResult && !(await result.promptDeliveryResult)) {
        throw new Error(
          translate(
            'chatActions.routinePromptUnconfirmed',
            'The routine started its agent, but prompt delivery could not be confirmed. Open its conversation to check before running it again.'
          )
        )
      }
      await completion.settlePendingAfterDispatch()
    } catch (error) {
      completion.cleanupRunObservers()
      throw error
    }
    // Background launches never navigate; restoring an old snapshot would undo user navigation.
  } catch (error) {
    releaseTerminalOwnership()
    const unverifiable =
      error instanceof AutomationLaunchUnverifiableError || launchedRunTarget !== null
    await markDispatchResult({
      runId: run.id,
      status: unverifiable ? (launchedRunTarget ? 'dispatched' : 'dispatching') : 'dispatch_failed',
      workspaceId: resolved.context.workspaceId,
      workspaceDisplayName: resolved.context.workspaceDisplayName,
      ...launchedRunTarget,
      ...(unverifiable ? { launchOutcome: 'unverifiable' } : {}),
      precheckResult: resolved.context.precheckResult,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
