import { normalizeLaunchCause, type LaunchCause } from '../../shared/launch-cause'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import { attemptLaunchProvenance } from '../launch-ledger/launch-provenance-guard'
/** The real dependencies behind `omni session resume`: this runtime, its window and its disk. */

import { hostname } from 'node:os'
import type {
  SessionManageConversationOrganization,
  SessionManageRendererRequest
} from '../../shared/session-manage-relay'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { toSessionManageEntry } from './session-manage-inventory'
import { observeSession } from './session-manage-observe'
import {
  SessionResumeWorkspaceMissing,
  type SessionResumeDeps,
  type SessionResumeVerdict
} from './session-manage-resume'
import {
  readSidebarRows,
  runtimeControlDeps,
  showSessionManageNotice
} from './session-manage-runtime-actions'
import { createRuntimeObserveSources } from './session-manage-runtime-sources'
import type { OrganizationExecutor } from '../../shared/session-organization-change'
import type { SessionActionActor } from './session-actions-log'
import { sessionOrganizationLedgerFor } from '../session-organization/organization-change-ledger'
import { relayOrganizationMutation } from '../session-organization/organization-relayed-mutation'
import { locateTranscripts, readTranscriptCwd } from './session-transcript-locate'
import { confirmPaneConversation, restartWithHookProof } from './session-restart-proof'

type Runtime = Parameters<typeof readSidebarRows>[0] &
  Parameters<typeof createRuntimeObserveSources>[0] &
  Pick<
    OrcaRuntimeService,
    'ensureAgentSession' | 'showTerminal' | 'getReportedProviderSessionsForPane'
  >

function isOrganization(value: unknown): value is SessionManageConversationOrganization {
  const record = value as Partial<SessionManageConversationOrganization> | null
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.deleted === 'boolean' &&
    typeof record.hidden === 'boolean'
  )
}

async function paneKeyOf(
  runtime: Runtime,
  terminal: string,
  reported?: string | null
): Promise<string | null> {
  if (reported) {
    return reported
  }
  try {
    const { tabId, leafId } = await runtime.showTerminal(terminal)
    return tabId && leafId && !tabId.includes(':') && isTerminalLeafId(leafId)
      ? makePaneKey(tabId, leafId)
      : null
  } catch {
    return null
  }
}

/** How the window files a conversation no row may list; null when it could not say. */
export async function readConversationOrganization(
  runtime: Pick<OrcaRuntimeService, 'requestSessionFolders'>,
  reference: { hostId: string; sessionId: string }
): Promise<SessionManageConversationOrganization | null> {
  const request: SessionManageRendererRequest = {
    kind: 'conversationOrganization',
    hostId: reference.hostId,
    sessionId: reference.sessionId
  }
  const reply = await runtime.requestSessionFolders(request).catch(() => null)
  return isOrganization(reply) ? reply : null
}

export function runtimeResumeDeps(
  runtime: Runtime,
  options: {
    userDataPath: string
    signal?: AbortSignal
    launchCause?: LaunchCause
    /** A review wake's recorded model/effort, for a resume that starts from the transcript. */
    launchPreferences?: Pick<AgentLaunchPreferences, 'model' | 'effort'>
    /** Brings an archived conversation out of Archived once reopened, recorded as this app feature. */
    unarchive?: {
      feature: Extract<OrganizationExecutor, { kind: 'app' }>['feature']
      actor: SessionActionActor
      reason: string
    }
  }
): SessionResumeDeps {
  const launchCause = attemptLaunchProvenance<LaunchCause>(
    'session-resume',
    () =>
      normalizeLaunchCause(
        options.launchCause ?? { trigger: 'session-resume', actor: { kind: 'local-cli' } }
      ),
    { trigger: 'unknown' }
  )
  return {
    readRows: () => readSidebarRows(runtime),
    observe: async (row) =>
      toSessionManageEntry(await observeSession(row, createRuntimeObserveSources(runtime))),
    organization: (reference) => readConversationOrganization(runtime, reference),
    locate: (reference) =>
      locateTranscripts(reference.agent, reference.sessionId, {
        userDataPath: options.userDataPath
      }),
    transcriptCwd: (reference, path) => readTranscriptCwd(reference.agent, path),
    restart: async (row, entry) => {
      const proof = await restartWithHookProof(
        runtimeControlDeps(runtime),
        row,
        `“${entry.title}”`,
        launchCause
      )
      // Why here: the window no longer toasts a restart before its agent confirms it.
      showSessionManageNotice(runtime, { kind: 'notice', summary: proof.summary })
      return {
        dryRun: false,
        action: 'restart',
        target: { paneKey: entry.paneKey, title: entry.title },
        actor: { kind: 'cli' },
        ...proof
      }
    },
    launch: async ({ reference, transcriptPath, cwd, providerRoot, agentTemplate }) => {
      let result
      try {
        result = await runtime.ensureAgentSession(
          {
            kind: 'explicit',
            worktree: `path:${cwd}`,
            agent: reference.agent,
            providerSession: { key: 'session_id', id: reference.sessionId, transcriptPath },
            ...(options.launchPreferences ? { launchPreferences: options.launchPreferences } : {})
          },
          {
            ...(options.signal ? { signal: options.signal } : {}),
            launchCause
          },
          undefined,
          {
            revealInSidebar: true,
            ...(agentTemplate ? { agentTemplate } : {}),
            // Why Claude only: Codex pins its home from the verified transcript path at launch.
            ...(providerRoot && reference.agent === 'claude' ? { providerRoot } : {})
          }
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'selector_not_found' || message === 'selector_ambiguous') {
          throw new SessionResumeWorkspaceMissing(message)
        }
        throw error
      }
      const { terminal, disposition } = result
      return {
        terminal: terminal.handle,
        tabId: terminal.tabId ?? null,
        paneKey: await paneKeyOf(runtime, terminal.handle, terminal.paneKey),
        disposition
      }
    },
    confirm: (reference, launched): Promise<SessionResumeVerdict> => {
      let paneKey = launched.paneKey
      return confirmPaneConversation(
        runtime,
        reference,
        async () => (paneKey ??= await paneKeyOf(runtime, launched.terminal)),
        options.signal
      )
    },
    platform: process.platform,
    hostLabel: hostname(),
    ...(options.unarchive
      ? {
          unarchive: async ({ paneKey, tabId }) => {
            const { feature, actor, reason } = options.unarchive!
            await relayOrganizationMutation(
              sessionOrganizationLedgerFor(options.userDataPath),
              (request) => runtime.requestSessionFolders(request),
              {
                op: {
                  kind: 'archiveSession',
                  ...(paneKey ? { paneKey } : {}),
                  ...(tabId ? { tabId } : {}),
                  archived: false
                },
                executor: { kind: 'app', feature },
                reason,
                actor: { actor }
              }
            )
          }
        }
      : {})
  }
}
