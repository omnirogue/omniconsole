import { translate } from '@/i18n/i18n'
import type { Job, JobStatus } from '../integration/fleet/jobsTypes'

export const COLUMNS: { status: JobStatus; label: () => string }[] = [
  {
    status: 'scheduled',
    label: () => translate('office.panels.jobsKanbanPanel.scheduled', 'Scheduled')
  },
  { status: 'on_hold', label: () => translate('office.panels.jobsKanbanPanel.onHold', 'On Hold') },
  {
    status: 'in_progress',
    label: () => translate('office.panels.jobsKanbanPanel.inProgress', 'In Progress')
  },
  { status: 'done', label: () => translate('office.panels.jobsKanbanPanel.done', 'Done') }
]

const STATUS_SET = new Set(COLUMNS.map((c) => c.status))

export function columnOf(job: Job): JobStatus {
  const s = (job.status || '').toLowerCase()
  return (STATUS_SET.has(s as JobStatus) ? s : 'scheduled') as JobStatus
}

export function isDerived(job: Job): boolean {
  return (job.source || '') === 'derived'
}

export function shortMachine(m?: string | null): string {
  if (!m) {
    return translate('office.panels.jobsKanbanPanel.localMachine', 'local')
  }
  return m.length > 14 ? `${m.slice(0, 12)}…` : m
}
