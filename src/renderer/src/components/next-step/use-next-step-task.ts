import { useSessionTask } from '@/store/session-task-store'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import { useMemo } from 'react'
import type { FollowUpTask } from '@/components/session-follow-up/session-follow-up-draft'
import { findChainStepOutputForPane } from '@/lib/session-chain-registry'
import { useAppStore } from '@/store'
import { sessionChainStepOutputDir } from '../../../../shared/session-chain-types'
import type { SessionFollowUpDeliverables } from '../../../../shared/session-follow-up-rule'
import { nextStepSubjectTask, type NextStepSubject } from './next-step-subject'

/** Reuses existing context and output manifests; a session handoff never creates a task. */
export function useNextStepTask(subject: NextStepSubject): {
  linked: FollowUpTask | null
  workspacePath: string | null
  deliverables: SessionFollowUpDeliverables | null
} {
  const session = subject.kind === 'session' ? subject.session : null
  const worktreeId = subject.kind === 'session' ? subject.session.worktreeId : null
  const worktree = useAppStore((state) =>
    worktreeId ? state.getKnownWorktreeById(worktreeId) : undefined
  )
  // Why: the subject is a fresh object on every render; memoise on the values, not on it.
  const own = nextStepSubjectTask(subject)
  const ownId = own?.id ?? null
  const ownTitle = own?.title ?? null
  const sessionTask = useSessionTask(
    session ? (sidebarSessionSourceIdentity(session)?.sourceKey ?? null) : null
  )
  const hubTaskId = sessionTask?.workRef
    ? null
    : (sessionTask?.taskId ?? worktree?.linkedWorkItem?.hubTaskId ?? null)
  const hubTitle = sessionTask?.title ?? worktree?.linkedWorkItem?.title ?? null
  const linked = useMemo<FollowUpTask | null>(() => {
    if (ownId) {
      return { id: ownId, title: ownTitle ?? ownId }
    }
    return hubTaskId ? { id: hubTaskId, title: hubTitle ?? hubTaskId } : null
  }, [hubTaskId, hubTitle, ownId, ownTitle])
  const workspacePath = worktree?.path ?? null
  const paneKey = session?.paneKey ?? null
  const deliverables = useMemo<SessionFollowUpDeliverables | null>(() => {
    const output = paneKey ? findChainStepOutputForPane(paneKey) : null
    return output && workspacePath
      ? {
          kind: 'manifest',
          manifestPath: `${sessionChainStepOutputDir(workspacePath, output.chainId, output.stepId)}/manifest.md`
        }
      : null
  }, [paneKey, workspacePath])
  return { linked, workspacePath, deliverables }
}
