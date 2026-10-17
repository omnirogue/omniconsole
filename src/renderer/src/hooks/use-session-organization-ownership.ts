import { useEffect } from 'react'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import {
  installSessionOrganizationOwnership,
  refreshSessionOrganizationOwnership
} from '@/lib/session-organization-ownership'

/**
 * Keeps the window's ownership mirror in force: the revision check and the mirror's ear on every
 * applied change, and main's copy read back at start and whenever the account scope changes.
 */
export function useSessionOrganizationOwnershipMirror(): void {
  const scope = useHandoffScope()
  useEffect(() => installSessionOrganizationOwnership(), [])
  useEffect(() => {
    void refreshSessionOrganizationOwnership()
  }, [scope])
}
