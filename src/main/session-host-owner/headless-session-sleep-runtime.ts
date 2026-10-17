import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { SessionHostAdmissionStore } from '../session-host/session-host-admission-store'
import type { HostSessionInventory } from './host-session-inventory'
import { createHeadlessSessionSleep } from './headless-session-sleep'
import { hostAutomationRefusal } from './session-host-switches'
import { runtimeArchiveSleepHostDeps } from '../runtime/archive-sleep-host-runtime'
import { readArchiveSleepHost } from '../runtime/archive-sleep-host-reading'
import { sessionActionsLogFor } from '../session-manage/session-actions-log'
import { IDLE_RULE } from '../../shared/idle-auto-close-settings'
import { sessionOrganizationHostFor } from '../session-organization/host-organization-instance'
import {
  snapshotRuntimeLatestTurn,
  runtimeNeverReplied
} from '../session-manage/session-manage-runtime-sources'
import { sessionHostTurnRevision } from './session-host-turn'
import {
  listReviewSleepEntries,
  listReviewSleepTargets,
  noteReviewSessionAsleep
} from '../artifacts/artifact-review-sleep-targets'

export function runtimeHeadlessSessionSleep(input: {
  runtime: OrcaRuntimeService
  inventory: HostSessionInventory
  userDataPath: string
  enabled(): boolean
  store(): SessionHostAdmissionStore | null
}) {
  const { runtime, inventory, userDataPath } = input
  return createHeadlessSessionSleep({
    enabled: input.enabled,
    settings: () => runtime.getHeadlessSleepSettings(),
    authority: (row) => {
      const journal = input.store()?.snapshot()
      const registration = Object.values(journal?.conversations ?? {}).find(
        (entry) =>
          entry.binding?.paneKey === row.paneKey && entry.binding?.worktreeId === row.worktreeId
      )
      if (
        !journal ||
        !registration?.owned ||
        !registration.adopted ||
        registration.controller !== runtime.getRuntimeId()
      ) {
        return null
      }
      if (
        Object.values(journal.reservations).some(
          (hold) => hold.conversationId === registration.conversationId && hold.state === 'held'
        )
      ) {
        return null
      }
      if (
        Object.values(journal.operations).some(
          (operation) =>
            operation.conversationId === registration.conversationId &&
            ['admitted', 'dispatched', 'unconfirmed'].includes(operation.state)
        )
      ) {
        return null
      }
      const turn =
        registration.binding &&
        sessionHostTurnRevision(
          snapshotRuntimeLatestTurn(registration.binding, runtimeNeverReplied(runtime))
        )
      return turn
        ? JSON.stringify([registration.ownerEpoch, registration.processIncarnation, turn])
        : null
    },
    read: async (row) => {
      const host = sessionOrganizationHostFor(userDataPath)
      if (!host) {
        return null
      }
      await host.ready
      const organization = host.read([row.viewKey])
      const current = organization.sessions[0]
      if (
        !organization.migratedAt ||
        !current ||
        current.pending.length ||
        !Object.hasOwn(current.values, 'placement')
      ) {
        return null
      }
      // Folder ancestry is window-owned; a nonempty headless placement is conservatively retained.
      const saved = row.saved || current.values.placement !== null
      return runtime.readHeadlessSleepSnapshot({ ...row, saved })
    },
    reviewTargets: () =>
      new Map(
        listReviewSleepTargets(
          runtime.getHeadlessSleepSettings(),
          listReviewSleepEntries(runtime.getArtifactApiOrigin())
        ).map((target) => [target.paneKey, target])
      ),
    reviewSlept: (row) => {
      if (row.paneKey) {
        noteReviewSessionAsleep(
          { paneKey: row.paneKey, worktreeId: row.worktreeId },
          runtime.getArtifactApiOrigin()
        )
      }
    },
    clear: async (row, options) => {
      if (!row.paneKey || !row.tabId || hostAutomationRefusal(row.folderId)) {
        return null
      }
      const observed = await inventory.read(row)
      if (
        observed.entry.verdict !== 'live' ||
        observed.entry.agentForeground !== true ||
        observed.entry.state !== 'idle' ||
        observed.entry.queueLength ||
        observed.entry.keepGoing ||
        observed.entry.pendingSteps.length
      ) {
        return null
      }
      const reading = await readArchiveSleepHost(
        {
          ...runtimeArchiveSleepHostDeps(runtime),
          rows: async () => (await inventory.rows()).rows
        },
        { worktreeId: row.worktreeId, paneKey: row.paneKey, tabId: row.tabId },
        { reviewWait: options?.reviewWait === true }
      )
      return reading.clear ? observed.agentProcess : null
    },
    sleep: (snapshot, guard, proof) => runtime.sleepHeadlessSession(snapshot, guard, proof),
    audit: async (snapshot, outcome) => {
      await sessionActionsLogFor(userDataPath).append({
        actor: 'hibernation',
        action: 'hibernation.sleep',
        target: { paneKey: snapshot.row.paneKey, tabId: snapshot.row.tabId },
        summary: `Headless owner sleep: ${outcome}`,
        reason: IDLE_RULE.R1,
        hibernation: {
          rule: IDLE_RULE.R1,
          mode: outcome === 'would' ? 'shadow' : 'on',
          outcome,
          evidence: {
            executionHost: 'local',
            ptyId: snapshot.ptyId,
            incarnationId: snapshot.incarnationId
          }
        }
      })
    },
    now: () => Date.now()
  })
}
