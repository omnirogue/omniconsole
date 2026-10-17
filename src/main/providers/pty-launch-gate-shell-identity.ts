type ShellIdentity = {
  pid: number | null
  promise: Promise<number>
  resolve: (pid: number) => void
}

const identities = new WeakMap<object, ShellIdentity>()

export function trackLaunchGateShellIdentity(owner: object): void {
  const { promise, resolve } = Promise.withResolvers<number>()
  identities.set(owner, { pid: null, promise, resolve })
}

export function recordLaunchGateShellIdentity(owner: object, pid: number): void {
  const identity = identities.get(owner)
  if (identity && identity.pid === null && Number.isSafeInteger(pid) && pid > 0) {
    identity.pid = pid
    identity.resolve(pid)
  }
}

export async function waitForLaunchGateShellIdentity(owner: object): Promise<number> {
  const identity = identities.get(owner)
  if (!identity) {
    throw new Error('pty_launch_gate_shell_identity_unavailable')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      identity.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('pty_launch_gate_shell_identity_unverifiable')),
          15_000
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
