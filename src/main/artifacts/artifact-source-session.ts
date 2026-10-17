import type { ArtifactWriteRequest } from '../../shared/artifacts'
import type { ArtifactShareScope } from './artifact-share-record-store'
import { artifactSessionOriginOf } from './artifact-session-origin'
import { consolePublicationPrincipal } from '../backoffice/console-workflow-person'
import { ledgerSourceForSession } from '../session-ledger/ledger-lookup'

/** Never accept a caller-supplied ledger id or bind another account's restored pane. */
export function artifactSourceSessionRef(
  request: ArtifactWriteRequest,
  scope: ArtifactShareScope
): string | undefined {
  const paneKey = artifactSessionOriginOf(request)?.paneKey
  if (!paneKey || !scope.cloudUserId) {
    return undefined
  }
  const principal = consolePublicationPrincipal(scope.apiOrigin, scope.cloudUserId)
  return ledgerSourceForSession(paneKey, principal)?.ledgerId
}
