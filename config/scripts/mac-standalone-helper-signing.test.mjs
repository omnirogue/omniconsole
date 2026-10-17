import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { expect, it, vi } from 'vitest'

const { signMacAppWithStandaloneHelpers, signMacStandaloneHelpers } = createRequire(
  import.meta.url
)('./mac-standalone-helper-signing.cjs')
const helpers = ['omni-notification-status', 'omni-keyboard-layout', 'omni-pty-process-observer']

it('seals the app only after its initially unsigned Intel sidecars have verified signatures', async () => {
  const signatures = new Map()
  const verified = new Set()
  const seal = vi.fn(() => {
    for (const name of helpers) {
      if (!verified.has(name) || signatures.get(name) !== 'developer-id') {
        throw new Error(`Unsigned subcomponent: ${name}`)
      }
    }
  })
  await signMacAppWithStandaloneHelpers({
    app: '/candidate/OmniConsole.app',
    identity: 'developer-id',
    entitlements: '/candidate/entitlements.plist',
    execute: (command, args) => {
      expect(command).toBe('codesign')
      const name = basename(args.at(-1))
      if (args.includes('--sign')) {
        expect(args).toEqual(expect.arrayContaining(['--options', 'runtime', '--timestamp']))
        signatures.set(name, args[args.indexOf('--sign') + 1])
      } else if (signatures.has(name)) {
        verified.add(name)
      } else {
        throw new Error(`Cannot verify unsigned helper: ${name}`)
      }
    },
    seal
  })
  expect(seal).toHaveBeenCalledOnce()
})

it('refuses to seal when a native helper signature cannot be verified', async () => {
  const seal = vi.fn()
  await expect(
    signMacAppWithStandaloneHelpers({
      app: '/candidate/OmniConsole.app',
      identity: 'developer-id',
      execute: (_command, args) => {
        if (args.includes('--verify') && args.at(-1).endsWith('omni-pty-process-observer')) {
          throw new Error('Invalid helper signature')
        }
      },
      seal
    })
  ).rejects.toThrow('Invalid helper signature')
  expect(seal).not.toHaveBeenCalled()
})

it('keeps fleet staging ad-hoc and does not request a certificate timestamp', () => {
  const execute = vi.fn()
  signMacStandaloneHelpers({ app: '/candidate/OmniConsole.app', identity: '-', execute })
  const signingCalls = execute.mock.calls.filter(([, args]) => args.includes('--sign'))
  expect(signingCalls).toHaveLength(3)
  for (const [, args] of signingCalls) {
    expect(args[args.indexOf('--sign') + 1]).toBe('-')
    expect(args).not.toContain('--timestamp')
    expect(args).not.toContain('runtime')
  }
})
