import { useEffect, useState } from 'react'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import type { WorkflowData } from '@/lib/console-workflow-client'
import type { JiraSessionTask } from '../../../../shared/console-jira-session-contract'

type SearchPage = {
  key: string
  issues: JiraSessionTask[]
  cursor: string | null
  page?: string
}

export function useJiraAttachTasks(
  active: boolean,
  scope: string,
  query: string,
  project: 'APU' | 'OMR' | 'SWAYB'
) {
  const [config, setConfig] = useState<WorkflowData<'jiraSessionConfig'> | null>(null)
  const key = JSON.stringify([active, scope, query, project])
  const [result, setResult] = useState<SearchPage>({ key, issues: [], cursor: null })
  const page = result.key === key ? result.page : undefined
  const issues = result.key === key ? result.issues : []
  const cursor = result.key === key ? result.cursor : null
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    setConfig(null)
    setError('')
    if (active) {
      void (async () => {
        try {
          const read = consoleWorkflowApi().jiraSessionConfig
          if (!read) {
            throw new Error('Update OmniConsole to use Jira session links.')
          }
          const value = workflowData(await read())
          if (live) {
            setConfig(value)
          }
        } catch (reason) {
          if (live) {
            setError(workflowErrorMessage(reason))
          }
        }
      })()
    }
    return () => {
      live = false
    }
  }, [active, scope, retry])
  useEffect(() => {
    let live = true
    if (
      !active ||
      !config?.enabled ||
      !config.connection.connected ||
      !config.projects.some((row) => row.key === project)
    ) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    const timer = setTimeout(
      () =>
        void (async () => {
          try {
            const read = consoleWorkflowApi().jiraSessionTasks
            if (!read) {
              throw new Error('Update OmniConsole to read Jira tasks.')
            }
            const value = workflowData(
              await read({
                projectKey: project,
                query: query.trim(),
                ...(page ? { cursor: page } : {})
              })
            )
            if (live) {
              setResult((previous) => ({
                key,
                page,
                issues: [
                  ...new Map(
                    [...(page && previous.key === key ? previous.issues : []), ...value.issues].map(
                      (row) => [row.work_ref.issue_id, row]
                    )
                  ).values()
                ],
                cursor: value.is_last ? null : (value.next_cursor ?? null)
              }))
            }
          } catch (reason) {
            if (live) {
              setError(workflowErrorMessage(reason))
            }
          } finally {
            if (live) {
              setLoading(false)
            }
          }
        })(),
      query ? 250 : 0
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [active, query, project, page, config, retry, key])
  return {
    config,
    issues,
    error,
    loading,
    cursor,
    loadMore: () =>
      setResult((previous) =>
        previous.key === key ? { ...previous, page: cursor ?? undefined } : previous
      ),
    retry: () => setRetry((n) => n + 1)
  }
}
