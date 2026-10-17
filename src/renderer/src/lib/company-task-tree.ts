import { companySlug } from '../../../shared/company-identity'
import type {
  WorkFolderCompany,
  WorkFolderDomain,
  WorkFolderProject
} from '../../../shared/console-work-folders-contract'
import { isClosedTaskStatus, taskStanding, taskStandingRank } from '../../../shared/task-state'
import type { TaskStanding } from '../../../shared/task-state'
import { isHumanHandoffRow, type WorkRow } from '../../../shared/backoffice-work-views'

export type CompanyTaskRow = {
  row: WorkRow
  taskId: string
  standing: TaskStanding
}

export type CompanyTaskGroup = {
  key: string
  id: string | null
  name: string
  tasks: CompanyTaskRow[]
  needsYou: number
  open: number
}

export type CompanyTaskDepartment = CompanyTaskGroup & { projects: CompanyTaskGroup[] }
export type CompanyTaskCompany = CompanyTaskGroup & {
  slug: string
  departments: CompanyTaskDepartment[]
}

export type CompanyTaskTree = {
  companies: CompanyTaskCompany[]
  /** Tracked work the filing tree cannot place — a company nobody filed it under. */
  unfiled: CompanyTaskRow[]
  /** Finished and cancelled work, kept out of the way but never hidden. */
  closed: CompanyTaskRow[]
}

export function companyTaskKey(slug: string): string {
  return `tasks:company:${slug}`
}
export function departmentTaskKey(slug: string, unitId: string): string {
  return `tasks:unit:${slug}/${unitId}`
}
export function projectTaskKey(slug: string, projectId: string): string {
  return `tasks:project:${slug}/${projectId}`
}

function standingFor(row: WorkRow): TaskStanding {
  return taskStanding({
    status: row.todo?.status ?? row.state,
    kanbanStatus: row.todo?.kanban_status,
    triageState: row.todo?.triage_state,
    verifiedAt: row.todo?.verified_at,
    verificationFailedAt: row.todo?.verification_failed_at,
    // Why: the ❗ overlay follows the Needs You lens — a person's handoff, never a derived decision.
    needsYou: row.needsYou && isHumanHandoffRow(row),
    deferUntil: row.todo?.defer_until ?? null,
    pausedAt: row.todo?.paused_at ?? null
  })
}

function byStanding(a: CompanyTaskRow, b: CompanyTaskRow): number {
  return (
    taskStandingRank(a.standing) - taskStandingRank(b.standing) ||
    a.row.title.localeCompare(b.row.title)
  )
}

function group(key: string, id: string | null, name: string): CompanyTaskGroup {
  return { key, id, name, tasks: [], needsYou: 0, open: 0 }
}

function count(target: CompanyTaskGroup, rows: readonly CompanyTaskRow[]): void {
  target.needsYou = rows.filter((row) => row.standing.needsYou).length
  target.open = rows.filter((row) => row.standing.state !== 'done').length
}

function projectGroups(
  slug: string,
  projects: readonly WorkFolderProject[] | null | undefined
): CompanyTaskGroup[] {
  return (projects ?? [])
    .filter((project) => (project.name ?? '').trim().length > 0 && project.id)
    .map((project) => group(projectTaskKey(slug, project.id!), project.id!, project.name!.trim()))
}

function departmentGroups(
  slug: string,
  domains: readonly WorkFolderDomain[]
): CompanyTaskDepartment[] {
  return domains
    .filter((domain) => (domain.name ?? '').trim().length > 0)
    .map((domain) => ({
      ...group(
        departmentTaskKey(slug, domain.id ?? domain.name!),
        domain.id ?? null,
        domain.name!.trim()
      ),
      projects: projectGroups(slug, domain.projects)
    }))
}

/**
 * Durable work, where it belongs: company → department → project → tasks.
 *
 * Filing comes from the card's own fields, never from a folder on this disk — a task
 * spanning machines has no folder. A task the tree cannot place is unfiled, and closed
 * work is set aside rather than dropped, so the tree answers one question only: what
 * important work is in progress, and what stage is it at.
 */
export function buildCompanyTaskTree(input: {
  companies: readonly WorkFolderCompany[]
  rows: readonly WorkRow[]
  now?: number
}): CompanyTaskTree {
  const tasks: CompanyTaskRow[] = []
  const seen = new Set<string>()
  for (const row of input.rows) {
    const taskId = row.taskId
    // Why: only a real card is durable work; threads, messages and jobs are execution.
    if (!taskId || !taskId.startsWith('btk_') || seen.has(taskId)) {
      continue
    }
    seen.add(taskId)
    tasks.push({ row, taskId, standing: standingFor(row) })
  }
  const closed = tasks.filter(
    (task) => task.standing.state === 'done' || isClosedTaskStatus(task.row.todo?.status)
  )
  const live = tasks.filter((task) => !closed.includes(task))
  const placed = new Set<CompanyTaskRow>()
  const companies: CompanyTaskCompany[] = []
  for (const company of input.companies) {
    const slug = companySlug(company.slug ?? company.name ?? company.id ?? '')
    if (!slug) {
      continue
    }
    const departments = departmentGroups(slug, company.domains)
    const own: CompanyTaskRow[] = []
    for (const task of live) {
      if (placed.has(task)) {
        continue
      }
      const taskSlug = companySlug(task.row.todo?.company_slug ?? '')
      if (taskSlug !== slug) {
        continue
      }
      placed.add(task)
      const department = departments.find((entry) => entry.id === task.row.todo?.org_unit_id)
      const project = department?.projects.find((entry) => entry.id === task.row.todo?.project_id)
      if (project) {
        project.tasks.push(task)
      } else if (department) {
        department.tasks.push(task)
      } else {
        own.push(task)
      }
    }
    const all: CompanyTaskRow[] = [...own]
    for (const department of departments) {
      department.tasks.sort(byStanding)
      for (const project of department.projects) {
        project.tasks.sort(byStanding)
        count(project, project.tasks)
        all.push(...project.tasks)
      }
      const inDepartment = [...department.tasks, ...department.projects.flatMap((p) => p.tasks)]
      count(department, inDepartment)
      all.push(...department.tasks)
    }
    own.sort(byStanding)
    const node: CompanyTaskCompany = {
      ...group(companyTaskKey(slug), company.id ?? null, company.name ?? slug),
      slug,
      departments,
      tasks: own
    }
    count(node, all)
    companies.push(node)
  }
  return {
    companies,
    unfiled: live.filter((task) => !placed.has(task)).sort(byStanding),
    closed: closed.sort(byStanding)
  }
}
