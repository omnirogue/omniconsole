import { useAppStore } from '@/store'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'

/**
 * The account, organisation and environment every Console task, handoff and review
 * read belongs to. Views keyed by it drop another scope's rows and drafts on switch.
 */
export function useHandoffScope(): string {
  return useAppStore(selectConsoleAccountScope)
}
