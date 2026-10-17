import { useEffect, useRef } from 'react'
import {
  companiesApi,
  companiesErrorMessage,
  useCompaniesRead
} from '@/components/companies/companies-client'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import type { NextStepRecipient } from '../../../../shared/next-step-draft'
import type { NextStepLoad } from './use-next-step-recipients'

/**
 * Me is auto-selected exactly once: on first resolution, and only while the person has
 * never touched the recipient picker. `userTouchedRef` is that single latch — owned by
 * NextStepRecipientList, mutated synchronously (not via setState) inside its `touch()`
 * on any explicit interaction (a category button, a roster/agent tick, typing a
 * search), and never reset for the panel's life.
 *
 * The latch is a ref, not state: a passive effect (like the auto-pick effect below) is
 * scheduled after commit and can run after a click that landed in the same frame, so
 * reading a captured boolean prop would see a stale "not yet touched" value. Reading
 * `userTouchedRef.current` at RUN time instead always sees the latest truth, however
 * the effect happens to be interleaved with the click — this is also why the effect
 * never calls `setState`: nothing here may legitimately fire once the ref is set, so
 * there is no "adjust state after the fact" step for a defensive drop to undo.
 *
 * `autoPickedRef` is set (synchronously, in the same branch) only when THIS effect
 * made the pick — never for a draft reopened with a saved recipient already in place.
 * It's the one signal a caller may use to tell an auto-pick apart from a restored or
 * explicit one; inferring that from selection shape alone (e.g. "the sole recipient
 * happens to be me") would also match a saved draft or a deliberate single self-pick.
 */
export function useMeRecipient(
  people: NextStepLoad<TeamRosterPerson[]>,
  selected: readonly NextStepRecipient[],
  userTouchedRef: { readonly current: boolean },
  onTogglePerson: (person: TeamRosterPerson, ensureSelected?: boolean) => void
) {
  const profile = useCompaniesRead(() => companiesApi().me(), 'next-step-me')
  // Why: a failed read (thrown/rejected) and a valid-but-refused read (`{ ok: false }`,
  // e.g. an expired hub session) are both "we couldn't tell who you are" — distinct
  // from "we asked, and you have no matching employee".
  const profileError =
    profile.error != null
      ? companiesErrorMessage(profile.error)
      : profile.data?.ok === false
        ? (profile.data.reason ?? null)
        : null
  const employeeId = profile.data?.ok !== false ? profile.data?.user?.employee_id : null
  const person =
    employeeId && people.phase === 'ready'
      ? people.value.find((entry) => entry.id === employeeId)
      : undefined
  const rosterError = people.phase === 'error' ? people.message : null
  const initialized = useRef(false)
  const autoPickedRef = useRef(false)
  useEffect(() => {
    if (initialized.current || userTouchedRef.current) {
      return
    }
    if (selected.length > 0) {
      initialized.current = true
      return
    }
    if (person) {
      initialized.current = true
      autoPickedRef.current = true
      onTogglePerson(person, true)
    }
  }, [person, selected, onTogglePerson, userTouchedRef])
  return {
    person,
    loading: profile.loading || (!!employeeId && people.phase === 'loading'),
    rosterError,
    profileError,
    autoPickedRef,
    reloadProfile: profile.reload
  }
}
