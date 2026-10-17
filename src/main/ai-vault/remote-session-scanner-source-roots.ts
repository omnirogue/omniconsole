import { posix, win32 } from 'node:path'
import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'

export type RemoteSessionSourceRoots = {
  grokHome?: string
  kimiCodeHome?: string
  rovoSessionsDir?: string
}

/** Called only inside the owning relay; an SSH client must never pass its own environment. */
export function remoteSessionSourceRootsFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): RemoteSessionSourceRoots {
  const grokHome = owningRoot('GROK_HOME', env.GROK_HOME, remoteHome, hostPlatform)
  const kimiCodeHome = owningRoot('KIMI_CODE_HOME', env.KIMI_CODE_HOME, remoteHome, hostPlatform)
  return {
    ...(grokHome ? { grokHome } : {}),
    ...(kimiCodeHome ? { kimiCodeHome } : {})
  }
}

function owningRoot(
  name: string,
  raw: string | undefined,
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): string | undefined {
  const value = raw?.trim()
  if (!value) {
    return undefined
  }
  const root =
    value === '~'
      ? remoteHome
      : value.startsWith('~/')
        ? joinRemotePath(hostPlatform, remoteHome, ...value.slice(2).split('/'))
        : value
  const paths = hostPlatform.pathFlavor === 'windows' ? win32 : posix
  if (!paths.isAbsolute(root) || root.includes('\0')) {
    throw new Error(`${name} must name an absolute directory on the owning host.`)
  }
  return root
}
