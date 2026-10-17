import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { prepareArtifactCloudUse } from '../omni-profiles/profile-artifact-cloud-cleanup'
import type { ArtifactShareScope } from './artifact-share-record-store'

/**
 * The signed-in profile's share-record scope on this desktop; null when not signed in. Why the
 * origin is passed in: the runtime reads it from its artifact service, so this stays Node-only.
 */
export function activeArtifactShareScope(
  userDataPath: string,
  apiOrigin: string | null
): { profileId: string; scope: ArtifactShareScope } | null {
  if (!apiOrigin) {
    return null
  }
  const active = ensureActiveOrcaProfile(userDataPath)
  prepareArtifactCloudUse(active.profile, userDataPath)
  const cloud = active.profile.cloud
  if (!cloud) {
    return null
  }
  return {
    profileId: active.profile.id,
    scope: {
      cloudUserId: cloud.userId,
      cloudProfileId: cloud.cloudProfileId,
      cloudOrganizationId: cloud.activeOrgId ?? '',
      apiOrigin
    }
  }
}
