/**
 * `sessionHost.observe`: this host's registry, joined with what its executor can see live. Only the
 * process that runs a conversation may call it `live` or `exited`; any other row, and every row the
 * executor did not answer for, is `unverifiable` and makes the listing incomplete.
 */

import type {
  SessionHostObservation,
  SessionHostObserveParams,
  SessionHostObserveResult
} from '../../shared/session-host-protocol'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import { sessionHostObservedAdmission } from './session-host-admission-facts'
import type { SessionHostAdmissionStore } from './session-host-admission-store'
import type { SessionHostExecutor, SessionHostLiveObservation } from './session-host-executor'
import type { SessionHostJournal, SessionHostRegistration } from './session-host-journal'

const OBSERVE_TIMEOUT_MS = 10_000

async function liveObservations(
  executor: SessionHostExecutor,
  registrations: readonly SessionHostRegistration[],
  includeArchived: boolean
): Promise<ReadonlyMap<string, SessionHostLiveObservation>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ReadonlyMap<string, SessionHostLiveObservation>>((resolve) => {
    timer = setTimeout(() => resolve(new Map()), OBSERVE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      executor.observe(registrations, { includeArchived }).catch(() => new Map()),
      timeout
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Bounded and best effort: the listing still answers with what the registry already holds. */
async function registerBeforeObserve(executor: SessionHostExecutor): Promise<void> {
  if (!executor.register) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, OBSERVE_TIMEOUT_MS)
  })
  try {
    await Promise.race([executor.register().catch(() => {}), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A registration an earlier process left that nothing here addresses now: its controller is gone
 * and the executor matched no session to it (the pane closed, or holds a newer conversation).
 * Registrations are never deleted, so without this every past session reads as an unverifiable
 * one this host still carries. One the executor did not answer for, or that a live process
 * controls, stays listed.
 */
function leftBehind(
  journal: SessionHostJournal,
  registration: SessionHostRegistration,
  seen: SessionHostLiveObservation | undefined
): boolean {
  const controllerGone =
    registration.controller === null || !journal.controllers[registration.controller]
  return controllerGone && seen !== undefined && !seen.ref && !seen.entry
}

export async function observeSessionHost(input: {
  store: SessionHostAdmissionStore
  executor: SessionHostExecutor
  admissionOpen: boolean
  params: SessionHostObserveParams
}): Promise<SessionHostObserveResult> {
  const { store, params } = input
  // Why: a session started since the host's last pass is otherwise unlisted, so another computer's
  // control on it is refused as unknown until the next one.
  await registerBeforeObserve(input.executor)
  const journal = store.snapshot()
  if (!journal) {
    return {
      status: 'refused',
      refusal: sessionHostRefusal(
        'storage-unavailable',
        "That computer's session records are unreadable, so it cannot say what it runs."
      )
    }
  }
  const wanted = params.conversationIds ? new Set(params.conversationIds) : null
  const owned = Object.values(journal.conversations).filter(
    (registration) => registration.owned && (!wanted || wanted.has(registration.conversationId))
  )
  const live = await liveObservations(input.executor, owned, params.includeArchived === true)
  // Why not when asked by id: a caller fencing one conversation gets its record, however old.
  const registrations = wanted
    ? owned
    : owned.filter(
        (registration) => !leftBehind(journal, registration, live.get(registration.conversationId))
      )
  const self = store.host.incarnation
  const sessions: SessionHostObservation[] = []
  for (const registration of registrations) {
    const seen = live.get(registration.conversationId)
    if (seen?.archived && !params.includeArchived) {
      continue
    }
    const runsHere = registration.controller === self
    const turnRevision = seen?.turnRevision ?? null
    const { status, holder } = sessionHostObservedAdmission({
      journal,
      registration,
      turnRevision,
      admissionOpen: input.admissionOpen,
      controller: self,
      automationDisabled: seen?.automationDisabled === true
    })
    sessions.push({
      conversationId: registration.conversationId,
      ownerEpoch: registration.ownerEpoch,
      turnRevision,
      ...(seen?.organizationRevision ? { organizationRevision: seen.organizationRevision } : {}),
      verdict: runsHere && seen ? seen.verdict : 'unverifiable',
      admission: status,
      ...(holder
        ? {
            reservation: {
              operationId: holder.operationId,
              action: holder.action,
              state: holder.state
            }
          }
        : {}),
      provider: registration.provider,
      ref: {
        hostId: store.host.hostId,
        conversationId: registration.conversationId,
        paneKey: seen?.ref?.paneKey ?? registration.binding?.paneKey ?? null,
        tabId: seen?.ref?.tabId ?? null,
        worktreePath: seen?.ref?.worktreePath ?? registration.workspace?.path ?? null
      },
      ...(seen?.entry ? { entry: seen.entry } : {})
    })
  }
  return {
    status: 'ok',
    host: store.host,
    observedAt: store.now(),
    complete:
      input.admissionOpen &&
      registrations.every(
        (registration) => registration.controller === self && live.has(registration.conversationId)
      ),
    sessions
  }
}
