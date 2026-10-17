import { getOrcaCloudAuthConfig } from '../omni-profiles/profile-cloud-auth-config'
import { runWithFreshOrcaCloudSession } from '../omni-profiles/profile-cloud-session-refresh'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { isFirstPartyCloudHost } from './artifact-cloud-first-party'

/**
 * The signed-in desktop bearer for a preview load, or null. Same rules as every artifact request:
 * never for a host that is not ours, and a missing sign-in just means the page loads without one
 * (public artifacts still render; private ones show the server's own sign-in answer).
 */
export async function resolveArtifactPreviewToken(
  userDataPath: string,
  apiOrigin: string
): Promise<string | null> {
  const config = getOrcaCloudAuthConfig()
  if (!config.configured || !isFirstPartyCloudHost(apiOrigin, config.config.apiBaseUrl)) {
    return null
  }
  const active = ensureActiveOrcaProfile(userDataPath)
  if (!active.profile.cloud) {
    return null
  }
  const result = await runWithFreshOrcaCloudSession(
    config.config,
    active,
    userDataPath,
    async (cloudSession) => cloudSession.accessToken
  )
  return result.status === 'ok' ? result.value : null
}
