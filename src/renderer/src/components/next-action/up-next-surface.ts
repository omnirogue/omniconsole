import { useAppStore } from '@/store'
import { buildPaneSessions, type SidebarSession } from '@/lib/sidebar-sessions'
import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import { findTerminalHandleTarget } from '@/components/terminal-pane/terminal-handle-links'
import { readWhenFinished, scheduleWhenFinished } from '@/lib/session-when-finished'
import { launchNextStepAgent } from '@/components/next-step/next-step-agent-launch'
import { createNextStepCard, nextStepCardTitle } from '@/components/next-step/next-step-task-create'
import {
  nextStepSubjectTitle,
  type NextStepSubject
} from '@/components/next-step/next-step-subject'
import { UP_NEXT_WRITE_UNAVAILABLE } from '../../../../shared/up-next-types'
import type { ConversationSource } from '../../../../shared/conversation-source'
import { conversationSourcesEqual } from '../../../../shared/conversation-source'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { SessionOutcomeRuntimeTarget } from '../../../../shared/session-outcome-routing'
import type { UpNextSurface } from './up-next-commit'

function waitForConversation(worktreeId: string, tabId: string): Promise<ConversationSource> {
  return new Promise((resolve, reject) => {
    const read = () =>
      buildPaneSessions(useAppStore.getState()).find(
        (session) => session.worktreeId === worktreeId && session.tabId === tabId
      )
    const check = () => {
      const session = read()
      const source = session && conversationSourceForSession(session)
      if (source) {
        clearTimeout(timer)
        unsubscribe()
        resolve(source)
      }
    }
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(UP_NEXT_WRITE_UNAVAILABLE))
    }, 60000)
    const unsubscribe = useAppStore.subscribe(check)
    check()
  })
}

/** The sidebar session one conversation IS; a pane this window cannot name is refused. */
function sessionFor(
  source: ConversationSource,
  owner: SessionOutcomeRuntimeTarget
): SidebarSession {
  const hostId = owner.kind === 'local' ? 'local' : toRuntimeExecutionHostId(owner.environmentId)
  const session = buildPaneSessions(useAppStore.getState()).find((entry) => {
    const candidate = conversationSourceForSession(entry, hostId)
    return candidate && conversationSourcesEqual(candidate, source)
  })
  if (!session) {
    throw new Error(UP_NEXT_WRITE_UNAVAILABLE)
  }
  return session
}

export function upNextSurface(
  subject?: NextStepSubject,
  owner: SessionOutcomeRuntimeTarget = { kind: 'local' }
): UpNextSurface {
  const cards = new Map<string, string>()
  let launchedTab: { worktreeId: string; tabId: string } | undefined
  let operationId: string | undefined
  let launch: Promise<ConversationSource> | undefined
  return {
    start: () => {
      if (launch) {
        return launch
      }
      if (launchedTab) {
        return waitForConversation(launchedTab.worktreeId, launchedTab.tabId)
      }
      launch = new Promise<ConversationSource>((resolve, reject) => {
        const state = useAppStore.getState()
        const agent = state.settings?.defaultTuiAgent
        if (
          !subject ||
          (subject.kind !== 'thread' && subject.kind !== 'card') ||
          !agent ||
          agent === 'blank' ||
          (subject.kind === 'thread' &&
            subject.viewer !== subject.detail.thread.recipient_employee_id)
        ) {
          reject(new Error(UP_NEXT_WRITE_UNAVAILABLE))
          return
        }
        const onLaunched = (worktreeId: string, tabId: string) => {
          launchedTab = { worktreeId, tabId }
          void waitForConversation(worktreeId, tabId).then(resolve, reject)
        }
        const result = launchNextStepAgent(
          subject,
          {
            kind: 'agent',
            key: 'up-next',
            presetId: null,
            rounds: 1,
            agent,
            instructions: nextStepSubjectTitle(subject)
          },
          (operationId ??= crypto.randomUUID()),
          {
            onLaunched,
            onCancelled: () => {
              launch = undefined
              reject(new Error(UP_NEXT_WRITE_UNAVAILABLE))
            },
            onStarted: (execution) => {
              const target =
                execution.terminalHandle &&
                findTerminalHandleTarget(execution.terminalHandle, useAppStore.getState(), null)
              if (target) {
                onLaunched(target.worktreeId, target.tabId)
              } else {
                reject(new Error(UP_NEXT_WRITE_UNAVAILABLE))
              }
            }
          }
        )
        if (!result.ok) {
          reject(new Error(result.message))
        }
      }).catch((error: unknown) => {
        launch = undefined
        throw error
      })
      return launch
    },
    readFinish: (source) => {
      try {
        return readWhenFinished(sessionFor(source, owner))
      } catch {
        return undefined
      }
    },
    scheduleFinish: (choice, source) => scheduleWhenFinished(sessionFor(source, owner), choice),
    // Older hosts still return a finish intent from a Done draft. Schedule it; never finish now.
    finish: async (choice, source) => scheduleWhenFinished(sessionFor(source, owner), choice),
    createCard: async (block, source) => {
      const existing = cards.get(block.id)
      if (existing) {
        return existing
      }
      const session = sessionFor(source, owner)
      const note = block.receive.note ?? ''
      const created = await createNextStepCard(
        session,
        nextStepCardTitle({ note }, session.label),
        note,
        'best-effort'
      )
      if ('refusal' in created) {
        throw new Error(created.refusal)
      }
      cards.set(block.id, created.task.id)
      return created.task.id
    }
  }
}
