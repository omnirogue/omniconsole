import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import {
  BUILD_REVIEW_RPC,
  type BuildReviewPipelineSnapshot,
  type BuildReviewPlacementSupportResult,
  type BuildReviewStartRequest,
  type BuildReviewListResult,
  type BuildReviewShowResult
} from '../../../../shared/build-review-pipeline'

/** Shown when a fleet Start would reach a host that predates placement and would run it here. */
export const BUILD_REVIEW_PLACEMENT_UNSUPPORTED =
  "This OmniConsole runtime is from before fleet placement and would run a fleet request on this computer. Choose 'Run on: this computer', or update the runtime."

/** Shown when a named-host Start would reach a host that would drop the name and choose itself. */
export const BUILD_REVIEW_NAMED_HOST_UNSUPPORTED =
  'This OmniConsole cannot run Build + Review on a named host. Update it, or choose the fleet or this computer.'

/** A probe that never answers must refuse by name too, not hang the Start. */
export const BUILD_REVIEW_PLACEMENT_PROBE_DEADLINE_MS = 5_000
export const BUILD_REVIEW_PLACEMENT_PROBE_TIMED_OUT =
  "This OmniConsole runtime did not say whether it places fleet runs within 5 s; the Start was not sent. Choose 'Run on: this computer', or try again."

function withProbeDeadline<T>(call: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(BUILD_REVIEW_PLACEMENT_PROBE_TIMED_OUT)),
      BUILD_REVIEW_PLACEMENT_PROBE_DEADLINE_MS
    )
    call.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** A host that lacks the support method strips `runsOn` and runs here: never send it a fleet Start. */
async function assertBuildReviewPlacementSupported({
  runsOn,
  runsOnHost
}: BuildReviewStartRequest): Promise<void> {
  if (runsOn === 'local') {
    return
  }
  try {
    const support = await withProbeDeadline(
      callRuntimeRpc<BuildReviewPlacementSupportResult>(
        { kind: 'local' },
        BUILD_REVIEW_RPC.placementSupport
      )
    )
    // A host that answers but not with the contract's shape is not one that places runs.
    if (!Array.isArray(support?.runsOn) || !support.runsOn.includes(runsOn ?? 'fleet')) {
      throw new Error(BUILD_REVIEW_PLACEMENT_UNSUPPORTED)
    }
    // `start` strips unknown keys, so an older host would silently choose a host itself.
    if (runsOnHost && support.hosts !== true) {
      throw new Error(BUILD_REVIEW_NAMED_HOST_UNSUPPORTED)
    }
  } catch (error) {
    if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      throw new Error(BUILD_REVIEW_PLACEMENT_UNSUPPORTED)
    }
    throw error
  }
}

export type BuildReviewState = {
  pipelinesById: Record<string, BuildReviewPipelineSnapshot>
  /** True once the host has listed its runs: a run it did not list is one it no longer has. */
  pipelinesListed: boolean
  selectedPipelineId: string | null
  /** `objective` prefills the dialog opened for a workspace that cannot hold a tab. */
  startDialog: { open: boolean; worktree?: string; objective?: string }
  error: string | null
  /** True once the host listed its runs; false when the list failed (recorded in `error`). */
  refreshAll: () => Promise<boolean>
  refreshOne: (id: string) => Promise<string | null>
  start: (
    request: BuildReviewStartRequest,
    options?: { reveal?: boolean }
  ) => Promise<BuildReviewPipelineSnapshot>
  cancel: (id: string) => Promise<void>
  reply: (id: string, messageId: string, body: string) => Promise<void>
  select: (id: string) => void
  openStartDialog: (worktree?: string, objective?: string) => void
  closeStartDialog: () => void
}
export type BuildReviewSlice = { buildReview: BuildReviewState }

export const createBuildReviewSlice: StateCreator<AppState, [], [], BuildReviewSlice> = (
  set,
  get
) => {
  const update = (patch: Partial<BuildReviewState>): void => {
    set((state) => ({ buildReview: { ...state.buildReview, ...patch } }))
  }
  const merge = (pipeline: BuildReviewPipelineSnapshot): void => {
    const current = get().buildReview.pipelinesById
    if (current[pipeline.id]?.updatedAt > pipeline.updatedAt) {
      return
    }
    update({ pipelinesById: { ...current, [pipeline.id]: pipeline }, error: null })
  }
  const mutate = async (method: string, params: unknown): Promise<BuildReviewPipelineSnapshot> => {
    const { pipeline } = await callRuntimeRpc<BuildReviewShowResult>(
      { kind: 'local' },
      method,
      params
    )
    merge(pipeline)
    return pipeline
  }
  return {
    buildReview: {
      pipelinesById: {},
      pipelinesListed: false,
      selectedPipelineId: null,
      startDialog: { open: false },
      error: null,
      refreshAll: async () => {
        try {
          const { pipelines } = await callRuntimeRpc<BuildReviewListResult>(
            { kind: 'local' },
            BUILD_REVIEW_RPC.list
          )
          for (const pipeline of pipelines) {
            merge(pipeline)
          }
          update({ error: null, pipelinesListed: true })
          return true
        } catch (error) {
          // Why a result: a failed list is no answer about any run, and callers must tell.
          update({ error: String(error) })
          return false
        }
      },
      refreshOne: async (id) => {
        try {
          await mutate(BUILD_REVIEW_RPC.show, { id })
          return null
        } catch (error) {
          const message = String(error)
          update({ error: message })
          return message
        }
      },
      start: async (request, options) => {
        await assertBuildReviewPlacementSupported(request)
        const pipeline = await mutate(BUILD_REVIEW_RPC.start, request)
        update({ selectedPipelineId: pipeline.id, startDialog: { open: false } })
        if (options?.reveal !== false) {
          get().openBuildReviewPage()
        }
        return pipeline
      },
      cancel: async (id) => {
        await mutate(BUILD_REVIEW_RPC.cancel, { id })
      },
      reply: async (id, messageId, body) => {
        await mutate(BUILD_REVIEW_RPC.reply, { id, messageId, body })
      },
      select: (id) => update({ selectedPipelineId: id }),
      openStartDialog: (worktree, objective) =>
        update({ startDialog: { open: true, worktree, ...(objective ? { objective } : {}) } }),
      closeStartDialog: () => update({ startDialog: { open: false } })
    }
  }
}
