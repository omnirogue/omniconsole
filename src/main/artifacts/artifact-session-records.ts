import {
  type ArtifactSessionRecord,
  artifactContentUrl,
  sanitizeArtifactSessionOrigin
} from '../../shared/artifact-session'
import { prepareArtifactCloudUse } from '../omni-profiles/profile-artifact-cloud-cleanup'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { resolveArtifactCloudApiUrl } from './artifact-cloud-config'
import { type ArtifactShareScope, listArtifactShareRecords } from './artifact-share-record-store'

/**
 * The renderer-safe view of the scope's share records, newest first. Built field by field so the
 * edit token (and anything a later record version adds) can never ride along by spread.
 */
export function listArtifactSessionRecordsForScope(
  profileId: string,
  userDataPath: string,
  scope: ArtifactShareScope
): ArtifactSessionRecord[] {
  return listArtifactShareRecords(profileId, userDataPath, scope)
    .map(([sourceKey, record]): ArtifactSessionRecord => ({
      slug: record.slug,
      shareUrl: record.shareUrl,
      sourceKey,
      savedAt: record.savedAt ?? null,
      contentUrl: artifactContentUrl(scope.apiOrigin, record.slug),
      origin: sanitizeArtifactSessionOrigin(record.origin)
    }))
    .sort((left, right) => (right.savedAt ?? -1) - (left.savedAt ?? -1))
}

/**
 * Local and synchronous on purpose: this answers "which artifacts has this device published", so it
 * needs no token and makes no request. Records made with a development token override stay out,
 * because the preview can only authenticate as the signed-in account.
 */
export function listArtifactSessionRecords(userDataPath: string): ArtifactSessionRecord[] {
  const apiOrigin = resolveArtifactCloudApiUrl()
  const active = ensureActiveOrcaProfile(userDataPath)
  prepareArtifactCloudUse(active.profile, userDataPath)
  const cloud = active.profile.cloud
  if (!cloud) {
    return []
  }
  return listArtifactSessionRecordsForScope(active.profile.id, userDataPath, {
    cloudUserId: cloud.userId,
    cloudProfileId: cloud.cloudProfileId,
    cloudOrganizationId: cloud.activeOrgId ?? '',
    apiOrigin
  })
}
