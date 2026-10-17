import { registerTerminalAccessibleWindow } from '../computer/terminal-accessible-renderer'
import { registerSelfTargetAccessibilityWindow } from '../computer/self-target-accessibility-registration'
import { BUILD_REVIEW_CHANGED_CHANNEL } from '../../shared/build-review-pipeline'
import { LOCAL_RUN_CHANGED_CHANNEL } from '../../shared/local-run-types'
import { LOCAL_WORKFLOW_CHANGED_CHANNEL } from '../../shared/local-workflow-changed'
import { postBackofficeExecutionObservation } from '../backoffice/backoffice-execution-observation'
import { postBackofficeReviewNote } from '../backoffice/backoffice-review-note'
import { setBuildReviewNoteReporter } from '../runtime/build-review/build-review-service'
import { getConsoleLocalExecution } from '../console-workflows/console-local-execution-registration'
import { randomUUID } from 'node:crypto'

import { app, ipcMain } from 'electron'
import { focusExistingMainWindow } from './focus-existing-window'
import type { BrowserWindow } from 'electron'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult
} from '../../shared/mobile-markdown-document'
import type { RuntimeMobileSessionTabMove } from '../../shared/runtime-types'
import type { TerminalTabCreateReply } from '../../shared/terminal-reveal-identity'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { requestMobileMarkdownFromRenderer } from './mobile-markdown-request-relay'
import { registerRendererDocumentNavigation } from './renderer-document-navigation'
import { createRuntimeRendererNotificationSender } from './runtime-renderer-notification-sender'
import { requestLocalWorkflowFindFromRenderer } from './local-workflow-find-request-relay'
import { requestSessionTabCloseFromRenderer } from './session-tab-close-request-relay'
import { requestTerminalTabCloseFromRenderer } from './terminal-tab-close-request-relay'

let runtimeNotifierTokenCounter = 0
let activeRuntimeNotifierToken: number | null = null

export function registerRuntimeWindowLifecycle(
  mainWindow: BrowserWindow,
  runtime: OrcaRuntimeService
): void {
  // Why optional: window-lifecycle tests fake the runtime with only the methods they exercise.
  runtime.setOrchestrationObservationReporter?.(postBackofficeExecutionObservation)
  if (typeof runtime.getOrchestrationDb === 'function') {
    getConsoleLocalExecution(runtime)
  }
  setBuildReviewNoteReporter(postBackofficeReviewNote)
  const notifierToken = ++runtimeNotifierTokenCounter
  activeRuntimeNotifierToken = notifierToken
  runtime.attachWindow(mainWindow.id)
  const unregisterAccessibleWindow = registerTerminalAccessibleWindow(mainWindow)
  const unregisterSelfTargetAccessibility = registerSelfTargetAccessibilityWindow(mainWindow)
  const mainWebContents = mainWindow.webContents
  const rendererNotifications = createRuntimeRendererNotificationSender({
    isWindowDestroyed: () => mainWindow.isDestroyed(),
    webContents: mainWebContents,
    onFailure: (reason) => runtime.markGraphReloadFailed(mainWindow.id, reason)
  })
  const send = rendererNotifications.send
  const focusWindow = (): void => {
    // Why: this runs ahead of terminal reveal/reply sends. Test doubles and
    // partial window shims used elsewhere in this codebase do not implement
    // the full BrowserWindow surface (isMinimized/restore/focus); a focus
    // failure must never block or change the identity-checked reveal path.
    try {
      if (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed()) {
        return
      }
      focusExistingMainWindow({ app, getWindow: () => mainWindow, openWindow: () => mainWindow })
    } catch (error) {
      console.warn('[runtime-window-lifecycle] focusWindow failed', error)
    }
  }
  runtime.setNotifier({
    worktreesChanged: (repoId, renamed) => {
      // Why: clear scan caches before the renderer handles this event, so it can't read stale TTL entries after a mutation.
      runWorktreeChangeInvalidators(repoId)
      send('worktrees:changed', renamed ? { repoId, renamed } : { repoId })
    },
    worktreeBaseStatus: (event) => send('worktree:baseStatus', event),
    worktreeRemoteBranchConflict: (event) => send('worktree:remoteBranchConflict', event),
    reposChanged: () => send('repos:changed'),
    automationsChanged: (payload) => send('automations:changed', payload),
    buildReviewChanged: (payload) => send(BUILD_REVIEW_CHANGED_CHANNEL, payload),
    localRunChanged: (payload) => send(LOCAL_RUN_CHANGED_CHANNEL, payload),
    localWorkflowChanged: (payload) => send(LOCAL_WORKFLOW_CHANGED_CHANNEL, payload),
    openLocalWorkflowFind: (worktreeId, request) =>
      requestLocalWorkflowFindFromRenderer(mainWindow, worktreeId, request),
    activateWorktree: (
      repoId,
      worktreeId,
      setup?: CreateWorktreeResult['setup'],
      startup?: WorktreeStartupLaunch,
      defaultTabs?: CreateWorktreeResult['defaultTabs']
    ) => {
      send('ui:activateWorktree', {
        repoId,
        worktreeId,
        ...(setup ? { setup } : {}),
        ...(startup ? { startup } : {}),
        ...(defaultTabs ? { defaultTabs } : {})
      })
    },
    createTerminal: (worktreeId, opts) =>
      send('ui:createTerminal', {
        worktreeId,
        command: opts.command,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        title: opts.title,
        ...(opts.presentation ? { presentation: opts.presentation } : {})
      }),
    revealTerminalSession: (worktreeId, opts) =>
      new Promise((resolve, reject) => {
        const requestId = randomUUID()
        const expectedIdentity = opts.expectedProcessIdentity
          ? opts.tabId && opts.leafId
            ? { worktreeId, tabId: opts.tabId, leafId: opts.leafId, ptyId: opts.ptyId }
            : null
          : undefined
        if (expectedIdentity === null) {
          reject(new Error('terminal_reveal_identity_required'))
          return
        }
        if (
          opts.focus === true ||
          (opts.focus !== false && opts.activate !== false && opts.presentation !== 'background')
        ) {
          focusWindow()
        }
        const timer = setTimeout(() => {
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          reject(new Error('Terminal reveal timed out'))
        }, 10_000)
        const handler = (event: Electron.IpcMainEvent, reply: TerminalTabCreateReply): void => {
          // Why: requestId is renderer-supplied, so only the targeted main window may satisfy the reveal.
          if (event.sender !== mainWindow.webContents || reply.requestId !== requestId) {
            return
          }
          clearTimeout(timer)
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          if (reply.error) {
            reject(new Error(reply.error))
            return
          }
          if (
            expectedIdentity &&
            (!reply.identity ||
              reply.identity.worktreeId !== expectedIdentity.worktreeId ||
              reply.identity.tabId !== expectedIdentity.tabId ||
              reply.identity.leafId !== expectedIdentity.leafId ||
              reply.identity.ptyId !== expectedIdentity.ptyId)
          ) {
            reject(new Error('terminal_reveal_identity_mismatch'))
            return
          }
          resolve({
            tabId: reply.tabId!,
            title: reply.title,
            ...(reply.identity ? { identity: reply.identity } : {})
          })
        }
        ipcMain.on('terminal:tabCreateReply', handler)
        const sent = send('ui:createTerminal', {
          requestId,
          worktreeId,
          ptyId: opts.ptyId,
          title: opts.title ?? undefined,
          ...(opts.titleOrigin ? { titleOrigin: opts.titleOrigin } : {}),
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
          ...(opts.launchToken ? { launchToken: opts.launchToken } : {}),
          ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
          ...(opts.agentTemplate ? { agentTemplate: opts.agentTemplate } : {}),
          ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
          activate: opts.activate !== false,
          ...(opts.presentation ? { presentation: opts.presentation } : {}),
          ...(opts.surfaceOwner === false ? { surfaceOwner: false } : {}),
          // Why: pre-minted tabId aligns the renderer tab id with the paneKey baked into the PTY env, so hook events route right.
          ...(opts.tabId !== undefined ? { tabId: opts.tabId } : {}),
          ...(opts.leafId !== undefined ? { leafId: opts.leafId } : {}),
          ...(opts.splitFromLeafId !== undefined ? { splitFromLeafId: opts.splitFromLeafId } : {}),
          ...(opts.splitDirection !== undefined ? { splitDirection: opts.splitDirection } : {}),
          ...(opts.splitTelemetrySource !== undefined
            ? { splitTelemetrySource: opts.splitTelemetrySource }
            : {}),
          ...(opts.focus !== undefined ? { focus: opts.focus } : {})
        })
        if (!sent) {
          clearTimeout(timer)
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          reject(new Error('runtime_unavailable'))
        }
      }),
    resolveLegacyWorkerTerminalRecovery: (paneKey, resolution, ptyId) =>
      send('agentStatus:legacyWorkerTerminalRecovery', {
        paneKey,
        resolution,
        ...(ptyId ? { ptyId } : {})
      }),
    splitTerminal: (tabId, paneRuntimeId, opts) => {
      send('ui:splitTerminal', {
        tabId,
        paneRuntimeId,
        direction: opts.direction,
        command: opts.command,
        telemetrySource: opts.telemetrySource,
        newLeafId: opts.newLeafId
      })
    },
    renameTerminal: (tabId, title, provenance) =>
      send('ui:renameTerminal', { tabId, title, ...provenance }),
    focusTerminal: (tabId, worktreeId, leafId) => {
      focusWindow()
      send('ui:focusTerminal', { tabId, worktreeId, leafId })
    },
    focusEditorTab: (tabId, worktreeId) => send('ui:focusEditorTab', { tabId, worktreeId }),
    closeSessionTab: (tabId, worktreeId) =>
      requestSessionTabCloseFromRenderer(mainWindow, tabId, worktreeId),
    moveSessionTab: (worktreeId: string, move: RuntimeMobileSessionTabMove) =>
      send('ui:moveSessionTab', { worktreeId, ...move }),
    openFile: (worktreeId, filePath, relativePath, runtimeEnvironmentId?) =>
      send('ui:openFileFromMobile', {
        worktreeId,
        filePath,
        relativePath,
        runtimeEnvironmentId
      }),
    openDiff: (worktreeId, filePath, relativePath, staged, runtimeEnvironmentId?) =>
      send('ui:openDiffFromMobile', {
        worktreeId,
        filePath,
        relativePath,
        staged,
        runtimeEnvironmentId
      }),
    readMobileMarkdownTab: (worktreeId, tabId) =>
      requestMobileMarkdownFromRenderer(mainWindow, {
        operation: 'read',
        worktreeId,
        tabId
      }) as Promise<RuntimeMarkdownReadTabResult>,
    saveMobileMarkdownTab: (worktreeId, tabId, baseVersion, content) =>
      requestMobileMarkdownFromRenderer(mainWindow, {
        operation: 'save',
        worktreeId,
        tabId,
        baseVersion,
        content
      }) as Promise<RuntimeMarkdownSaveTabResult>,
    closeTerminal: (tabId, paneRuntimeId) => send('ui:closeTerminal', { tabId, paneRuntimeId }),
    closeTerminalTab: (tabId, options) =>
      requestTerminalTabCloseFromRenderer(mainWindow, tabId, options),
    sleepWorktree: (worktreeId) => send('ui:sleepWorktree', { worktreeId }),
    resumeSleepingAgents: (worktreeId) => send('ui:resumeSleepingAgents', { worktreeId }),
    terminalFitOverrideChanged: (ptyId, mode, cols, rows) =>
      send('runtime:terminalFitOverrideChanged', { ptyId, mode, cols, rows }),
    terminalDriverChanged: (ptyId, driver) =>
      send('runtime:terminalDriverChanged', { ptyId, driver }),
    nativeChatLaunchDraftResolved: (tabId, resolution) =>
      send('runtime:nativeChatLaunchDraftResolved', { tabId, ...resolution }),
    browserDriverChanged: (browserPageId, driver) =>
      send('runtime:browserDriverChanged', { browserPageId, driver }),
    browserRemoteViewersChanged: (browserPageId, hasRemoteViewers) =>
      send('runtime:browserRemoteViewersChanged', { browserPageId, hasRemoteViewers }),
    clientHostedBrowserRowsChanged: (event) => send('runtime:clientHostedBrowserRowsChanged', event)
  })
  registerRendererDocumentNavigation(mainWebContents, () => {
    rendererNotifications.onMainFrameReloadStarted()
    const fence = runtime.markRendererReloading(mainWindow.id)
    return () => {
      if (fence && runtime.markRendererReloadCancelled(mainWindow.id, fence)) {
        rendererNotifications.onMainFrameReloadCancelled()
      }
    }
  })
  mainWebContents.on('did-finish-load', () => {
    rendererNotifications.onMainFrameLoadFinished()
  })
  mainWebContents.on('render-process-gone', () => {
    rendererNotifications.onRendererProcessGone()
  })
  mainWindow.on('closed', () => {
    unregisterAccessibleWindow()
    unregisterSelfTargetAccessibility()
    rendererNotifications.close()
    runtime.markGraphUnavailable(mainWindow.id)
    if (activeRuntimeNotifierToken === notifierToken) {
      // Why: the notifier closes over the window; clear it in the no-window gap so the runtime can't retain destroyed graphs.
      runtime.setNotifier(null)
      activeRuntimeNotifierToken = null
    }
  })
}
