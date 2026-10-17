import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { getOrcaCloudAuthConfig } from '../omni-profiles/profile-cloud-auth-config'
import { runWithFreshOrcaCloudSession } from '../omni-profiles/profile-cloud-session-refresh'

/** The signed-in member's access token, or null (not signed in / expired
 * beyond refresh). Never throws — an unauthenticated fetch is still valid in
 * mode-off local deployments. */
export async function currentBearerToken(): Promise<string | null> {
  try {
    const config = getOrcaCloudAuthConfig()
    if (!config.configured) {
      return null
    }
    const userDataPath = getProfileUserDataPath()
    const active = ensureActiveOrcaProfile(userDataPath)
    const result = await runWithFreshOrcaCloudSession(
      config.config,
      active,
      userDataPath,
      async (session) => session.accessToken
    )
    return result.status === 'ok' ? result.value : null
  } catch {
    return null
  }
}
