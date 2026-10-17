import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  appCodePids,
  classifyBundleProcesses,
  holdsAppProfile,
  parseWindowOwnerPids,
  promoteWindowedHeadlessRuns,
  splitByPreSwap,
  windowOwnersOsascriptArgs
} from './install-mac-local-lib.mjs'

describe('install-mac-local continuation host versus the windowed app', () => {
  const executable = '/Applications/OmniConsole.app/Contents/MacOS/OmniConsole'
  const profile = '/Users/x/Library/Application Support/omniconsole-ide'
  const host = `${executable} --user-data-dir ${profile} --serve --serve-no-pairing --serve-port 6768 --outcome-continuation`
  // What a headless serve host really has under it: a GPU helper, utility services and, with the
  // offscreen browser backend, renderers too — none of which is a window on screen.
  const headlessChildren = [
    `70813 ${executable} Helper --type=gpu-process --user-data-dir=${profile}`,
    `70815 ${executable} Helper --type=utility --utility-sub-type=network.mojom.NetworkService`,
    '2505 /Applications/OmniConsole.app/Contents/Frameworks/OmniConsole Helper (Renderer).app/Contents/MacOS/OmniConsole Helper (Renderer) --type=renderer'
  ].join('\n')

  it('keeps a headless continuation host with GPU and renderer helpers headless when it owns no window', () => {
    // The 1.12.28 install (2026-10-12): this host read as the app, so the quit wait timed out on the
    // MacBook and the old host was never stopped on the Mac Studio.
    const promoted = promoteWindowedHeadlessRuns(
      classifyBundleProcesses(`70675 ${host}`),
      () => headlessChildren,
      new Set([96018, 28848])
    )
    expect(promoted.app).toEqual([])
    expect(promoted.headless.map((entry) => entry.pid)).toEqual([70675])
    expect(holdsAppProfile(promoted.headless[0].command, profile)).toBe(true)
  })

  it('promotes the same host to the app once it owns an on-screen window', () => {
    const promoted = promoteWindowedHeadlessRuns(
      classifyBundleProcesses(`70675 ${host}`),
      () => headlessChildren,
      new Set([70675, 96018])
    )
    expect(promoted.app.map((entry) => entry.pid)).toEqual([70675])
    expect(promoted.headless).toEqual([])
  })

  it('without a window list, a GPU helper alone does not make a host the app', () => {
    const promoted = promoteWindowedHeadlessRuns(
      classifyBundleProcesses(`70675 ${host}`),
      () => `70813 ${executable} Helper --type=gpu-process`,
      null
    )
    expect(promoted.app).toEqual([])
    expect(promoted.headless.map((entry) => entry.pid)).toEqual([70675])
  })

  it('never reclassifies the plain app, CLI runs or other processes by window ownership', () => {
    const promoted = promoteWindowedHeadlessRuns(
      classifyBundleProcesses(
        [
          `500 ${executable}`,
          `501 ${executable} /out/cli/index.js claude-teams`,
          `502 ${executable} --serve --serve-port 0`
        ].join('\n')
      ),
      () => '',
      new Set([500, 501])
    )
    expect(promoted.app.map((entry) => entry.pid)).toEqual([500])
    expect(promoted.embedded.map((entry) => entry.pid)).toEqual([501])
    expect(promoted.headless.map((entry) => entry.pid)).toEqual([502])
  })

  it('parses the window-owner query and treats an unreadable window server as unknown', () => {
    expect(parseWindowOwnerPids('windows=43 70675 70675 96018\n')).toEqual(new Set([70675, 96018]))
    expect(parseWindowOwnerPids('windows=12')).toEqual(new Set())
    expect(parseWindowOwnerPids('windows=0')).toBeNull()
    expect(parseWindowOwnerPids('')).toBeNull()
    expect(parseWindowOwnerPids(undefined)).toBeNull()
    expect(parseWindowOwnerPids('execution error: -1743')).toBeNull()
  })

  it.skipIf(process.platform !== 'darwin')(
    'reads window owners from the real window server',
    () => {
      const result = spawnSync('osascript', windowOwnersOsascriptArgs(), { encoding: 'utf8' })
      // A CI Mac without a GUI session may refuse; then the parse must say unknown, never "no windows".
      const owners = result.status === 0 ? parseWindowOwnerPids(result.stdout) : null
      if (owners) {
        expect([...owners].every((pid) => Number.isInteger(pid) && pid > 0)).toBe(true)
      } else {
        expect(owners).toBeNull()
      }
    }
  )
})

describe('install-mac-local running code versus the plist on disk', () => {
  const executable = '/Applications/OmniConsole.app/Contents/MacOS/OmniConsole'
  const profile = '/Users/x/Library/Application Support/omniconsole-ide'
  const holder = `${executable} --user-data-dir ${profile} --serve --serve-port 6768 --outcome-continuation`

  it('counts the app and its own-profile holder as app code, never CLI runs or other profiles', () => {
    const pids = appCodePids(
      classifyBundleProcesses(
        [
          `500 ${executable}`,
          `501 ${executable} /out/cli/index.js claude-teams`,
          `502 ${executable} --user-data-dir /tmp/e2e --serve --serve-port 0`,
          `503 ${holder}`
        ].join('\n')
      ),
      profile
    )
    expect([...pids].sort()).toEqual([500, 503])
  })

  it('reads a holder that was running before the swap as old code, not as the new launch', () => {
    // 2026-10-12, Mac Studio: the 1.12.27 holder (70675 here) survived the 1.12.28 swap while the
    // plist said 1.12.28; only the pid tells the two apart.
    const preSwap = new Set([70675])
    expect(splitByPreSwap(new Set([70675]), preSwap)).toEqual({ fresh: [], old: [70675] })
    expect(splitByPreSwap(new Set([70675, 81234]), preSwap)).toEqual({
      fresh: [81234],
      old: [70675]
    })
    expect(splitByPreSwap(new Set([81234]), preSwap)).toEqual({ fresh: [81234], old: [] })
    expect(splitByPreSwap(new Set(), preSwap)).toEqual({ fresh: [], old: [] })
  })
})
