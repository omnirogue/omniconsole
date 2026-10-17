import { useEffect, useRef, useState } from 'react'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import type {
  ConsoleJobEvidenceEntry,
  ConsoleJobEvidencePage
} from '../../../../shared/console-job-evidence'

const POLL_MS = 5_000

export function useWorkflowJobEvidence(input: {
  jobId: string
  attempt?: number
  leaseGeneration?: number
}) {
  const { jobId, attempt, leaseGeneration } = input
  const [entries, setEntries] = useState<ConsoleJobEvidenceEntry[]>([])
  const [page, setPage] = useState<ConsoleJobEvidencePage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const cursor = useRef(0)
  const identity = useRef<{ attempt: number; leaseGeneration: number } | null>(null)
  useEffect(() => {
    if (!page || loading || error || page.has_more || page.complete) {
      return
    }
    const timer = setTimeout(() => setRevision((value) => value + 1), POLL_MS)
    return () => clearTimeout(timer)
  }, [page, loading, error])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const api = consoleWorkflowApi()
        if (typeof api.readJobEvidence !== 'function') {
          throw new Error(
            'Session transcripts are unavailable in this version. Update the IDE to read them.'
          )
        }
        const pinned = identity.current ?? {
          attempt: attempt && attempt > 0 ? attempt : undefined,
          leaseGeneration: leaseGeneration && leaseGeneration > 0 ? leaseGeneration : undefined
        }
        const received = workflowData(
          await api.readJobEvidence({
            jobId,
            ...pinned,
            after: cursor.current,
            limit: 100
          })
        )
        if (
          received.job_id !== jobId ||
          (pinned.attempt !== undefined && received.attempt !== pinned.attempt) ||
          (pinned.leaseGeneration !== undefined &&
            received.lease_generation !== pinned.leaseGeneration)
        ) {
          throw new Error('The server returned evidence for a different job attempt.')
        }
        if (cancelled) {
          return
        }
        if (received.attempt > 0 && received.lease_generation > 0) {
          identity.current = {
            attempt: received.attempt,
            leaseGeneration: received.lease_generation
          }
        }
        cursor.current = received.next_after
        setEntries((previous) => [...previous, ...received.entries])
        setPage(received)
        setError(null)
      } catch (failure) {
        if (!cancelled) {
          setError(workflowErrorMessage(failure))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [jobId, attempt, leaseGeneration, revision])
  return { entries, page, error, loading, refresh: () => setRevision((value) => value + 1) }
}
