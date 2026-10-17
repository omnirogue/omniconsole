import { useEffect, useState } from 'react'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import { handoffApi } from '@/components/handoffs/handoff-client'
import { companiesApi, companiesData } from '@/components/companies/companies-client'
import { translate } from '@/i18n/i18n'
import type { ConsoleCalendarFeed } from '../../../../shared/console-calendar-contract'
import type { CalendarPerson } from './CalendarPeoplePicker'

export type CalendarCompany = { slug: string; name: string }
export type CalendarProjectChoice = {
  id: string
  title: string
  company: string
  domain: string
  dueDate: string | null
}

export function useCalendarDirectory(scope: string, revision: number) {
  const [companies, setCompanies] = useState<CalendarCompany[]>([])
  const [people, setPeople] = useState<CalendarPerson[]>([])
  const [projects, setProjects] = useState<CalendarProjectChoice[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let disposed = false
    void Promise.allSettled([
      Promise.resolve()
        .then(() => companiesApi().folders())
        .then(companiesData),
      Promise.resolve()
        .then(() => handoffApi().recipients())
        .then(workflowData)
    ]).then(([work, recipients]) => {
      if (disposed) {
        return
      }
      const issues: string[] = []
      if (work.status === 'fulfilled') {
        setCompanies(
          work.value.companies.flatMap((company) =>
            company.slug ? [{ slug: company.slug, name: company.name ?? company.slug }] : []
          )
        )
        setProjects(
          work.value.companies.flatMap((company) =>
            company.domains.flatMap((domain) =>
              (domain.projects ?? []).flatMap((project) =>
                project.id
                  ? [
                      {
                        id: project.id,
                        title: project.name ?? project.id,
                        company: company.slug ?? '',
                        domain: domain.name ?? '',
                        dueDate: typeof project.due_date === 'string' ? project.due_date : null
                      }
                    ]
                  : []
              )
            )
          )
        )
        if (!work.value.ok) {
          issues.push(
            work.value.reason ??
              translate('calendar.foldersUnavailable', 'Company folders could not be read.')
          )
        } else if (
          work.value.companies.some((company) =>
            company.domains.some((domain) => domain.projects == null)
          )
        ) {
          issues.push(
            translate('calendar.projectFoldersIncomplete', 'Some project folders are unavailable.')
          )
        }
      } else {
        setCompanies([])
        setProjects([])
        issues.push(workflowErrorMessage(work.reason))
      }
      if (recipients.status === 'fulfilled') {
        setPeople(recipients.value.employees)
      } else {
        setPeople([])
        issues.push(workflowErrorMessage(recipients.reason))
      }
      setErrors(issues)
      setLoading(false)
    })
    return () => {
      disposed = true
    }
  }, [scope, revision])
  return { companies, people, projects, errors, loading }
}

export function useCalendarFeed(
  scope: string,
  from: string,
  to: string,
  company: string,
  employee: string,
  revision: number
) {
  const key = JSON.stringify([scope, from, to, company, employee, revision])
  const [state, setState] = useState<{
    key: string
    feed: ConsoleCalendarFeed | null
    error: string | null
    loading: boolean
  }>({
    key,
    feed: null,
    error: null,
    loading: true
  })
  useEffect(() => {
    let disposed = false
    let busy = false
    const refresh = async () => {
      if (disposed || busy) {
        return
      }
      busy = true
      try {
        const feed = workflowData(
          await consoleWorkflowApi().listCalendar({
            from,
            to,
            ...(company ? { company } : {}),
            ...(employee ? { employee } : {})
          })
        )
        if (!disposed) {
          setState({ key, feed, error: null, loading: false })
        }
      } catch (reason) {
        if (!disposed) {
          setState({ key, feed: null, error: workflowErrorMessage(reason), loading: false })
        }
      } finally {
        busy = false
      }
    }
    const visible = () => {
      if (document.visibilityState !== 'hidden') {
        void refresh()
      }
    }
    void refresh()
    const timer = setInterval(visible, 30_000)
    window.addEventListener('focus', visible)
    return () => {
      disposed = true
      clearInterval(timer)
      window.removeEventListener('focus', visible)
    }
  }, [key, from, to, company, employee])
  return state.key === key ? state : { key, feed: null, error: null, loading: true }
}
