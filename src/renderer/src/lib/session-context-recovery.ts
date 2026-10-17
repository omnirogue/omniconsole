import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { buildPaneSessions } from './sidebar-sessions'
import {
  getSessionContext,
  sessionContextKey,
  consumeSessionContextLaunch
} from './session-context-store'
import { deliverSessionContext } from './session-context-delivery'
import { migrateLaunchSessionContext } from './launch-session-context'
import { upNextAddressForSession } from './up-next-address'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  sessionContextText,
  type SessionContextAttachment
} from '../../../shared/session-context-attachments'

type RecoveryAttempt = {
  items: readonly SessionContextAttachment[]
  pending: boolean
  failures: number
  timer?: ReturnType<typeof setTimeout>
}

async function recoveryId(generation: string, items: readonly SessionContextAttachment[]) {
  const bytes = new TextEncoder().encode(JSON.stringify([generation, sessionContextText(items)]))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return `context-recovery:${Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`
}

function scheduleRecoveryRetry(attempt: RecoveryAttempt, retry: () => void) {
  return setTimeout(
    () => {
      attempt.timer = undefined
      retry()
    },
    Math.min(60_000, 1_500 * 2 ** Math.min(attempt.failures, 6))
  )
}

/** A new process gets saved attachments even when the person continues in its native TUI. */
export function useSessionContextRecovery(): void {
  useEffect(() => {
    const observed = new Set<string>()
    const attempts = new Map<string, RecoveryAttempt>()
    let active = true
    const reconcile = () => {
      if (!active) {
        return
      }
      const state = useAppStore.getState()
      const current = new Set<string>()
      for (const session of buildPaneSessions(state)) {
        if (!session.tabId || session.unavailable || !session.hostId) {
          continue
        }
        if (session.kind === 'terminal' && !session.providerSession) {
          continue
        }
        const key = sessionContextKey(session)
        const items = getSessionContext(key)
        if (!items.length) {
          continue
        }
        const pane = session.paneKey ? parsePaneKey(session.paneKey) : null
        const pty = pane
          ? state.terminalLayoutsByTabId[session.tabId]?.ptyIdsByLeafId?.[pane.leafId]
          : null
        if (!pty && session.kind !== 'structured') {
          continue
        }
        const generation = JSON.stringify([key, pty ?? session.structuredSessionId])
        current.add(generation)
        if (observed.has(generation)) {
          continue
        }
        if (consumeSessionContextLaunch(session.tabId)) {
          observed.add(generation)
          continue
        }
        if (!upNextAddressForSession(session)) {
          observed.add(generation)
          continue
        }
        let attempt = attempts.get(generation)
        if (!attempt || attempt.items !== items) {
          clearTimeout(attempt?.timer)
          attempt = { items, pending: false, failures: 0 }
          attempts.set(generation, attempt)
        }
        if (attempt.pending || attempt.timer) {
          continue
        }
        const running = attempt
        running.pending = true
        void recoveryId(generation, items)
          .then((id) => {
            if (!active || attempts.get(generation) !== running) {
              return
            }
            if (getSessionContext(key) !== items) {
              attempts.delete(generation)
              queueMicrotask(reconcile)
              return
            }
            return deliverSessionContext(session, key, { id })
          })
          .then((result) => {
            if (active && attempts.get(generation) === running) {
              if (result !== 'queued') {
                throw new Error('Session context delivery is not ready.')
              }
              observed.add(generation)
              attempts.delete(generation)
            }
          })
          .catch(() => {
            if (!active || attempts.get(generation) !== running) {
              return
            }
            running.pending = false
            running.failures += 1
            if (running.failures === 3) {
              toast.error(
                translate(
                  'sessionContext.recoveryRetry',
                  'Saved context is kept. Delivery will retry when this session is ready.'
                ),
                {
                  id: `context-recovery:${key}`
                }
              )
            }
            running.timer = scheduleRecoveryRetry(running, reconcile)
          })
      }
      for (const [generation, attempt] of attempts) {
        if (!current.has(generation)) {
          clearTimeout(attempt.timer)
          attempts.delete(generation)
        }
      }
    }
    // Why at start: launcher context saved before it became one-shot must not reach new sessions.
    migrateLaunchSessionContext()
    // Establish identity migration before observing provider publications.
    getSessionContext('')
    reconcile()
    const stop = useAppStore.subscribe((state, before) => {
      if (
        state.agentStatusByPaneKey !== before.agentStatusByPaneKey ||
        state.terminalLayoutsByTabId !== before.terminalLayoutsByTabId ||
        state.unifiedTabsByWorktree !== before.unifiedTabsByWorktree ||
        state.activeOrcaProfileId !== before.activeOrcaProfileId ||
        state.orcaProfileAuthStatus !== before.orcaProfileAuthStatus ||
        state.settings !== before.settings
      ) {
        queueMicrotask(reconcile)
      }
    })
    return () => {
      active = false
      stop()
      for (const attempt of attempts.values()) {
        clearTimeout(attempt.timer)
      }
      attempts.clear()
    }
  }, [])
}
