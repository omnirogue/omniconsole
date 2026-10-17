import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getIndexedWorktreeMap } from '@/store/worktree-repo-index'
import { buildAiVaultResumeStartupForWorktree } from '@/lib/ai-vault-resume-command'
import { getAiVaultResumeWorkspaceExecutionHostId } from '@/lib/ai-vault-resume-target'
import { prepareAiVaultSessionForResume } from '@/lib/ai-vault-session-resume-preparation'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { openAiVaultSessionLogInOrca } from '@/components/right-sidebar/ai-vault-session-log-open'
import { resolveAiVaultSessionLaunchTarget } from '@/components/right-sidebar/ai-vault-session-launch-target'
import type { AiVaultSession } from '../../../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { SessionSearchHit } from '../../../../../shared/session-search-types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../../shared/workspace-scope'

type ResumeState = ReturnType<typeof useAppStore.getState>

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
}

function contains(parent: string, child: string): boolean {
  const base = trimSlash(parent)
  return child === base || child.startsWith(`${base}/`) || child.startsWith(`${base}\\`)
}

/**
 * The workspace a found conversation resumes in: the one on its host holding its folder (the
 * deepest, so a worktree wins over the repo that contains it), else the workspace in use when it
 * is on the same host.
 */
export function sessionSearchResumeWorkspace(
  state: Pick<
    ResumeState,
    'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo' | 'activeWorktreeId'
  >,
  hit: Pick<SessionSearchHit, 'cwd' | 'executionHostId'>
): string | null {
  const onHost = (id: string): boolean =>
    getAiVaultResumeWorkspaceExecutionHostId(state, id) === hit.executionHostId
  const cwd = hit.cwd ? trimSlash(hit.cwd) : null
  const workspaces = [
    ...[...getIndexedWorktreeMap(state.worktreesByRepo).values()].map((worktree) => ({
      id: worktree.id,
      path: worktree.path
    })),
    ...state.folderWorkspaces.map((folder) => ({
      id: folderWorkspaceKey(folder.id),
      path: folder.folderPath
    }))
  ]
  const holding = cwd
    ? workspaces
        .filter(
          (workspace) => workspace.path && contains(workspace.path, cwd) && onHost(workspace.id)
        )
        .sort((a, b) => b.path.length - a.path.length)
    : []
  if (holding[0]) {
    return holding[0].id
  }
  return state.activeWorktreeId && onHost(state.activeWorktreeId) ? state.activeWorktreeId : null
}

/**
 * The account home a transcript belongs to, so the resume signs in as the account that wrote
 * it: `<home>/projects/<project>/<id>.jsonl` for Claude, `<home>/sessions/…` for Codex. The
 * default homes (`.claude`, `.codex`) need no override.
 */
export function sessionSearchAccountHome(
  hit: Pick<SessionSearchHit, 'agent' | 'transcriptPath'>
): string | null {
  const marker = hit.agent === 'codex' ? '/sessions/' : '/projects/'
  const path = hit.transcriptPath.replace(/\\/g, '/')
  const at = path.lastIndexOf(marker)
  if (at <= 0) {
    return null
  }
  const home = path.slice(0, at)
  const name = home.split('/').pop()
  return name === '.claude' || name === '.codex' ? null : home
}

function activateWorkspace(workspaceId: string): void {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    activateAndRevealFolderWorkspace(scope.folderWorkspaceId)
    return
  }
  activateAndRevealWorktree(scope?.type === 'worktree' ? scope.worktreeId : workspaceId)
}

function openWithoutWorkspace(hit: SessionSearchHit): void {
  if (hit.executionHostId === 'local') {
    void openAiVaultSessionLogInOrca({ filePath: hit.transcriptPath, executionHostId: 'local' })
    return
  }
  toast.error(
    translate(
      'sessionContentSearch.openWorkspaceFirst',
      'Open a workspace on {{host}} to resume this conversation.',
      { host: hit.hostLabel }
    )
  )
}

/**
 * Opens a conversation found by search that has no row in the list: it resumes in a new tab,
 * in its own folder, as its own account, like resuming it from the session vault.
 */
export function resumeSessionSearchHit(hit: SessionSearchHit): void {
  const state = useAppStore.getState()
  const workspaceId = sessionSearchResumeWorkspace(state, hit)
  const target = resolveAiVaultSessionLaunchTarget({
    sessionFilePath: hit.transcriptPath,
    sessionExecutionHostId: hit.executionHostId as ExecutionHostId,
    activeWorktreeId: state.activeWorktreeId,
    targetWorktreeId: workspaceId ?? undefined,
    targetState: state
  })
  if (!workspaceId || target.status !== 'ready') {
    openWithoutWorkspace(hit)
    return
  }
  const home = sessionSearchAccountHome(hit)
  const session: AiVaultSession = {
    id: hit.sessionKey,
    executionHostId: hit.executionHostId as ExecutionHostId,
    agent: hit.agent,
    sessionId: hit.sessionId,
    title: hit.title,
    cwd: hit.cwd,
    branch: null,
    model: null,
    filePath: hit.transcriptPath,
    codexHome: hit.agent === 'codex' ? home : null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: new Date(hit.lastActivityAt ?? Date.now()).toISOString(),
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
  void prepareAiVaultSessionForResume(session)
    .then((prepared) => {
      const startup = buildAiVaultResumeStartupForWorktree({
        state: useAppStore.getState(),
        worktreeId: target.worktreeId,
        session: prepared,
        commandOverride: useAppStore.getState().settings?.agentCmdOverrides?.[hit.agent]
      })
      const env =
        hit.agent === 'claude' && home ? { ...startup.env, CLAUDE_CONFIG_DIR: home } : startup.env
      const launched = launchAiVaultSessionInNewTab({
        agent: hit.agent,
        worktreeId: target.worktreeId,
        ...startup,
        ...(env ? { env } : {})
      })
      if (launched.tabId === null) {
        void launched.runtimeLaunch.then((outcome) => {
          if (outcome.status === 'failed') {
            toast.error(outcome.message || resumeFailedText())
          }
        })
      }
      if (useAppStore.getState().activeWorktreeId !== target.worktreeId) {
        activateWorkspace(target.worktreeId)
      }
    })
    .catch(() => toast.error(resumeFailedText()))
}

function resumeFailedText(): string {
  return translate('sessionContentSearch.resumeFailed', 'This conversation could not be resumed.')
}
