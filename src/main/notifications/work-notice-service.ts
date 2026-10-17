import { app } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Store } from '../persistence'
import { artifactApiRequest } from '../artifacts/artifact-cloud-request'
import { dispatchAppNotification } from '../ipc/notifications'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import {
  getOrcaProfileDirectory,
  getProfileUserDataPath
} from '../omni-profiles/profile-storage-paths'
import { getOrcaCloudAuthConfig } from '../omni-profiles/profile-cloud-auth-config'
import { readOrcaCloudSession } from '../omni-profiles/profile-cloud-session-store'
import { runWithFreshOrcaCloudSession } from '../omni-profiles/profile-cloud-session-refresh'
import {
  captureCloudSessionMutation,
  cloudSessionIdentity,
  isCloudSessionMutationCurrent,
  subscribeCloudSessionMutations
} from '../omni-profiles/profile-cloud-session-mutation'
import { readWorkNoticeCursor, writeWorkNoticeCursor } from './work-notice-cursor'
import { WorkNoticePoller, type WorkNoticeScope } from './work-notice-poller'

const API = 'https://console.example.com'
let stop: (() => void) | null = null

function signedInScope(): WorkNoticeScope | null {
  const userDataPath = getProfileUserDataPath()
  const active = ensureActiveOrcaProfile(userDataPath)
  const config = getOrcaCloudAuthConfig()
  if (
    !active.profile.cloud ||
    !config.configured ||
    readOrcaCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return null
  }
  // The bearer goes only to OmniOS, and only when sign-in belongs to that origin.
  for (const endpoint of [config.config.apiBaseUrl, config.config.refreshEndpoint]) {
    const url = new URL(endpoint)
    if (url.origin !== API || url.username || url.password) {
      return null
    }
  }
  const identity = cloudSessionIdentity(active.profile.id, active.profile.cloud)
  const snapshot = captureCloudSessionMutation(identity, userDataPath)
  const key = createHash('sha256').update(snapshot.identityKey).digest('hex')
  const path = join(
    getOrcaProfileDirectory(active.profile.id, userDataPath),
    `work-notice-${key}.json`
  )
  const current = (): boolean =>
    ensureActiveOrcaProfile(userDataPath).profile.id === active.profile.id &&
    readOrcaCloudSession(active.profile.id, userDataPath).status === 'found' &&
    isCloudSessionMutationCurrent(active.profile.id, userDataPath, snapshot)
  return {
    key,
    current,
    read: () => readWorkNoticeCursor(path),
    write: (cursor) => writeWorkNoticeCursor(path, cursor),
    request: async (route, throughId) => {
      if (!current()) {
        throw new Error('work_notice_account_changed')
      }
      const result = await runWithFreshOrcaCloudSession(
        config.config,
        active,
        userDataPath,
        async (session) => {
          if (!current()) {
            throw new Error('work_notice_account_changed')
          }
          return artifactApiRequest<unknown>(
            API,
            session.accessToken,
            route,
            throughId === undefined ? {} : { method: 'POST', body: { through_id: throughId } }
          )
        }
      )
      if (result.status !== 'ok' || !current()) {
        throw new Error('work_notice_account_changed')
      }
      return result.value
    }
  }
}

export function startWorkNoticePolling(store: Store): void {
  if (stop) {
    return
  }
  const poller = new WorkNoticePoller({
    enabled: () => {
      const settings = store.getSettings().notifications
      return settings.enabled && settings.workNotice
    },
    scope: signedInScope,
    dispatch: dispatchAppNotification
  })
  const tick = (): void => {
    void poller.tick()
  }
  const timer = setInterval(tick, 60_000)
  timer.unref()
  const unsubscribe = subscribeCloudSessionMutations(tick)
  stop = () => {
    poller.stop()
    clearInterval(timer)
    unsubscribe()
    stop = null
  }
  app.once('will-quit', () => stop?.())
  tick()
}
