import { describe, expect, it } from 'vitest'
import {
  OUTCOME_CONTINUATION_SWITCH,
  OutcomeContinuationLifecycle,
  outcomeContinuationRelaunchPlan
} from './outcome-continuation-lifecycle'
import { argvRequestsServeMode, normalizeServeModeArgv } from './serve-mode-argv'

const ordinaryQuit = {
  pending: true,
  ownsProfile: true,
  updateInstalling: false,
  replacementScheduled: false,
  devParentEnding: false
}

describe('outcome continuation lifecycle', () => {
  it('continues unfinished work after a desktop quits, including a promoted serve owner', () => {
    const lifecycle = new OutcomeContinuationLifecycle()
    expect(lifecycle.shouldRelaunch(ordinaryQuit)).toBe(false)
    lifecycle.noteDesktopOpened()
    expect(lifecycle.shouldRelaunch(ordinaryQuit)).toBe(true)
  })

  it.each([
    { pending: false },
    { ownsProfile: false },
    { updateInstalling: true },
    { replacementScheduled: true },
    { devParentEnding: true }
  ])('does not duplicate a replacement or defeat an intentional stop: %j', (change) => {
    const lifecycle = new OutcomeContinuationLifecycle()
    lifecycle.noteDesktopOpened()
    expect(lifecycle.shouldRelaunch({ ...ordinaryQuit, ...change })).toBe(false)
  })

  it('does not restart during logout or OS shutdown', () => {
    const lifecycle = new OutcomeContinuationLifecycle()
    lifecycle.noteDesktopOpened()
    lifecycle.noteSystemEnding()
    expect(lifecycle.shouldRelaunch(ordinaryQuit)).toBe(false)
  })

  it('uses resolved entry/profile when launcher switches precede the development app', () => {
    expect(
      outcomeContinuationRelaunchPlan(
        [
          '/Electron',
          '--password-store=basic',
          '--use-mock-keychain',
          '/worktree',
          '--remote-debugging-port=9222',
          '--user-data-dir',
          '/stale-profile',
          'omni://auth/callback?code=one-use'
        ],
        false,
        { appPath: '/worktree', userDataPath: '/profiles/isolated' }
      ).args
    ).toEqual([
      '--password-store=basic',
      '--use-mock-keychain',
      '/worktree',
      '--user-data-dir',
      '/profiles/isolated',
      '--serve',
      '--serve-no-pairing',
      '--serve-port',
      '0',
      OUTCOME_CONTINUATION_SWITCH
    ])
  })

  it('does not depend on a development argv entry or replay inspector/preload arguments', () => {
    expect(
      outcomeContinuationRelaunchPlan(
        [
          '/Electron',
          '-r',
          '/playwright/loader.js',
          '--inspect=0',
          '--remote-debugging-port=0',
          '--no-sandbox',
          '/worktree',
          '--disable-gpu'
        ],
        false,
        { appPath: '/worktree', userDataPath: '/profiles/isolated' }
      ).args
    ).toEqual([
      '--no-sandbox',
      '--disable-gpu',
      '/worktree',
      '--user-data-dir',
      '/profiles/isolated',
      '--serve',
      '--serve-no-pairing',
      '--serve-port',
      '0',
      OUTCOME_CONTINUATION_SWITCH
    ])
  })

  it('uses the canonical profile even when the original profile came from the environment', () => {
    expect(
      outcomeContinuationRelaunchPlan(['/Electron'], false, {
        appPath: '/worktree with spaces',
        userDataPath: '/profiles/isolated profile'
      }).args
    ).toEqual([
      '/worktree with spaces',
      '--user-data-dir',
      '/profiles/isolated profile',
      '--serve',
      '--serve-no-pairing',
      '--serve-port',
      '0',
      OUTCOME_CONTINUATION_SWITCH
    ])
  })

  it('does not expose pairing or carry a stale profile or server port into a packaged replacement', () => {
    expect(
      outcomeContinuationRelaunchPlan(
        [
          '/Applications/OmniConsole',
          '--serve',
          '--serve-mobile-pairing',
          '--serve-port',
          '4000',
          '--user-data-dir=/profiles/stale'
        ],
        true,
        {
          appPath: '/Applications/OmniConsole.app/Contents/Resources/app.asar',
          userDataPath: '/profiles/second'
        }
      ).args
    ).toEqual([
      '--user-data-dir',
      '/profiles/second',
      '--serve',
      '--serve-no-pairing',
      '--serve-port',
      '0',
      OUTCOME_CONTINUATION_SWITCH
    ])
  })
})

describe('continuation argv as the replacement reads it', () => {
  it('retains the verified paired listener without replaying pairing or a stale argv port', () => {
    const plan = outcomeContinuationRelaunchPlan(
      ['/Applications/OmniConsole', '--serve-port', '4000', '--serve-mobile-pairing'],
      true,
      { appPath: '/app', userDataPath: '/profile', pairedListenerPort: 6768 }
    )
    expect(plan.args).toEqual([
      '--user-data-dir',
      '/profile',
      '--serve',
      '--serve-no-pairing',
      '--serve-port',
      '6768',
      OUTCOME_CONTINUATION_SWITCH
    ])
  })

  it.each([0, -1, 65_536, 1.5, Number.NaN])('rejects invalid paired listener port %s', (port) => {
    const plan = outcomeContinuationRelaunchPlan(['/Applications/OmniConsole'], true, {
      appPath: '/app',
      userDataPath: '/profile',
      pairedListenerPort: port
    })
    expect(plan.args[plan.args.indexOf('--serve-port') + 1]).toBe('0')
  })

  const replacementArgv = (): string[] => [
    '/Applications/OmniConsole',
    ...outcomeContinuationRelaunchPlan(['/Applications/OmniConsole'], true, {
      appPath: '/Applications/OmniConsole.app/Contents/Resources/app.asar',
      userDataPath: '/profiles/second'
    }).args
  ]

  it('still reads as a serve launch once the continuation marker rides along', () => {
    expect(argvRequestsServeMode(replacementArgv())).toBe(true)
  })

  it('survives the CLI-form rewrite untouched, so the marker reaches the child verbatim', () => {
    const argv = replacementArgv()
    expect(normalizeServeModeArgv(argv)).toEqual(argv)
    expect(argv).toContain(OUTCOME_CONTINUATION_SWITCH)
  })
})

describe('dropped continuation switches', () => {
  const plan = (argv: string[]): string[] =>
    outcomeContinuationRelaunchPlan(argv, true, {
      appPath: '/Applications/OmniConsole.app/Contents/Resources/app.asar',
      userDataPath: '/profiles/second'
    }).droppedSwitches

  it('names every refused switch once, without its value', () => {
    expect(
      plan([
        '/Applications/OmniConsole',
        '--remote-debugging-port=9334',
        '--inspect=0',
        '-r',
        '/playwright/loader.js',
        '--remote-debugging-port=9335'
      ])
    ).toEqual(['--remote-debugging-port', '--inspect', '-r'])
  })

  it('stays quiet for an ordinary quit, so the warning means something when it fires', () => {
    expect(plan(['/Applications/OmniConsole'])).toEqual([])
    expect(plan(['/Electron', '--no-sandbox', '--password-store=basic', '/worktree'])).toEqual([])
  })

  it('does not report the switches the relaunch writes itself', () => {
    expect(
      plan([
        '/Applications/OmniConsole',
        '--serve',
        '--serve-mobile-pairing',
        '--serve-port',
        '4000',
        '--user-data-dir=/profiles/stale',
        OUTCOME_CONTINUATION_SWITCH
      ])
    ).toEqual([])
  })

  it('never reports a consumed value, an entry path, or a one-use deep link', () => {
    expect(
      plan([
        '/Applications/OmniConsole',
        '/worktree',
        'omni://auth/callback?code=one-use',
        '--user-data-dir',
        '/profiles/stale'
      ])
    ).toEqual([])
  })
})
