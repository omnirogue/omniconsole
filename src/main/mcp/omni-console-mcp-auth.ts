type OmniConsoleMcpSignInResolver = (userDataPath?: string) => boolean

let resolveSignIn: OmniConsoleMcpSignInResolver | null = null

/** The desktop owns cloud credentials; execution hosts receive only the sign-in capability. */
export function setOmniConsoleMcpSignInResolver(
  resolver: OmniConsoleMcpSignInResolver | null
): void {
  resolveSignIn = resolver
}

export function isOmniConsoleMcpSignedIn(userDataPath?: string): boolean {
  return resolveSignIn?.(userDataPath) ?? false
}
