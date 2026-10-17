import type { Automation } from '../../../../../shared/automations-types'
import { routineTeamCopy as copy } from './routine-team-copy'
import type {
  TeamRoutine,
  TeamRoutineCreateRequest
} from '../../../../../shared/console-team-routines-contract'

export type RoutineTeamLink = {
  teamRoutineId: string
  convertedAt: string
  state: 'pending' | 'enabled' | 'linked'
  nextDue?: string | null
}
const inflight = new Set<string>()
export const routineConversionBusy = (id: string): boolean => inflight.has(id)

export function routineTeamBody(
  automation: Automation,
  cron: string,
  scope: string
): TeamRoutineCreateRequest {
  return {
    name: automation.name,
    description: '',
    trigger_type: 'cron',
    trigger_config: { cron },
    // HubRoutineSheet.tsx hubRoutineSettingsPatch uses title + prompt.
    task_template: { title: automation.name, prompt: automation.prompt },
    status: 'disabled',
    scope,
    purpose: 'ai'
  }
}

/** Persist each completed step so retries never recreate or repeat a confirmed enable. */
export async function convertRoutineToTeam(args: {
  id: string
  link?: RoutineTeamLink
  create: () => Promise<{ id: string }>
  enable: (id: string) => Promise<Pick<TeamRoutine, 'status' | 'next_due'>>
  disable: () => Promise<void>
  save: (link: RoutineTeamLink) => void
}): Promise<void> {
  if (inflight.has(args.id)) {
    return
  }
  inflight.add(args.id)
  try {
    let link = args.link
    if (!link) {
      const created = await args.create()
      if (!created.id?.trim()) {
        throw new Error(copy.failed())
      }
      link = {
        teamRoutineId: created.id,
        convertedAt: new Date().toISOString(),
        state: 'pending'
      }
      args.save(link)
    }
    if (link.state === 'pending') {
      const enabled = await args.enable(link.teamRoutineId)
      if (enabled.status !== 'active') {
        throw new Error(copy.enableUnconfirmed())
      }
      link = { ...link, state: 'enabled', nextDue: enabled.next_due }
      args.save(link)
    }
    if (link.state === 'enabled') {
      await args.disable()
      args.save({ ...link, state: 'linked' })
    }
  } finally {
    inflight.delete(args.id)
  }
}
