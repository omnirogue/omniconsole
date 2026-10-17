import { getOrcaCloudAuthConfig } from '../omni-profiles/profile-cloud-auth-config'
import { readOrcaCloudSession } from '../omni-profiles/profile-cloud-session-store'
import { readProfileIndex } from '../omni-profiles/profile-index-store'
import {
  getOrcaProfileIndexPath,
  getProfileUserDataPath
} from '../omni-profiles/profile-storage-paths'

export function isElectronOmniConsoleMcpSignedIn(userDataPath?: string): boolean {
  if (!getOrcaCloudAuthConfig().configured) {
    return false
  }
  const stateDirectory = userDataPath ?? getProfileUserDataPath()
  const index = readProfileIndex(getOrcaProfileIndexPath(stateDirectory))
  const profile = index?.profiles.find((entry) => entry.id === index.activeProfileId)
  return Boolean(
    profile?.cloud && readOrcaCloudSession(profile.id, stateDirectory).status === 'found'
  )
}
