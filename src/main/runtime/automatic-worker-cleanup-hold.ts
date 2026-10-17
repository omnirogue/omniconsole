import {
  automaticSessionCleanupKeep,
  normalizeAutomaticSessionCleanupProtection
} from '../../shared/automatic-session-cleanup-protection'
import {
  paneSessionFolderKey,
  providerSessionFolderKey
} from '../../shared/session-folder-identity'
import { hasOpenQuestion } from '../answer-delivery/answer-wait'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { readSidebarRows } from '../session-manage/session-manage-runtime-actions'
import { sessionOrganizationHostFor } from '../session-organization/host-organization-instance'
import type { OrcaRuntimeService } from './omni-runtime'

/** Only an explicit future worker disposal contract may ignore the started-today idle hold. */
export async function readAutomaticWorkerCleanupHold(
  runtime: OrcaRuntimeService,
  target: { worktreeId: string; paneKey?: string },
  // Why opt-in: only a close of this exact session checks its own open Question (item 4).
  options: { questionWait?: boolean } = {}
): Promise<string | null> {
  try {
    const raw = runtime.getHeadlessSleepSettings().automaticSessionCleanupProtection
    const configured = normalizeAutomaticSessionCleanupProtection(raw)
    if (!configured && raw != null) {
      return 'protection-unconfigured'
    }
    // Finite workers still require all owner facts; an absent idle-cleanup setting adds no protection paths.
    const config = {
      protectedWorkspacePaths: [],
      protectedPaneKeys: [],
      timeZone: 'UTC',
      ...configured,
      protectStartedToday: false
    }
    const worktreePath = await runtime.resolveConversationCapacityWorkspace({
      kind: 'pty',
      worktreeId: target.worktreeId,
      paneKey: target.paneKey ?? 'prospective-disposable-worker'
    })
    const now = Date.now()
    // Before a new terminal exists, only its workspace has an identity to protect.
    if (!target.paneKey) {
      return automaticSessionCleanupKeep({
        config,
        target: { worktreePath, paneKey: 'prospective-disposable-worker', createdAt: now },
        facts: { routine: false, pinned: false, saved: false },
        now
      })
    }
    const tab = runtime.getAutomaticCleanupTab(target.worktreeId, target.paneKey)
    if (!tab) {
      return 'protection-unknown'
    }
    const routine =
      runtime.listAutomations().some((automation) => {
        const binding = automation.conversation
        return binding && (binding.paneKey === target.paneKey || binding.tabId === tab.id)
      }) ||
      runtime
        .listAutomationRuns()
        .some((run) => run.terminalPaneKey === target.paneKey || run.terminalSessionId === tab.id)
    let saved: boolean | null = null
    let liveFolderId: string | null = null
    let pinned = tab.isPinned === true
    try {
      const row = (await readSidebarRows(runtime)).find(
        (candidate) =>
          candidate.hostId === 'local' &&
          candidate.worktreeId === target.worktreeId &&
          candidate.paneKey === target.paneKey
      )
      if (row) {
        saved = row.saved
        liveFolderId = row.folderId
        pinned ||= row.pinned
      }
    } catch {
      /* The owner ledger below also works when no window is attached. */
    }
    const host = sessionOrganizationHostFor(getProfileUserDataPath())
    await host.ready
    const keys = [paneSessionFolderKey('local', target.worktreeId, target.paneKey)]
    const hook = runtime.getLastAgentHookRowForPane(target.paneKey)
    if (hook?.providerSession && hook.agentType) {
      keys.push(
        providerSessionFolderKey({
          hostId: 'local',
          worktreeId: target.worktreeId,
          agent: hook.agentType,
          providerSession: hook.providerSession
        })
      )
    }
    const answerWait =
      options.questionWait === true &&
      hasOpenQuestion({
        paneKey: target.paneKey,
        worktreeId: target.worktreeId,
        providerSessionId: hook?.providerSession?.id ?? null
      })
    const organization = host.read(keys)
    if (organization.sessions.some((entry) => entry.pending.length)) {
      return 'protection-unknown'
    }
    if (
      saved === false &&
      organization.sessions.some(
        (entry) => entry.values.placement != null && entry.values.placement !== liveFolderId
      )
    ) {
      return 'protection-unknown'
    }
    if (saved === null && organization.migratedAt) {
      // Folder ancestry belongs to the window; retain every filed headless conversation.
      saved = organization.sessions.some((entry) => entry.values.placement != null)
    }
    return automaticSessionCleanupKeep({
      config,
      target: { worktreePath, paneKey: target.paneKey, createdAt: tab.createdAt },
      facts: { routine, pinned, saved, answerWait },
      now
    })
  } catch {
    return 'protection-unknown'
  }
}
