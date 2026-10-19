/**
 * Wires the hook-first answer pilot: one answer inbox shared by the hook listener (which carries
 * answers in replies) and the work-delivery claimer (which offers them). With the setting off no
 * answer is carried (earlier injections still confirm), and answers never carried are typed.
 */

import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentHookServer } from '../agent-hooks/server'
import type { WorkPane } from '../work-delivery/work-delivery-claimer-types'
import { AnswerInbox, type HolderIdentity } from './answer-inbox'
import {
  answerDeliveryPilotLog,
  readHookFirstSnapshot,
  writeHookFirstSnapshot
} from './answer-inbox-files'
import { HookFirstRouter } from './hook-first-router'
import { createHookAnswerReplies } from './hook-answer-reply'

const TICK_MS = 5_000

export function hookFirstAnswersEnabled(settings: Partial<GlobalSettings> | null | undefined) {
  return settings?.answerDelivery?.hookFirst === true
}

export function installHookFirstAnswers(input: {
  userDataPath: string
  settings: () => Partial<GlobalSettings> | null | undefined
  hookServer: Pick<AgentHookServer, 'setAnswerReplyProvider'>
  cancelQueued?: (pane: WorkPane, id: string) => void
  holderIdentity?: (pane: WorkPane) => Promise<HolderIdentity | null>
}): { router: HookFirstRouter; stop(): void } {
  let router: HookFirstRouter | null = null
  let pending = false
  const saveNow = () => {
    pending = false
    if (router) {
      writeHookFirstSnapshot(input.userDataPath, router.snapshot())
    }
  }
  const save = (urgent: boolean) => {
    if (urgent) {
      saveNow()
    } else if (!pending) {
      pending = true
      setImmediate(() => pending && saveNow())
    }
  }
  const enabled = () => hookFirstAnswersEnabled(input.settings())
  const inbox = new AnswerInbox({ onChange: (item) => router?.noteItemChange(item) })
  const log = answerDeliveryPilotLog(input.userDataPath)
  const created = new HookFirstRouter({
    inbox,
    enabled,
    log: (record) => void log(record),
    onChange: save,
    cancelQueued: input.cancelQueued,
    holderIdentity: input.holderIdentity
  })
  router = created
  const snapshot = readHookFirstSnapshot(input.userDataPath)
  if (snapshot) {
    created.restore(snapshot)
  }
  input.hookServer.setAnswerReplyProvider(createHookAnswerReplies(inbox, { enabled }))
  const timer = setInterval(() => {
    void created.tick().catch((error) => console.warn('[answer-inbox] tick failed', error))
  }, TICK_MS)
  timer.unref?.()
  return {
    router: created,
    stop: () => {
      clearInterval(timer)
      input.hookServer.setAnswerReplyProvider(null)
      // Why: a route the claimer already reported as queued must be on disk at the next start.
      if (pending || snapshot || !inbox.isEmpty() || created.snapshot().routes.length > 0) {
        saveNow()
      }
    }
  }
}
