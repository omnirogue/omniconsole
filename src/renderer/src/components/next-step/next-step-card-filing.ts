import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { companiesApi, companiesData } from '@/components/companies/companies-client'
import { readWorkFolders, workFoldersScope } from '@/components/companies/use-work-folders'
import { getCompanyFolderHome } from '@/lib/company-folder-home'
import { companyPlaceForPath, type CompanyPlace } from '@/lib/company-place'
import type { CompanyGoal } from '../../../../shared/console-companies-contract'
import { OMNIOS_WORK_URL } from '../../../../shared/omnios-task-binding'

/** Where a new card belongs, in the ids the hub files by. */
export type NextStepCardFiling = { companyId: string; unitId: string; goalId: string }

/** Why no card can be created here, in the console's own words, and where to fix it. */
export type NextStepFilingRefusal = { reason: string; actionUrl: string }

const GOAL_ID = /^cgl_[A-Za-z0-9_-]{1,128}$/

/**
 * The hub takes one status and no synonym: "goal_id must name an ACTIVE goal of this
 * company". Treating paused or archived as good enough put a paused goal on a card and
 * the create was refused, so only `active` counts here too.
 */
export function isActiveCompanyGoal(goal: CompanyGoal): boolean {
  return (
    Boolean(goal.id && GOAL_ID.test(goal.id)) &&
    (goal.status ?? '').trim().toLowerCase() === 'active'
  )
}

/**
 * The console refuses to run a card that is not filed under a company, a department and a
 * goal, and it never invents a goal for an admin who can create in several places. This is
 * that sentence, said before anything is created rather than after.
 */
function refusal(detail?: string): NextStepFilingRefusal {
  const sentence = translate(
    'nextStep.cardFilingRequired',
    "Complete the task's company, goal and department before dispatching."
  )
  return {
    reason: detail ? `${sentence} ${detail}` : sentence,
    actionUrl: `${OMNIOS_WORK_URL}/work`
  }
}

/**
 * The company and department (by name and id) whose folder this conversation's workspace
 * sits in — the same mapping the Companies tree files by. Null outside every company.
 */
export async function resolveNextStepPlace(worktreeId: string): Promise<CompanyPlace | null> {
  const state = useAppStore.getState()
  const path = state.getKnownWorktreeById(worktreeId)?.path ?? null
  if (!path) {
    return null
  }
  const home = await getCompanyFolderHome()
  const folders = await readWorkFolders(workFoldersScope())
  return companyPlaceForPath(folders.companies, path, {
    home,
    workRoot: state.settings?.companyWorkRoot,
    overrides: state.settings?.companyFolders
  })
}

/**
 * Where the card for this conversation must be filed: the company and department whose
 * folder the workspace sits in (the same mapping the Companies tree files by), and that
 * department's open goal. Anything missing is a refusal — an unfiled card is a stray the
 * hub will not dispatch, so none is created.
 */
/** A company and department the person chose for this conversation over its folder's. */
export type NextStepPreferredPlace = { companyId: string; unitId: string; unitName?: string }

export async function resolveNextStepCardFiling(
  worktreeId: string,
  /** A goal this conversation is already tied to; it wins over the department's first. */
  preferredGoalId?: string | null,
  preferredPlace?: NextStepPreferredPlace | null
): Promise<{ filing: NextStepCardFiling } | { refusal: NextStepFilingRefusal }> {
  if (!useAppStore.getState().getKnownWorktreeById(worktreeId)?.path) {
    return { refusal: refusal() }
  }
  try {
    const place = preferredPlace ? null : await resolveNextStepPlace(worktreeId)
    const companyId = preferredPlace?.companyId ?? place?.company.id ?? null
    const unitId = preferredPlace?.unitId ?? place?.domain?.id ?? null
    const unitName = preferredPlace ? preferredPlace.unitName : place?.domain?.name
    // Why: a conversation in the company root has no department, and the hub files by
    // department; guessing one would put the work in front of the wrong people.
    if (!companyId || !unitId) {
      return { refusal: refusal() }
    }
    const company = companiesData(await companiesApi().company({ companyId }))
    const goals = (company.goals.items ?? []).filter(
      (goal) => goal.org_unit_id === unitId && isActiveCompanyGoal(goal)
    )
    const goal = goals.find((entry) => entry.id === preferredGoalId) ?? goals[0]
    if (!goal?.id) {
      // Why: "no goal" is not the same problem as "no department"; naming the department
      // and what it lacks is the difference between a person fixing it and guessing.
      return {
        refusal: refusal(
          translate('nextStep.cardFilingNoActiveGoal', '{{department}} has no active goal.', {
            department: unitName ?? unitId
          })
        )
      }
    }
    return { filing: { companyId, unitId, goalId: goal.id } }
  } catch (cause) {
    // Why: a card minted while the estate's filing could not be read would be the stray this
    // whole path exists to prevent; the read failure is said instead.
    return {
      refusal: {
        reason: translate(
          'nextStep.cardFilingUnreadable',
          'Where this work is filed could not be read, so no card was created: {{message}}',
          { message: cause instanceof Error ? cause.message : String(cause) }
        ),
        actionUrl: `${OMNIOS_WORK_URL}/work`
      }
    }
  }
}
