import {
  readLegacyFleetReceipts,
  saveFleetReceiptCache as save
} from '@/lib/conversation-fleet-cache'
import { clearWorkflowGraphReads, readWorkflowGraph } from '@/lib/workflow-graph-read-cache'
import { installBackofficeAdaptivePoller } from '@/lib/backoffice-adaptive-poller'
import { useEffect } from 'react'
import { create } from 'zustand'
import { useAppStore } from '@/store'
import { personalViewStorageKey } from '@/lib/personal-view-storage'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import type { ConsoleWorkflowJob } from '../../../shared/console-workflow-types'
import {
  admittedConversationFleetJobs,
  conversationFleetReceipt as receipt,
  discoveredConversationFleetReceipts,
  type ConversationFleetReceipt,
  type StoredConversationFleetReceipt
} from '@/lib/conversation-fleet-receipt'

export type { ConversationFleetReceipt } from '@/lib/conversation-fleet-receipt'

const STORAGE_KEY = 'omni.conversation-fleet.v1'
export type ConversationFleetView = StoredConversationFleetReceipt & {
  jobs: ConsoleWorkflowJob[]
  verified: boolean
  error: string | null
}

type FleetStore = {
  scope: string | null
  runs: ConversationFleetView[]
  recoveryError: string | null
  ready: boolean
  load: (scope: string) => Promise<void>
  beginAdmission: (scope: string, value: ConversationFleetReceipt) => Promise<boolean>
  remember: (scope: string, value: ConversationFleetReceipt, jobs: ConsoleWorkflowJob[]) => boolean
  recordJobs: (
    scope: string,
    workflowId: string,
    jobs: ConsoleWorkflowJob[] | null,
    error: string | null
  ) => void
  dismissUnconfirmed: (scope: string, workflowId: string) => boolean
  discover: (scope: string, values: StoredConversationFleetReceipt[]) => void
}

const loading = new Map<string, Promise<void>>()
let loadGeneration = 0

export const useConversationFleetStore = create<FleetStore>((set, get) => ({
  scope: null,
  runs: [],
  recoveryError: null,
  ready: false,
  async load(scope) {
    if (get().scope === scope && get().ready) {
      return
    }
    const pending = loading.get(scope)
    if (pending && get().scope === scope) {
      return pending
    }
    const generation = ++loadGeneration
    const current = () => get().scope === scope && generation === loadGeneration
    clearWorkflowGraphReads(scope)
    set({ scope, ready: false, runs: [], recoveryError: null })
    const request = (async () => {
      try {
        const legacy = readLegacyFleetReceipts(scope)
        const read = consoleWorkflowApi().readFleetReceipts
        if (!read) {
          throw new Error('Durable dispatch recovery is unavailable in this version.')
        }
        const rows = workflowData(await read(legacy, scope))
        if (!current()) {
          return
        }
        set({
          ready: true,
          runs: rows.map((row) => ({ ...row, jobs: [], verified: false, error: null }))
        })
      } catch (error) {
        if (current()) {
          set({ recoveryError: workflowErrorMessage(error), ready: false })
        }
        throw error
      }
    })()
    loading.set(scope, request)
    try {
      await request
    } finally {
      if (loading.get(scope) === request) {
        loading.delete(scope)
      }
    }
  },
  async beginAdmission(scope, value) {
    if (get().scope !== scope || !get().ready) {
      return false
    }
    const parsed = receipt.parse({ ...value, admission: 'pending' })
    if (get().runs.some((run) => run.workflowId === parsed.workflowId)) {
      return false
    }
    const begin = consoleWorkflowApi().beginFleetAdmission
    if (!begin) {
      return false
    }
    try {
      if (!workflowData(await begin(parsed, scope))) {
        return false
      }
      if (get().scope !== scope) {
        return false
      }
      const runs = [...get().runs, { ...parsed, jobs: [], verified: false, error: null }]
      set({ runs })
      save(scope, runs)
      return true
    } catch (error) {
      if (get().scope === scope) {
        set({ recoveryError: workflowErrorMessage(error) })
      }
      return false
    }
  },
  remember(scope, value, jobs) {
    if (get().scope !== scope) {
      return false
    }
    const parsed = receipt.parse({ ...value, admission: 'accepted' })
    admittedConversationFleetJobs(parsed, jobs)
    const runs = [
      ...get().runs.filter((run) => run.workflowId !== parsed.workflowId),
      { ...parsed, jobs, verified: true, error: null }
    ]
    set({ runs })
    return save(scope, runs)
  },
  recordJobs(scope, workflowId, jobs, error) {
    if (get().scope !== scope) {
      return
    }
    const previous = get().runs
    const runs = previous.map((run): ConversationFleetView => {
      if (run.workflowId !== workflowId) {
        return run
      }
      if (jobs !== null) {
        try {
          admittedConversationFleetJobs(run, jobs)
          return { ...run, admission: 'accepted', jobs, verified: true, error: null }
        } catch (failure) {
          return { ...run, verified: false, error: workflowErrorMessage(failure) }
        }
      }
      return { ...run, verified: false, error }
    })
    set({ runs })
    if (runs.some((run, index) => run.admission !== previous[index].admission)) {
      save(scope, runs)
    }
  },
  dismissUnconfirmed(scope, workflowId) {
    if (get().scope !== scope) {
      return false
    }
    const run = get().runs.find((candidate) => candidate.workflowId === workflowId)
    if (!run || run.intent || run.admission !== 'pending' || run.verified) {
      return false
    }
    const runs = get().runs.filter((candidate) => candidate.workflowId !== workflowId)
    set({ runs })
    return save(scope, runs)
  },
  discover(scope, values) {
    if (get().scope !== scope) {
      return
    }
    const existing = new Set(get().runs.map((run) => run.workflowId))
    const added = values
      .filter((value) => !existing.has(value.workflowId))
      .map((value) => ({ ...value, jobs: [], verified: false, error: null }))
    if (!added.length) {
      return
    }
    const runs = [...get().runs, ...added]
    set({ runs })
    save(scope, runs)
  }
}))

export function conversationFleetScope(): string {
  return personalViewStorageKey(STORAGE_KEY)
}

/** Receipts are a view cache; only the server runs or advances their jobs. */
export function useConversationFleetRuns(): ConversationFleetView[] {
  const scope = useAppStore(() => conversationFleetScope())
  const storedScope = useConversationFleetStore((state) => state.scope)
  const runs = useConversationFleetStore((state) => state.runs)
  useEffect(() => {
    void useConversationFleetStore
      .getState()
      .load(scope)
      .catch(() => {})
  }, [scope])
  return scope === storedScope ? runs : EMPTY_RUNS
}
const EMPTY_RUNS: ConversationFleetView[] = []

export async function refreshConversationFleet(
  scope: string,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const current = () =>
    isCurrent() &&
    conversationFleetScope() === scope &&
    useConversationFleetStore.getState().scope === scope &&
    useConversationFleetStore.getState().ready
  if (!current()) {
    return
  }
  try {
    const api = consoleWorkflowApi()
    if (!api.listJobs) {
      throw new Error('Conversation recovery is unavailable in this version.')
    }
    const result = workflowData(await api.listJobs({ conversationSource: true }))
    if (!current()) {
      return
    }
    if (result.conversation_source_scope !== 'directing_person') {
      throw new Error('The server has not verified the conversation recovery scope.')
    }
    useConversationFleetStore
      .getState()
      .discover(scope, discoveredConversationFleetReceipts(result.jobs, new Date().toISOString()))
    useConversationFleetStore.setState({ recoveryError: null })
  } catch (error) {
    if (current()) {
      useConversationFleetStore.setState({ recoveryError: workflowErrorMessage(error) })
    }
  }
  if (!current()) {
    return
  }
  for (const run of useConversationFleetStore.getState().runs) {
    if (!current()) {
      return
    }
    try {
      const result = await readWorkflowGraph(scope, run.workflowId, run.digest)
      if (!current()) {
        return
      }
      if (result.workflow_id !== run.workflowId) {
        throw new Error('The server returned a different workflow.')
      }
      useConversationFleetStore.getState().recordJobs(scope, run.workflowId, result.jobs, null)
    } catch (error) {
      if (current()) {
        useConversationFleetStore
          .getState()
          .recordJobs(scope, run.workflowId, null, workflowErrorMessage(error))
      }
    }
  }
}

export function useConversationFleetMonitor(): void {
  const runs = useConversationFleetRuns()
  const scope = useAppStore(() => conversationFleetScope())
  const ids = runs.map((run) => run.workflowId).join('|')
  useEffect(() => {
    let disposed = false
    let refreshing = false
    const refresh = async () => {
      if (disposed || refreshing) {
        return
      }
      refreshing = true
      try {
        await refreshConversationFleet(scope, () => !disposed)
      } finally {
        refreshing = false
      }
    }
    const stop = installBackofficeAdaptivePoller(refresh)
    return () => {
      disposed = true
      stop()
    }
  }, [scope, ids])
}
