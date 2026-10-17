import { useEffect, useMemo, useState } from 'react'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'
import { useAppStore } from '@/store'
import { SESSION_PROJECTS_LIST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import {
  SESSION_PROJECTS_RPC,
  type SessionProjectListEntry,
  type SessionProjectListResult
} from '../../../../shared/session-project-cli'

export type PairedProjects = {
  environmentId: string
  name: string
  /** Null while loading; an error leaves the computer listed with why. */
  projects: SessionProjectListEntry[] | null
  error: string | null
}

/** Paired computers that can list their projects (`session-projects.list.v1`), with their projects. */
export function usePairedProjects(): PairedProjects[] {
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const statuses = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const listing = useMemo(
    () =>
      environments.filter((environment) =>
        statuses
          .get(environment.id)
          ?.status?.capabilities?.includes(SESSION_PROJECTS_LIST_RUNTIME_CAPABILITY)
      ),
    [environments, statuses]
  )
  const listingKey = listing.map((environment) => environment.id).join('\n')
  const [results, setResults] = useState<Record<string, Omit<PairedProjects, 'name'>>>({})
  useEffect(() => {
    let cancelled = false
    for (const environmentId of listingKey ? listingKey.split('\n') : []) {
      void window.api.runtimeEnvironments
        .call({ selector: environmentId, method: SESSION_PROJECTS_RPC.list, params: {} })
        .then((response) => {
          const { projects } = unwrapRuntimeRpcResult<SessionProjectListResult>(
            response as RuntimeRpcResponse<SessionProjectListResult>
          )
          return { environmentId, projects, error: null }
        })
        .catch((error: unknown) => ({
          environmentId,
          projects: [],
          error: error instanceof Error ? error.message : String(error)
        }))
        .then((result) => {
          if (!cancelled) {
            setResults((prev) => ({ ...prev, [environmentId]: result }))
          }
        })
    }
    return () => {
      cancelled = true
    }
  }, [listingKey])
  return listing.map((environment) => ({
    environmentId: environment.id,
    name: environment.name,
    projects: results[environment.id]?.projects ?? null,
    error: results[environment.id]?.error ?? null
  }))
}
