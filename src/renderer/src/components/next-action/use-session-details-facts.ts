import { sessionAgentTemplateView } from '../../../../shared/session-agent-template'
import { recordedSessionAgentTemplate } from '@/lib/session-agent-template-record'
import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionTask } from '@/store/session-task-store'
import { conversationViewKey } from '@/lib/conversation-view'
import { sessionRowFolderId } from '@/lib/mirrored-conversation-folders'
import { SAVED_SESSIONS_FOLDER_ID } from '@/lib/session-folders'
import {
  sidebarSessionSourceIdentity,
  sidebarSessionStatusKey
} from '@/lib/sidebar-session-source-identity'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sessionHostLabel } from '@/components/sidebar/session-folders/session-technical-detail'
import { nextStepAgentName } from '@/components/next-step/next-step-summary'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  agentBadgeState,
  sessionDetailsMore,
  type SessionDetailsFacts
} from './session-details-facts'

/**
 * Every fact Session details shows, read from what the app already stores: no RPC, no probe, and
 * nothing written. The agent's exact reported state travels beside the badge so the four-word
 * vocabulary loses nothing.
 */
export function useSessionDetailsFacts(
  session: SidebarSession,
  chain: SessionChain | null
): SessionDetailsFacts {
  const statusKey = sidebarSessionStatusKey(session)
  const status = useAppStore((state) =>
    statusKey ? state.agentStatusByPaneKey[statusKey] : undefined
  )
  const changedFiles = useAppStore(
    (state) => state.gitStatusByWorktree[session.worktreeId]?.length ?? 0
  )
  const sshTargetLabels = useAppStore((state) => state.sshTargetLabels)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const worktree = useAppStore((state) => state.getKnownWorktreeById(session.worktreeId))
  const folderMetadata = useSessionFolders((state) => state.metadata)
  const recordedTemplate = useAppStore((state) => recordedSessionAgentTemplate(state, session))
  const templateSettings = useAppStore((state) => state.settings?.agentTemplates)
  const agentTemplate = useMemo(
    () => sessionAgentTemplateView(recordedTemplate, templateSettings),
    [recordedTemplate, templateSettings]
  )
  const link = useSessionTask(sidebarSessionSourceIdentity(session)?.sourceKey ?? null)
  const hostLabel = sessionHostLabel(session, sshTargetLabels, runtimeEnvironments)
  const branch = worktree?.branch ?? null
  const workspacePath = worktree?.path ?? null
  // Why the tree's resolver (C3): a paired owner's explicit folder places its row, named from the
  // owner's catalog when this computer has not received the folder yet.
  const folderId = sessionRowFolderId(folderMetadata, session, conversationViewKey(session))
  const ownerFolder = session.mirroredConversation?.folderByOwner
  const folderName =
    folderId === SAVED_SESSIONS_FOLDER_ID
      ? translate('conversations.savedSessions', 'Saved Sessions')
      : (folderMetadata.folders.find((folder) => folder.id === folderId)?.name ??
        (ownerFolder && ownerFolder.id === folderId ? ownerFolder.name : null))
  const agentState = agentBadgeState(session, status)
  const statusState = status?.state ?? null
  const taskId = link?.taskId ?? null
  const taskTitle = link?.title ?? null
  return useMemo(
    () => ({
      session,
      agent: {
        name: nextStepAgentName(session.agent as TuiAgent),
        state: agentState,
        detail: statusState
      },
      agentTemplate,
      runsOn: hostLabel ?? translate('nextAction.unknownLocation', 'Unknown location'),
      workspace: [session.workspaceLabel, branch].filter(Boolean).join(' · '),
      savesTo: folderName ?? workspacePath ?? translate('nextAction.none', 'none'),
      savesToFolder: folderName !== null,
      task: taskId ? { id: taskId, title: taskTitle ?? taskId } : null,
      more: sessionDetailsMore(chain, changedFiles)
    }),
    [
      session,
      agentState,
      statusState,
      agentTemplate,
      hostLabel,
      branch,
      workspacePath,
      folderName,
      taskId,
      taskTitle,
      chain,
      changedFiles
    ]
  )
}
