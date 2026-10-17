import { useCallback, useEffect, useState } from 'react'
import { create } from 'zustand'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  EVOLVE_RPC,
  isEvolveRunActive,
  type EvolveRunRecord
} from '../../../../shared/evolve-workflow'

export const EVOLVE_POLL_MS = 5_000

type EvolveRunStore = {
  runsById: Record<string, EvolveRunRecord>
  put: (run: EvolveRunRecord) => void
}

/** The Evolve records this window has read; the main process owns them. */
export const useEvolveRuns = create<EvolveRunStore>((set) => ({
  runsById: {},
  put: (run) => set((state) => ({ runsById: { ...state.runsById, [run.id]: run } }))
}))

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Calls an Evolve RPC that answers `{ run }` and keeps the answer. */
export async function callEvolveRun(
  method: (typeof EVOLVE_RPC)[keyof typeof EVOLVE_RPC],
  params: unknown
): Promise<EvolveRunRecord> {
  const { run } = await callRuntimeRpc<{ run: EvolveRunRecord }>({ kind: 'local' }, method, params)
  useEvolveRuns.getState().put(run)
  return run
}

/**
 * One run, read on mount, whenever `pushed` changes (a status push for this tab), and every
 * EVOLVE_POLL_MS while the run is active; a settled run is not polled.
 */
export function useEvolveRun(id: string, pushed: unknown) {
  const run = useEvolveRuns((state) => state.runsById[id])
  const [readError, setReadError] = useState<string | null>(null)
  const read = useCallback(async () => {
    try {
      await callEvolveRun(EVOLVE_RPC.show, { id })
      setReadError(null)
    } catch (error) {
      setReadError(errorText(error))
    }
  }, [id])
  useEffect(() => {
    void read()
  }, [read, pushed])
  const active = run ? isEvolveRunActive(run.state) : false
  useEffect(() => {
    if (!active) {
      return
    }
    const timer = setInterval(() => void read(), EVOLVE_POLL_MS)
    return () => clearInterval(timer)
  }, [active, read])
  return { run, readError, read }
}

/** Runs a Stop or Check again, holding its pending state and refusal text. */
export function useEvolveRunAction(id: string) {
  const [pending, setPending] = useState<'stop' | 'refresh' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act = useCallback(
    async (kind: 'stop' | 'refresh') => {
      setPending(kind)
      setError(null)
      try {
        await callEvolveRun(kind === 'stop' ? EVOLVE_RPC.stop : EVOLVE_RPC.refresh, { id })
      } catch (err) {
        setError(errorText(err))
      } finally {
        setPending(null)
      }
    },
    [id]
  )
  return { pending, error, act }
}
