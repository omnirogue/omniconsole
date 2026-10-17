import { afterEach, expect, it } from 'vitest'
import { setOmniConsoleMcpSignInResolver } from './omni-console-mcp-auth'
import {
  isOmniConsoleMcpDefaultRequested,
  withOmniConsoleMcpLaunchDefaults
} from './omni-console-mcp-launch-context'

afterEach(() => setOmniConsoleMcpSignInResolver(null))

it('keeps concurrent authenticated requests and unhinted requests separate across awaits', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const hinted = withOmniConsoleMcpLaunchDefaults(true, async () => {
    entered.resolve()
    await release.promise
    expect(isOmniConsoleMcpDefaultRequested()).toBe(true)
  })
  await entered.promise
  await withOmniConsoleMcpLaunchDefaults(false, async () => {
    await Promise.resolve()
    expect(isOmniConsoleMcpDefaultRequested()).toBe(false)
  })
  expect(isOmniConsoleMcpDefaultRequested()).toBe(false)
  release.resolve()
  await hinted
})

it('revokes the request hint from detached asynchronous work once the RPC settles', async () => {
  const release = Promise.withResolvers<void>()
  let detached: Promise<boolean> | undefined
  await withOmniConsoleMcpLaunchDefaults(true, async () => {
    detached = release.promise.then(() => isOmniConsoleMcpDefaultRequested())
  })
  release.resolve()
  expect(await detached).toBe(false)
})

it('does not retain request eligibility after a failed launch', async () => {
  await expect(
    withOmniConsoleMcpLaunchDefaults(true, () => {
      throw new Error('launch failed')
    })
  ).rejects.toThrow('launch failed')
  expect(isOmniConsoleMcpDefaultRequested()).toBe(false)
})

it('still resolves the desktop owner live without a remote hint', async () => {
  let signedIn = true
  setOmniConsoleMcpSignInResolver(() => signedIn)
  await withOmniConsoleMcpLaunchDefaults(false, async () => {
    expect(isOmniConsoleMcpDefaultRequested()).toBe(true)
    signedIn = false
    expect(isOmniConsoleMcpDefaultRequested()).toBe(false)
  })
})
