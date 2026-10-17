import { useCallback, useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { ConsoleCompaniesApi } from '../../../../shared/console-companies-contract'
import type { ConsoleWorkflowResult } from '../../../../shared/console-workflow-types'

/** Codes the transport uses when the desktop is not signed in or not configured. */
const SIGN_IN_CODES = new Set(['signed_in_required', 'backoffice_unconfigured'])

export class CompaniesRequestError extends Error {
  constructor(readonly detail: { code: string; message: string; status?: number }) {
    super(detail.message)
    this.name = 'CompaniesRequestError'
  }
}

export function companiesApi(): ConsoleCompaniesApi {
  const api = window.api?.consoleCompanies
  if (!api) {
    throw new CompaniesRequestError({
      code: 'capability_unavailable',
      message: translate(
        'companies.apiUnavailable',
        'Companies need an updated OmniConsole desktop app.'
      )
    })
  }
  return api
}

export function companiesData<T>(result: ConsoleWorkflowResult<T>): T {
  if (!result.ok) {
    throw new CompaniesRequestError(result.error)
  }
  return result.data
}

/** True when the only thing missing is a signed-in, configured omnios connection. */
export function needsOmniosSignIn(error: unknown): boolean {
  return error instanceof CompaniesRequestError && SIGN_IN_CODES.has(error.detail.code)
}

export function companiesErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type AsyncRead<T> = {
  data: T | null
  error: unknown
  loading: boolean
  reload: () => void
}

/**
 * One read, re-run when its key changes or the caller asks. Kept local to this
 * feature — the desktop has no react-query, and the handoff/inbox pages read the
 * same way.
 */
export function useCompaniesRead<T>(
  read: () => Promise<ConsoleWorkflowResult<T>>,
  key: string,
  enabled = true
): AsyncRead<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(enabled)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    setError(null)
    // Why: the previous key's answer must never paint the new scope.
    setData(null)
    void Promise.resolve()
      .then(read)
      .then((result) => {
        if (live) {
          setData(companiesData(result))
        }
      })
      .catch((reason: unknown) => {
        if (live) {
          setError(reason)
        }
      })
      .finally(() => {
        if (live) {
          setLoading(false)
        }
      })
    return () => {
      live = false
    }
    // Why: `read` is rebuilt on every render by design; the key names the scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision, enabled])
  return { data, error, loading, reload }
}
