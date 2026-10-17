import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { SessionManageSidebarRow } from '../../../shared/session-manage-relay'
import { mirroredConversationComputerName } from './activate-mirrored-conversation'
import { recordOnlyMirrorRowFlags } from './mirror-row-owner-evidence'
import type { SidebarSession } from './sidebar-sessions'

/** A conversation its paired owner runs and lists: its execution owner is that computer. */
function listedByOwner(session: Pick<SidebarSession, 'mirroredConversation'>): boolean {
  return session.mirroredConversation?.listed === true
}

/**
 * C4/F10 (session parity, step 7): a row a paired computer's ledger LISTS is a conversation that
 * computer runs and shows, so its execution owner is that computer: deleting it here (closing its
 * mirror tab, or marking its row) would not reach it. Such rows are refused with "Delete it on
 * <Computer>"; every other row — this computer's own, a direct-SSH one, a receiver-only capture,
 * and a capture the owner only holds as passive evidence without listing it (`listed: false`,
 * G1: the owner shows no row to delete, so this computer's own copy goes as before) — deletes as
 * before. Returns the rows that may go.
 */
export function refuseMirroredConversationDeletes<T extends SidebarSession>(
  sessions: readonly T[]
): T[] {
  const refused = sessions.filter(listedByOwner)
  if (refused.length === 0) {
    return [...sessions]
  }
  const computers = [...new Set(refused.map(mirroredConversationComputerName))]
  toast.error(
    computers.length === 1
      ? translate('conversations.mirroredConversationDeleteOn', 'Delete it on {{computer}}.', {
          computer: computers[0]
        })
      : translate(
          'conversations.mirroredConversationDeleteOnOwners',
          'Delete them on the computers that run them.'
        ),
    {
      description:
        refused.length === 1
          ? translate(
              'conversations.mirroredConversationDeleteRefused',
              '“{{name}}” runs there, so it was not deleted here.',
              { name: refused[0]!.label }
            )
          : translate(
              'conversations.mirroredConversationDeleteRefusedMany',
              '{{count}} run on another computer, so they were not deleted here.',
              { count: refused.length }
            )
    }
  )
  return sessions.filter((session) => !listedByOwner(session))
}

/**
 * A relay row's delete evidence: a row the owner's ledger lists names the paired computer that
 * runs and lists it (main refuses its delete, `--unverified` included); a capture the owner holds
 * without listing it is judged as the record-only row it is (main then asks for `--unverified`,
 * and only this computer's record goes); any other row keeps its record-only flags.
 */
export function sessionManageDeleteEvidence(
  state: Parameters<typeof recordOnlyMirrorRowFlags>[0],
  session: SidebarSession
): Pick<
  SessionManageSidebarRow,
  'recordOnlyMirror' | 'strandedMirrorRecord' | 'mirroredConversationOwner'
> {
  const { mirroredConversation: vouch, ...own } = session
  if (vouch?.listed) {
    return { mirroredConversationOwner: vouch.environmentId }
  }
  return recordOnlyMirrorRowFlags(state, own)
}
