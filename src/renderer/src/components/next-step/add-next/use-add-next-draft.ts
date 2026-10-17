import { emptyNextStepDraft } from '../../../../../shared/next-step-draft'
import type { NextStepSubject } from '../next-step-subject'
import { useSessionWorkDraft } from '../use-session-work-draft'
import type { FleetTarget } from './dispatch-to-fleet'
import type { MenuLevel } from './menu-levels'

export function useAddNextDraft(
  subject: NextStepSubject,
  dispatch: boolean,
  initialKind?: 'agent' | 'person'
) {
  const key = dispatch ? 'dispatch-menu' : 'handoff-menu'
  const draft = useSessionWorkDraft(subject, `${key}:draft`, emptyNextStepDraft)
  const target = useSessionWorkDraft<FleetTarget | null>(subject, `${key}:target`, () => null)
  const levels = useSessionWorkDraft<MenuLevel[]>(subject, `${key}:levels`, () => [])
  const current = useSessionWorkDraft(subject, `${key}:current`, () => 0)
  const mode = useSessionWorkDraft<MenuLevel['mode']>(subject, `${key}:mode`, () => 'handoff')
  const kind = useSessionWorkDraft<'agent' | 'person' | null>(
    subject,
    `${key}:kind`,
    () => initialKind ?? null
  )
  return {
    draft,
    target,
    levels,
    current,
    mode,
    kind,
    clear: () => {
      for (const field of [draft, target, levels, current, mode, kind]) {
        field[2]()
      }
    }
  }
}
