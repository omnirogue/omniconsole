/**
 * Starts this desktop's work-delivery claimer: every 15 s it asks OmniOS for replies owed to
 * sessions on this computer (Jira replies, review decisions, Question answers, the person's own
 * messages sent from an app) and delivers them.
 */

import type { ArtifactCloudService } from '../artifacts/artifact-cloud-service'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { clearClaimerPolled, noteClaimerPolled } from '../answer-delivery/answer-delivery-handover'
import { answerLoginGate } from '../answer-delivery/answer-login-gate'
import { loginCutOf } from '../answer-delivery/login-killed-turns'
import { questionDeliveryAdapter } from '../answer-delivery/question-delivery-adapter'
import { reviewDeliveryAdapter } from '../answer-delivery/review-delivery-adapter'
import { agentHookServer } from '../agent-hooks/server'
import { installHookFirstAnswers } from '../answer-inbox/answer-inbox-install'
import { answerInboxRuntime } from '../answer-inbox/answer-inbox-runtime'
import { reviewHostLabel } from '../artifacts/artifact-source-state-report'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { readSidebarRows } from '../session-manage/session-manage-runtime-actions'
import { workDeliveryApi, type WorkDeliveryApi } from './work-delivery-api'
import { autoBindListener } from './work-delivery-autobind'
import { bindWorkOwner, installWorkBinder } from './work-delivery-bind'
import { WorkDeliveryClaimer } from './work-delivery-claimer'
import { jiraWorkDeliveryAdapter } from './work-delivery-jira'
import { messageDeliveryAdapter } from './message-delivery-adapter'
import type { WorkDeliveryKind, WorkDeliveryKindAdapter } from './work-delivery-kind'
import { runtimeWorkDeliveryDeps } from './work-delivery-runtime'

const PASS_MS = 15_000

/** Each listing OmniOS answered tells the older answer paths the claimer is taking its kinds. */
function claimerPollNoted(api: WorkDeliveryApi): WorkDeliveryApi {
  return {
    ...api,
    claimable: async (hostId, hostLabel, caps) => {
      const listed = await api.claimable(hostId, hostLabel, caps)
      if (listed.status === 'ok') {
        noteClaimerPolled(caps)
      }
      return listed
    }
  }
}

export function installWorkDelivery(
  service: ArtifactCloudService,
  userDataPath: string,
  runtime: OrcaRuntimeService,
  /** Reads answerDelivery.hookFirst; absent keeps every delivery on the typed path. */
  settings?: () => Partial<GlobalSettings> | null | undefined
): () => void {
  if (process.env.OMNI_WORK_DELIVERY === '0') {
    return () => {}
  }
  const adapters = new Map<WorkDeliveryKind, WorkDeliveryKindAdapter>([
    ['jira', jiraWorkDeliveryAdapter],
    ['review', reviewDeliveryAdapter(service, userDataPath)],
    ['question', questionDeliveryAdapter(userDataPath)],
    ['message', messageDeliveryAdapter(userDataPath)]
  ])
  // Why now: the review pass and Questions round leave these answers alone from the start.
  noteClaimerPolled([...adapters.keys()])
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let unhook: (() => void) | null = null
  let hookFirst: ReturnType<typeof installHookFirstAnswers> | null = null
  void reviewHostLabel().then((hostLabel) => {
    if (stopped) {
      return
    }
    const api = claimerPollNoted(workDeliveryApi(service))
    const base = {
      ...runtimeWorkDeliveryDeps({ runtime, userDataPath, api, hostLabel, adapters }),
      loginReady: answerLoginGate(runtime),
      loginCut: (pane: { paneKey: string }, since: number) => loginCutOf(pane.paneKey, since)
    }
    hookFirst = settings
      ? installHookFirstAnswers({
          userDataPath,
          settings,
          hookServer: agentHookServer,
          ...answerInboxRuntime(runtime)
        })
      : null
    // The one routing point: hook-first wraps enqueue/resume/queue state, and passes through when off.
    const deps = hookFirst ? hookFirst.router.wrap(base) : base
    const claimer = new WorkDeliveryClaimer(deps)
    const bind = installWorkBinder((request) =>
      bindWorkOwner({ runtime, api, hostId: deps.hostId(), hostLabel }, request)
    )
    unhook = agentHookServer.subscribeEnrichedStatus(
      autoBindListener({
        bind,
        rowOf: async (paneKey) => {
          const row = (await readSidebarRows(runtime)).find(
            (candidate) => candidate.paneKey === paneKey
          )
          return row ? { worktreeId: row.worktreeId, title: row.title } : null
        }
      })
    )
    const pass = () => {
      void claimer.pass().catch((error) => console.warn('[work-delivery] pass failed:', error))
    }
    timer = setInterval(pass, PASS_MS)
    timer.unref?.()
    pass()
  })
  return () => {
    stopped = true
    clearClaimerPolled()
    installWorkBinder(null)
    unhook?.()
    hookFirst?.stop()
    if (timer) {
      clearInterval(timer)
    }
  }
}
