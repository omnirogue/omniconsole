import { companiesData } from '@/components/companies/companies-client'
import { teamRoutinesApi } from './team-routines-client'
import { TEAM_ROUTINES_CHANGED, readRoutineTeamLink } from './routine-team-links'
import { routineConversionBusy } from './routine-team-conversion'
import { routineTeamCopy as copy } from './routine-team-copy'
import { toast } from 'sonner'
import type { Automation, AutomationUpdateInput } from '../../../../../shared/automations-types'
import {
  deleteAutomationForTarget,
  runAutomationNowForTarget,
  updateAutomationForTarget,
  type AutomationHostTarget
} from '@/components/automations/automation-host-client'
import { translate } from '@/i18n/i18n'
import { emitAutomationsChangedWindowEvent } from '@/lib/automations-changed-window-event'

const restoring = new Set<string>()

/** What a routine row can do to its automation; every call reports failure with a toast. */
export type RoutineCommands = {
  target: AutomationHostTarget
  /** Optimistic: the list shows `updates` at once and rolls back when the host refuses. */
  update: (automation: Automation, updates: AutomationUpdateInput) => Promise<boolean>
  setEnabled: (automation: Automation, enabled: boolean) => Promise<boolean>
  rename: (automation: Automation, name: string) => Promise<boolean>
  runNow: (automation: Automation) => Promise<boolean>
  remove: (automation: Automation) => Promise<boolean>
}

export function routineErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function createRoutineCommands(args: {
  target: AutomationHostTarget
  patch: (id: string, patch: Partial<Automation>) => void
  remove: (id: string) => void
}): RoutineCommands {
  const { target, patch } = args
  const changed = (): void =>
    emitAutomationsChangedWindowEvent(
      target.kind === 'environment' ? { environmentId: target.environmentId } : {}
    )
  const update: RoutineCommands['update'] = async (automation, updates) => {
    if (updates.enabled && (restoring.has(automation.id) || routineConversionBusy(automation.id))) {
      return false
    }
    if (updates.enabled) {
      restoring.add(automation.id)
    }
    let patched = false
    try {
      const link = readRoutineTeamLink(automation.id)
      if (updates.enabled && link) {
        const team = companiesData(await teamRoutinesApi().get({ id: link.teamRoutineId }))
        if (team.status !== 'disabled') {
          if (team.viewer_role === 'owner' && window.confirm(copy.alsoDisable())) {
            const disabled = companiesData(
              await teamRoutinesApi().disable({ id: link.teamRoutineId })
            )
            if (disabled.status !== 'disabled') {
              throw new Error(copy.disableUnconfirmed())
            }
            window.dispatchEvent(new Event(TEAM_ROUTINES_CHANGED))
          } else if (!window.confirm(copy.doubleRun())) {
            return false
          }
        }
      }
      const { launchPreferences, structuredOutput, ...fields } = updates
      patch(automation.id, {
        ...fields,
        ...(launchPreferences !== undefined
          ? { launchPreferences: launchPreferences ?? undefined }
          : {}),
        ...(structuredOutput !== undefined
          ? { structuredOutput: structuredOutput ?? undefined }
          : {})
      })
      patched = true
      const saved = await updateAutomationForTarget(automation, updates, target)
      patch(automation.id, saved)
      changed()
      return true
    } catch (error) {
      // Why: roll back only the fields this call touched; a refresh may have moved the rest on.
      if (patched) {
        patch(
          automation.id,
          Object.fromEntries(
            Object.keys(updates).map((key) => [key, automation[key as keyof Automation]])
          )
        )
      }
      toast.error(
        routineErrorMessage(
          error,
          translate('routines.updateFailed', 'The routine could not be updated.')
        )
      )
      return false
    } finally {
      if (updates.enabled) {
        restoring.delete(automation.id)
      }
    }
  }
  return {
    target,
    update,
    setEnabled: (automation, enabled) => update(automation, { enabled }),
    rename: (automation, name) => {
      const trimmed = name.trim()
      return trimmed && trimmed !== automation.name
        ? update(automation, { name: trimmed })
        : Promise.resolve(false)
    },
    runNow: async (automation) => {
      try {
        await runAutomationNowForTarget(automation, target)
        toast.success(
          translate('routines.runStarted', '{{name}} is starting.', {
            name: automation.name
          })
        )
        changed()
        return true
      } catch (error) {
        toast.error(
          routineErrorMessage(error, translate('routines.runFailed', 'The routine did not start.'))
        )
        return false
      }
    },
    remove: async (automation) => {
      try {
        await deleteAutomationForTarget(automation, target)
        args.remove(automation.id)
        toast.success(
          translate('routines.deleted', 'Deleted {{name}}.', {
            name: automation.name
          })
        )
        changed()
        return true
      } catch (error) {
        toast.error(
          routineErrorMessage(
            error,
            translate('routines.deleteFailed', 'The routine could not be deleted.')
          )
        )
        return false
      }
    }
  }
}

/** Row and People actions share the per-automation in-flight guard. */
export function makeRoutineTeam(automation: Automation, open: () => void): void {
  if (!routineConversionBusy(automation.id)) {
    open()
  }
}
