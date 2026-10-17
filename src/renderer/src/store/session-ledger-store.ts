import { create } from 'zustand'
import { getSessionLedgerApi } from '@/lib/session-ledger-api'
import type {
  LedgerLocalSession,
  LedgerNowResult,
  SessionLedgerApi
} from '@/lib/session-ledger-types'
import { companiesApi } from '@/components/companies/companies-client'
import {
  eligibleCollisionPeer,
  type LedgerCollision
} from '@/components/sidebar/team-sessions/collision-peers'
import type { SessionLedgerState } from './session-ledger-state'
import {
  ledgerSectionRows,
  serverDay
} from '@/components/sidebar/team-sessions/session-ledger-rows'
import {
  createLocalSessionLedgerStorage,
  type SessionLedgerStorage
} from './session-ledger-storage'

async function readEmployeeId(): Promise<string | null> {
  const result = await companiesApi().me()
  return result.ok ? (result.data.user?.employee_id ?? null) : null
}
const unavailable: LedgerNowResult = { ok: false, reason: 'unavailable' }
/** A mute drops the collisions it covers no matter which path learned it. */
function withoutMutedCollisions(
  collisions: LedgerCollision[],
  muted: ReadonlySet<string>
): LedgerCollision[] {
  return collisions.filter((item) => !(item.local.repo && muted.has(item.local.repo)))
}

export function createSessionLedgerStore(
  storage: SessionLedgerStorage = createLocalSessionLedgerStorage(),
  api: () => SessionLedgerApi | undefined = getSessionLedgerApi,
  employee: () => Promise<string | null> = readEmployeeId
) {
  return create<SessionLedgerState>((set, get) => {
    let timer: ReturnType<typeof setInterval> | undefined
    let active = false
    let epoch = 0
    let request = 0
    let nextLive = 0
    let locals: LedgerLocalSession[] = []
    let subscribed: SessionLedgerApi | undefined
    let unsubscribe: (() => void) | undefined
    let serverAnchor: { time: string; at: number } | undefined
    let peersBusy: number | undefined
    let refreshingEpoch: number | undefined
    let refreshAgain = false
    let muteRevision = 0
    const pollPeers = async (client: SessionLedgerApi, generation: number): Promise<void> => {
      if (peersBusy === generation || !serverAnchor || !get().live?.ok) {
        return
      }
      peersBusy = generation
      const anchor = serverAnchor
      const time = new Date(Date.parse(anchor.time) + performance.now() - anchor.at).toISOString()
      const day = serverDay(time, anchor.time)
      try {
        const sessions = locals
        const results = await Promise.all(
          sessions.map(async (local) => {
            if (local.repo && get().muted.has(local.repo)) {
              return { local, result: null }
            }
            return { local, result: await client.peers(local.ledgerId).catch(() => null) }
          })
        )
        if (generation !== epoch) {
          return
        }
        for (const { local, result } of results) {
          if (!result?.ok || !locals.some((row) => row.ledgerId === local.ledgerId)) {
            continue
          }
          for (const peer of result.peers) {
            const state = get()
            if (
              !eligibleCollisionPeer(peer, local, state.muted) ||
              state.hasSeenPeerToday(local.ledgerId, peer.ledger_id, day)
            ) {
              continue
            }
            state.markSeenPeerToday(local.ledgerId, peer.ledger_id, day)
            set({ collisions: [...get().collisions, { peer, local, day }] })
          }
        }
      } finally {
        if (peersBusy === generation) {
          peersBusy = undefined
        }
      }
    }
    const arm = (): void => {
      clearInterval(timer)
      if (!active) {
        return
      }
      // One scheduler: collisions need 30s; hidden-tab roster reads still wait five minutes.
      timer = setInterval(
        () => {
          if (get().teamTabMounted || Date.now() >= nextLive) {
            if (refreshingEpoch !== epoch) {
              void get().refresh()
            }
          } else {
            const client = api()
            if (client) {
              void pollPeers(client, epoch)
            }
          }
        },
        get().teamTabMounted || locals.length > 0 ? 30_000 : 300_000
      )
    }
    return {
      live: null,
      today: null,
      refreshing: false,
      badgeCount: 0,
      currentEmployeeId: null,
      teamTabMounted: false,
      muted: new Set(),
      seen: new Set(),
      collisions: [],
      start() {
        active = true
        epoch++
        const generation = epoch
        unsubscribe?.()
        subscribed = undefined
        locals = []
        serverAnchor = undefined
        set({
          live: null,
          today: null,
          badgeCount: 0,
          currentEmployeeId: null,
          collisions: [],
          muted: new Set(storage.load('muted-repos')),
          seen: new Set(storage.load('seen-peers'))
        })
        arm()
        void get().refresh()
        return () => {
          if (generation !== epoch) {
            return
          }
          active = false
          epoch++
          request++
          clearInterval(timer)
          unsubscribe?.()
          subscribed = undefined
        }
      },
      setTeamTabMounted(mounted) {
        if (get().teamTabMounted === mounted) {
          return
        }
        set({ teamTabMounted: mounted })
        arm()
        if (mounted) {
          void get().refresh()
        } else {
          nextLive = Date.now() + 300_000
        }
      },
      async refresh() {
        if (refreshingEpoch === epoch) {
          refreshAgain = true
          return
        }
        const generation = epoch
        refreshingEpoch = epoch
        refreshAgain = false
        const currentRequest = ++request
        const client = api()
        nextLive = Date.now() + 300_000
        set({ refreshing: true })
        if (!client) {
          refreshingEpoch = undefined
          unsubscribe?.()
          subscribed = undefined
          locals = []
          arm()
          set({
            live: unavailable,
            today: unavailable,
            badgeCount: 0,
            refreshing: false,
            collisions: []
          })
          return
        }
        try {
          const revision = muteRevision
          const mounted = get().teamTabMounted
          const [live, today, employeeId, sessions, muted] = await Promise.all([
            client.now('live').catch(() => unavailable),
            mounted ? client.now('today').catch(() => unavailable) : Promise.resolve(null),
            employee().catch(() => null),
            client.localSessions().catch(() => []),
            client.mutedRepos().catch(() => null)
          ])
          if (generation !== epoch || currentRequest !== request) {
            return
          }
          locals = sessions
          if (live.ok) {
            serverAnchor = { time: live.server_time, at: performance.now() }
          }
          const adoptMuted = muted && revision === muteRevision ? new Set(muted) : null
          set({
            live,
            today,
            currentEmployeeId: employeeId,
            badgeCount: employeeId
              ? ledgerSectionRows(live, true).filter((row) => row.employee_id !== employeeId).length
              : 0,
            ...(adoptMuted ? { muted: adoptMuted } : {}),
            ...(!live.ok
              ? { collisions: [] }
              : adoptMuted
                ? { collisions: withoutMutedCollisions(get().collisions, adoptMuted) }
                : {})
          })
          if (active && subscribed !== client) {
            unsubscribe?.()
            subscribed = client
            unsubscribe = client.onLocalSessionsChanged((rows) => {
              if (generation !== epoch) {
                return
              }
              locals = rows
              set({
                collisions: get().collisions.filter((item) =>
                  rows.some((row) => row.ledgerId === item.local.ledgerId)
                )
              })
              arm()
              void pollPeers(client, generation)
            })
          }
          arm()
          await pollPeers(client, generation)
        } catch {
          if (generation === epoch && currentRequest === request) {
            set({ live: unavailable, today: unavailable, badgeCount: 0, collisions: [] })
          }
        } finally {
          if (generation === epoch && currentRequest === request) {
            refreshingEpoch = undefined
            set({ refreshing: false })
            if (refreshAgain && active) {
              void get().refresh()
            }
          }
        }
      },
      async muteRepo(repo) {
        const generation = epoch
        muteRevision++
        const muted = new Set([...get().muted, repo])
        set({ muted, collisions: get().collisions.filter((item) => item.local.repo !== repo) })
        const client = api()
        if (!client) {
          storage.save('muted-repos', [...muted])
          return
        }
        try {
          await client.muteRepo(repo, true)
          const authoritative = await client.mutedRepos()
          if (generation === epoch) {
            const muted = new Set(authoritative)
            set({ muted, collisions: withoutMutedCollisions(get().collisions, muted) })
          }
        } catch {
          /* The next successful read reconciles the optimistic preference. */
        }
      },
      hasSeenPeerToday: (local, peer, day) => get().seen.has(`${local}:${peer}:${day}`),
      markSeenPeerToday(local, peer, day) {
        const seen = new Set([...get().seen, `${local}:${peer}:${day}`])
        set({ seen })
        storage.save('seen-peers', [...seen])
      },
      dismissCollision: (local, peer) =>
        set({
          collisions: get().collisions.filter(
            (item) => !(item.local.ledgerId === local && item.peer.ledger_id === peer)
          )
        })
    }
  })
}

export const useSessionLedger = createSessionLedgerStore()
