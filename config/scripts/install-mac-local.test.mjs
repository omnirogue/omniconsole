import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyBackupRotation,
  assertPreSignedIdentity,
  bootstrapFatalExitsSince,
  HOLDER_STARTUP_MS,
  bundleProcessPgrepArgs,
  assertVersionMatches,
  buildCommandPlan,
  childProcessPgrepArgs,
  classifyBundleProcesses,
  daemonAcceptedHelloSince,
  formatPlanStep,
  hasWindowedChildren,
  holdsAppProfile,
  isEmbeddedRun,
  isHeadlessRun,
  launchEnvironment,
  macCrashReportsSince,
  newCrashReports,
  parseCodesigningIdentities,
  pickStableSigningIdentity,
  planBackupRotation,
  promoteWindowedHeadlessRuns,
  readCrashReportKeys,
  readPlistVersion,
  RELAUNCH_APPEAR_MS,
  relaunchSettled,
  resolveApplicationsDir,
  resolveSigningIdentity,
  runningExecutablePattern,
  signatureMatchesIdentity,
  stagedBundlePath,
  swapInStagedBundle
} from './install-mac-local-lib.mjs'
import { parseArgs } from './install-mac-local.mjs'

const tempDirs = []
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'install-mac-local-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('launchEnvironment', () => {
  it('starts the app with the login session only, never the caller’s own variables', () => {
    const agentTerminal = {
      HOME: '/Users/maintainer',
      USER: 'sal',
      SHELL: '/bin/zsh',
      TMPDIR: '/var/folders/x/T/',
      SSH_AUTH_SOCK: '/private/tmp/launchd/Listeners',
      PATH: '/Users/maintainer/.local/bin:/usr/bin:/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'a4724e62',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude.sock',
      NODE_OPTIONS: '--max-old-space-size=8192'
    }
    expect(launchEnvironment(agentTerminal)).toEqual({
      HOME: '/Users/maintainer',
      USER: 'sal',
      SHELL: '/bin/zsh',
      TMPDIR: '/var/folders/x/T/',
      SSH_AUTH_SOCK: '/private/tmp/launchd/Listeners',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
    })
    expect(
      formatPlanStep({
        command: 'open',
        args: ['/Applications/OmniConsole.app'],
        env: {},
        replaceEnv: true
      })
    ).toBe('env -i <login session> open /Applications/OmniConsole.app')
  })
})

describe('install-mac-local plan', () => {
  it('refuses pre-signed installation without the exact installed certificate identity', () => {
    const identity = 'Developer ID Application: Example (TEAM123456)'
    expect(() => assertPreSignedIdentity(identity, identity, `Authority=${identity}`)).not.toThrow()
    expect(() => assertPreSignedIdentity(identity, undefined, `Authority=${identity}`)).toThrow(
      'explicit certificate'
    )
    expect(() => assertPreSignedIdentity('-', '-', 'Signature=adhoc')).toThrow(
      'explicit certificate'
    )
    expect(() =>
      assertPreSignedIdentity(
        identity,
        identity,
        'Authority=Developer ID Application: Other (OTHER12345)'
      )
    ).toThrow('refusing pre-signed replacement')
  })
  it('runs every build script, then electron-builder with the pinned commit and no cert discovery, then ad-hoc codesign', () => {
    const plan = buildCommandPlan({
      commit: 'abcdef123456',
      identity: '-',
      builtAppPath: '/repo/dist/mac-arm64/OmniConsole.app'
    })
    expect(plan.map(formatPlanStep)).toEqual([
      'pnpm run build:desktop',
      'pnpm run build:computer-macos',
      'pnpm run build:keyboard-layout-macos',
      'pnpm run build:notification-status-macos',
      'pnpm run build:pty-process-observer-macos',
      'pnpm run ensure:electron-runtime',
      'ORCA_BUILD_COMMIT=abcdef123456 CSC_IDENTITY_AUTO_DISCOVERY=false ORCA_COMPUTER_MACOS_SIGN_IDENTITY=- pnpm exec electron-builder --config config/electron-builder.config.cjs --mac --arm64 --dir',
      'codesign --force --deep -s - /repo/dist/mac-arm64/OmniConsole.app'
    ])
  })

  it('prefers a stable certificate identity from the keychain over ad-hoc', () => {
    const listing = [
      '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Someone (TEAM123456)"',
      '  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Developer ID Application: Someone (TEAM123456)"',
      '     2 valid identities found'
    ].join('\n')
    expect(parseCodesigningIdentities(listing)).toEqual([
      'Apple Development: Someone (TEAM123456)',
      'Developer ID Application: Someone (TEAM123456)'
    ])
    expect(parseCodesigningIdentities('     0 valid identities found')).toEqual([])
    expect(
      pickStableSigningIdentity([
        'Apple Development: Someone (TEAM123456)',
        'Developer ID Application: Someone (TEAM123456)'
      ])
    ).toBe('Developer ID Application: Someone (TEAM123456)')
    expect(pickStableSigningIdentity(['Apple Development: Someone (TEAM123456)'])).toBe(
      'Apple Development: Someone (TEAM123456)'
    )
    expect(pickStableSigningIdentity(['Mac Developer: Old (TEAM123456)'])).toBeNull()
    expect(resolveSigningIdentity({}, () => ['Apple Development: Someone (TEAM123456)'])).toBe(
      'Apple Development: Someone (TEAM123456)'
    )
    expect(resolveSigningIdentity({}, () => [])).toBe('-')
  })

  it('signs with the single identity switch when one is set', () => {
    expect(resolveSigningIdentity({}, () => [])).toBe('-')
    expect(resolveSigningIdentity({ OMNI_MAC_SIGN_IDENTITY: '  ' }, () => [])).toBe('-')
    expect(
      resolveSigningIdentity({ OMNI_MAC_SIGN_IDENTITY: '-' }, () => ['Apple Development: Someone'])
    ).toBe('-')
    expect(
      resolveSigningIdentity({ OMNI_MAC_SIGN_IDENTITY: 'Developer ID Application: X' }, () => [
        'Apple Development: Someone'
      ])
    ).toBe('Developer ID Application: X')
    const plan = buildCommandPlan({
      commit: 'abcdef123456',
      identity: 'Developer ID Application: X',
      builtAppPath: '/a.app'
    })
    expect(plan.at(-1).args).toEqual([
      '--force',
      '--deep',
      '-s',
      'Developer ID Application: X',
      '/a.app'
    ])
  })

  it('requires an explicit dry-run flag and rejects unknown arguments', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true, skipBuild: false, preSigned: false })
    expect(parseArgs(['--skip-build'])).toEqual({
      dryRun: false,
      skipBuild: true,
      preSigned: false
    })
    expect(parseArgs(['--skip-build', '--pre-signed'])).toEqual({
      dryRun: false,
      skipBuild: true,
      preSigned: true
    })
    expect(() => parseArgs(['--pre-signed'])).toThrow('--pre-signed requires --skip-build')
    expect(() => parseArgs(['--dryrun'])).toThrow(/Unknown argument/)
  })
})

describe('install-mac-local version check', () => {
  const plist =
    '<plist><dict><key>CFBundleShortVersionString</key>\n<string>1.9.6</string><key>CFBundleVersion</key><string>1.9.6</string></dict></plist>'

  it('reads the marketing version from Info.plist', () => {
    expect(readPlistVersion(plist)).toBe('1.9.6')
    expect(readPlistVersion('<plist/>')).toBeNull()
  })

  it('fails when the built version does not equal package.json', () => {
    expect(assertVersionMatches('1.9.6', '1.9.6')).toBe('1.9.6')
    expect(() => assertVersionMatches('1.9.4', '1.9.6')).toThrow(
      'Built app version 1.9.4 does not match package.json version 1.9.6'
    )
    expect(() => assertVersionMatches(null, '1.9.6')).toThrow(/no CFBundleShortVersionString/)
  })

  it('accepts only the chosen signature identity', () => {
    const adhoc = 'Identifier=com.omniconsole.ide\nSignature=adhoc\nTeamIdentifier=not set'
    const dev =
      'Identifier=com.omniconsole.ide\nAuthority=Apple Development: someone\nAuthority=Apple Root CA'
    expect(signatureMatchesIdentity(adhoc, '-')).toBe(true)
    expect(signatureMatchesIdentity(dev, '-')).toBe(false)
    expect(signatureMatchesIdentity(dev, 'Apple Development: someone')).toBe(true)
    expect(signatureMatchesIdentity(adhoc, 'Developer ID Application: X')).toBe(false)
  })
})

describe('install-mac-local backup rotation', () => {
  it('keeps exactly one .previous and deletes older .previous/.bak bundles', () => {
    const apps = makeTempDir()
    for (const name of [
      'OmniConsole.app',
      'OmniConsole.app.previous',
      'OmniConsole.app.previous.2',
      'OmniConsole.app.bak',
      'OmniConsole-1.9.3.bak.app',
      'Other.app.previous'
    ]) {
      mkdirSync(join(apps, name, 'Contents'), { recursive: true })
      writeFileSync(join(apps, name, 'Contents', 'Info.plist'), name)
    }

    const plan = planBackupRotation(apps)
    expect(plan.deletePaths.map((path) => path.slice(apps.length + 1)).sort()).toEqual([
      'OmniConsole-1.9.3.bak.app',
      'OmniConsole.app.bak',
      'OmniConsole.app.previous',
      'OmniConsole.app.previous.2'
    ])
    expect(plan.moveFrom).toBe(join(apps, 'OmniConsole.app'))
    expect(plan.moveTo).toBe(join(apps, 'OmniConsole.app.previous'))

    applyBackupRotation(plan)
    expect(readdirSync(apps).sort()).toEqual(['OmniConsole.app.previous', 'Other.app.previous'])
    expect(existsSync(join(apps, 'OmniConsole.app.previous', 'Contents', 'Info.plist'))).toBe(true)
  })

  it('plans no move on a fresh machine without an installed app', () => {
    const apps = makeTempDir()
    const plan = planBackupRotation(apps)
    expect(plan).toEqual({
      deletePaths: [],
      moveFrom: null,
      moveTo: join(apps, 'OmniConsole.app.previous')
    })
    applyBackupRotation(plan)
    expect(readdirSync(apps)).toEqual([])
  })
})

describe('install-mac-local staged swap', () => {
  const bundle = (apps, name, marker) => {
    mkdirSync(join(apps, name, 'Contents'), { recursive: true })
    writeFileSync(join(apps, name, 'Contents', 'Info.plist'), marker)
  }
  const marker = (apps, name) => readFileSync(join(apps, name, 'Contents', 'Info.plist'), 'utf8')

  it('stages beside the app, where the rotation never counts it as a backup', () => {
    const apps = makeTempDir()
    const staged = stagedBundlePath(apps)
    expect(staged).toBe(join(apps, '.OmniConsole.app.installing'))
    bundle(apps, 'OmniConsole.app', 'old')
    bundle(apps, '.OmniConsole.app.installing', 'new')
    expect(planBackupRotation(apps).deletePaths).toEqual([])
  })

  it('puts the whole staged bundle at the app path and the old one at .previous', () => {
    const apps = makeTempDir()
    bundle(apps, 'OmniConsole.app', 'old')
    bundle(apps, 'OmniConsole.app.previous', 'older')
    bundle(apps, '.OmniConsole.app.installing', 'new')
    swapInStagedBundle(
      planBackupRotation(apps),
      stagedBundlePath(apps),
      join(apps, 'OmniConsole.app')
    )
    expect(readdirSync(apps).sort()).toEqual(['OmniConsole.app', 'OmniConsole.app.previous'])
    expect(marker(apps, 'OmniConsole.app')).toBe('new')
    expect(marker(apps, 'OmniConsole.app.previous')).toBe('old')
  })

  it('leaves the installed app alone when nothing was staged', () => {
    const apps = makeTempDir()
    bundle(apps, 'OmniConsole.app', 'old')
    expect(() =>
      swapInStagedBundle(
        planBackupRotation(apps),
        stagedBundlePath(apps),
        join(apps, 'OmniConsole.app')
      )
    ).toThrow(/Staged bundle missing/)
    expect(marker(apps, 'OmniConsole.app')).toBe('old')
  })
})

describe('install-mac-local continuation relaunch wait', () => {
  const exitedAtMs = 1_000_000

  it('waits for a relaunch to appear even when none is visible yet', () => {
    const holderFirstSeenMs = new Map()
    expect(relaunchSettled({ exitedAtMs, nowMs: exitedAtMs, holderFirstSeenMs })).toBe(false)
    expect(
      relaunchSettled({ exitedAtMs, nowMs: exitedAtMs + RELAUNCH_APPEAR_MS, holderFirstSeenMs })
    ).toBe(true)
  })

  it('does not swap while a relaunched holder is still booting from the old bundle', () => {
    // The 2026-09-26 10:43 crash: the child appeared as the app exited and died 0.4s later.
    const seenAt = exitedAtMs + 2_500
    const holderFirstSeenMs = new Map([[86193, seenAt]])
    expect(
      relaunchSettled({ exitedAtMs, nowMs: exitedAtMs + RELAUNCH_APPEAR_MS, holderFirstSeenMs })
    ).toBe(false)
    expect(
      relaunchSettled({ exitedAtMs, nowMs: seenAt + HOLDER_STARTUP_MS, holderFirstSeenMs })
    ).toBe(true)
  })
})

describe('install-mac-local startup crash evidence', () => {
  const since = Date.parse('2026-09-26T14:44:00.000Z')

  it('counts bootstrap fatal exits stamped after the install started', () => {
    const log = [
      "2026-09-26T08:17:58.877Z [bootstrap] fatal-exit pid=82706 error=Error: ENOENT: no such file or directory, open '/Applications/OmniConsole.app/Contents/Resources/app.asar.unpacked/out/main/chunks/chunk-Dyl6ISrD.js' |     at Object.readFileSync (node:fs:441:20)",
      "2026-09-26T14:50:15.685Z [bootstrap] fatal-exit pid=15487 error=Error: ENOENT: no such file or directory, open '/Applications/OmniConsole.app/Contents/Resources/app.asar.unpacked/out/main/chunks/chunk-Dyl6ISrD.js' |     at Object.readFileSync (node:fs:441:20)",
      '2026-09-26T14:50:1'
    ].join('\n')
    expect(bootstrapFatalExitsSince(log, since)).toBe(1)
    expect(bootstrapFatalExitsSince('', since)).toBe(0)
  })

  it("counts only this app's macOS crash reports written after the install started", () => {
    const dir = makeTempDir()
    const write = (name, atMs) => {
      writeFileSync(join(dir, name), '{}')
      utimesSync(join(dir, name), atMs / 1000, atMs / 1000)
    }
    write('OmniConsole-2026-09-26-105021.ips', since + 381_000)
    write('OmniConsole-2026-09-25-163802.ips', since - 60_000_000)
    write('Other-2026-09-26-105021.ips', since + 381_000)
    write('OmniConsole-2026-09-26-105021.diag', since + 381_000)
    expect(macCrashReportsSince(dir, since)).toBe(1)
    expect(macCrashReportsSince(join(dir, 'missing'), since)).toBe(0)
  })
})

describe('install-mac-local post-launch checks', () => {
  it('detects a new crash report entry and tolerates a missing or damaged file', () => {
    const dir = makeTempDir()
    const file = join(dir, 'crash-reports.json')
    expect(readCrashReportKeys(file).size).toBe(0)
    writeFileSync(file, JSON.stringify([{ id: 'a', reason: 'react-error-boundary' }]))
    const before = readCrashReportKeys(file)
    writeFileSync(file, JSON.stringify([{ id: 'b', reason: 'crashed' }, { id: 'a' }]))
    expect(newCrashReports(before, readCrashReportKeys(file))).toBe(1)
    expect(newCrashReports(before, before)).toBe(0)
    writeFileSync(file, '{not json')
    expect(readCrashReportKeys(file).size).toBe(0)
  })

  it('sees a new crash even when the capped report list stays the same length', () => {
    const dir = makeTempDir()
    const file = join(dir, 'crash-reports.json')
    const report = (id) => ({ id, createdAt: `2026-09-24T00:0${id}:00.000Z` })
    writeFileSync(file, JSON.stringify(['5', '4', '3', '2', '1'].map(report)))
    const before = readCrashReportKeys(file)
    // The app keeps its newest five: a new report pushes the oldest out.
    writeFileSync(file, JSON.stringify(['6', '5', '4', '3', '2'].map(report)))
    expect(newCrashReports(before, readCrashReportKeys(file))).toBe(1)
    // Entries without an id fall back to their creation time.
    writeFileSync(file, JSON.stringify({ reports: [{ createdAt: 'later' }] }))
    expect(newCrashReports(new Set(['earlier']), readCrashReportKeys(file))).toBe(1)
  })

  it('finds a daemon client-hello-accepted only after the launch timestamp', () => {
    const log = [
      '{"src":"daemon","ts":"2026-09-11T17:53:58.232Z","pid":1,"event":"client-hello-accepted","role":"control"}',
      '{"src":"daemon","ts":"2026-09-11T17:54:58.833Z","pid":1,"event":"ready"}',
      '{"src":"daemon","ts":"2026-09-11T17:5'
    ].join('\n')
    expect(daemonAcceptedHelloSince(log, Date.parse('2026-09-11T17:00:00Z'))).toBe(true)
    expect(daemonAcceptedHelloSince(log, Date.parse('2026-09-11T17:54:00Z'))).toBe(false)
    expect(daemonAcceptedHelloSince('', 0)).toBe(false)
  })
})

describe('install-mac-local install directory', () => {
  it('installs next to the bundle that is actually present, preferring ~/Applications', () => {
    const present = new Set([
      '/home/sal/Applications/OmniConsole.app',
      '/Applications/OmniConsole.app'
    ])
    const exists = (path) => present.has(path)
    expect(resolveApplicationsDir({ env: {}, home: '/home/sal', exists })).toBe(
      '/home/sal/Applications'
    )
    present.delete('/home/sal/Applications/OmniConsole.app')
    expect(resolveApplicationsDir({ env: {}, home: '/home/sal', exists })).toBe('/Applications')
    present.clear()
    expect(resolveApplicationsDir({ env: {}, home: '/home/sal', exists })).toBe(
      '/home/sal/Applications'
    )
  })

  it('honours OMNI_MAC_INSTALL_DIR over detection', () => {
    expect(
      resolveApplicationsDir({
        env: { OMNI_MAC_INSTALL_DIR: '/Volumes/Apps' },
        home: '/home/sal',
        exists: () => true
      })
    ).toBe('/Volumes/Apps')
  })
})

describe('install-mac-local running-app detection', () => {
  const executable = '/Applications/OmniConsole.app/Contents/MacOS/OmniConsole'

  it('matches the executable launched with or without arguments', () => {
    const pattern = new RegExp(runningExecutablePattern(executable))
    expect(pattern.test(executable)).toBe(true)
    expect(pattern.test(`${executable} --remote-debugging-port=9333`)).toBe(true)
  })

  it('never matches another bundle or a backup copy', () => {
    const pattern = new RegExp(runningExecutablePattern(executable))
    expect(pattern.test('/Applications/OmniConsole.app.previous/Contents/MacOS/OmniConsole')).toBe(
      false
    )
    expect(pattern.test(`${executable}Helper`)).toBe(false)
    expect(pattern.test(`/tmp${executable}`)).toBe(false)
  })

  it('asks pgrep for its own ancestors too, so an install from an OmniConsole terminal sees the app', () => {
    const args = bundleProcessPgrepArgs(executable)
    expect(args).toContain('-a')
    expect(args.at(-1)).toBe(runningExecutablePattern(executable))
  })

  it('escapes regex metacharacters in the path', () => {
    const odd = '/Volumes/Apps (1)/OmniConsole.app/Contents/MacOS/OmniConsole'
    expect(new RegExp(runningExecutablePattern(odd)).test(odd)).toBe(true)
    expect(
      new RegExp(runningExecutablePattern(odd)).test(
        '/Volumes/Apps 1/OmniConsole.app/Contents/MacOS/OmniConsole'
      )
    ).toBe(false)
  })
})

describe('install-mac-local app versus CLI runs of the same executable', () => {
  const executable = '/Applications/OmniConsole.app/Contents/MacOS/OmniConsole'
  const cli = `${executable} /Applications/OmniConsole.app/Contents/Resources/app.asar.unpacked/out/cli/index.js claude-teams --dangerously-skip-permissions`

  it('reads a launch with no script as the app, and a script argument as a CLI run', () => {
    expect(isEmbeddedRun(executable)).toBe(false)
    expect(isEmbeddedRun(`${executable} --remote-debugging-port=9333`)).toBe(false)
    expect(isEmbeddedRun(`${executable} -psn_0_524308`)).toBe(false)
    expect(isEmbeddedRun(cli)).toBe(true)
    // The daemon is a Node run too, and a bundle path containing spaces still splits
    // so that the script argument keeps its .js tail.
    expect(
      isEmbeddedRun(`${executable} /Volumes/Apps 1/out/main/daemon-entry.js --socket /x`)
    ).toBe(true)
  })

  it('separates the app from CLI sessions sharing the executable', () => {
    const { app, embedded } = classifyBundleProcesses(
      [`  16224 ${cli}`, `42927 ${executable}`, '', 'not a process line'].join('\n')
    )
    expect(app).toEqual([{ pid: 42927, command: executable }])
    expect(embedded.map((entry) => entry.pid)).toEqual([16224])
  })

  it('reports no app process when only CLI sessions are up', () => {
    // The defect this replaces: five live `claude-teams` sessions made the installer
    // wait 60s for a quit it never needed to send, then abort without installing —
    // and would have passed the post-install "main process running" check on them.
    const { app, embedded } = classifyBundleProcesses(
      [16224, 16528, 18254, 36102, 60457].map((pid) => `${pid} ${cli}`).join('\n')
    )
    expect(app).toEqual([])
    expect(embedded).toHaveLength(5)
  })

  it('reads a serve host and a continuation relauncher as headless, not as the app', () => {
    const serve = `${executable} --user-data-dir /Users/x/Library/Application Support/omniconsole-ide --serve --serve-no-pairing --serve-port 0 --outcome-continuation`
    expect(isHeadlessRun(serve)).toBe(true)
    expect(isHeadlessRun(`${executable} --outcome-continuation`)).toBe(true)
    expect(isHeadlessRun(executable)).toBe(false)
    expect(isHeadlessRun(`${executable} --remote-debugging-port=9333`)).toBe(false)
    // A CLI session stays a CLI session; the two readings never trade places.
    expect(isHeadlessRun(cli)).toBe(false)
    expect(isEmbeddedRun(serve)).toBe(false)
  })

  it('reports no app process when only a headless serve run is up', () => {
    // The defect this replaces: the window had quit, the serve host had not, and the
    // installer waited out its 60s quit timeout and aborted without installing
    // (measured 2026-09-19). After the swap that same process would have satisfied the
    // post-install "main process running" check, because its argv keeps the old path.
    const serve = `${executable} --serve --serve-port 0 --outcome-continuation`
    const { app, embedded, headless } = classifyBundleProcesses(
      [`  38071 ${serve}`, `16224 ${cli}`].join('\n')
    )
    expect(app).toEqual([])
    expect(embedded.map((entry) => entry.pid)).toEqual([16224])
    expect(headless.map((entry) => entry.pid)).toEqual([38071])
  })

  it('picks out the headless run that holds the app profile, and only that one', () => {
    // The install blocker measured three times 2026-09-22/23: this process kept the profile
    // lock with the OLD bundle's code, so the new app handed its launch to it and exited.
    const profile = '/Users/x/Library/Application Support/omniconsole-ide'
    const holder = `${executable} --user-data-dir ${profile} --serve --serve-no-pairing --serve-port 0 --outcome-continuation`
    expect(holdsAppProfile(holder, profile)).toBe(true)
    expect(holdsAppProfile(`${executable} --user-data-dir=${profile} --serve`, profile)).toBe(true)
    // Another profile (an e2e or scratch instance) is somebody else's and stays up.
    expect(holdsAppProfile(`${executable} --user-data-dir ${profile}-e2e --serve`, profile)).toBe(
      false
    )
    expect(holdsAppProfile(`${executable} --user-data-dir /tmp/udd --serve`, profile)).toBe(false)
    // The desktop app itself and CLI sessions are never profile holders to stop.
    expect(holdsAppProfile(`${executable} --user-data-dir ${profile}`, profile)).toBe(false)
    expect(holdsAppProfile(cli, profile)).toBe(false)
    expect(holdsAppProfile(holder, '')).toBe(false)
  })

  it('treats no output as nothing running', () => {
    expect(classifyBundleProcesses('')).toEqual({ app: [], embedded: [], headless: [] })
    expect(classifyBundleProcesses(undefined)).toEqual({ app: [], embedded: [], headless: [] })
  })

  it('requests full child command lines so macOS helper names are not truncated', () => {
    expect(childProcessPgrepArgs(70120)).toEqual(['-P', '70120', '-fl'])
  })

  it.skipIf(process.platform !== 'darwin')(
    'detects a renderer through the actual macOS child query',
    async () => {
      const helper = join(makeTempDir(), 'OmniConsole Helper (Renderer)')
      symlinkSync(process.execPath, helper)
      const child = spawn(
        helper,
        [
          '-e',
          'process.stdout.write("ready"); setInterval(() => {}, 1000)',
          '--',
          '--type=renderer'
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      )
      try {
        await Promise.race([
          once(child.stdout, 'data'),
          once(child, 'error').then(([error]) => {
            throw error
          })
        ])
        const query = (args) =>
          execFileSync('pgrep', args, { encoding: 'utf8' })
            .split('\n')
            .find((line) => line.startsWith(`${child.pid} `))
        expect(hasWindowedChildren(query(['-P', String(process.pid), '-l']))).toBe(false)
        const fullChild = query(childProcessPgrepArgs(process.pid))
        expect(fullChild).toContain('--type=renderer')
        const promoted = promoteWindowedHeadlessRuns(
          classifyBundleProcesses(`70120 ${executable} --serve --outcome-continuation`),
          () => fullChild
        )
        expect(promoted.app.map((entry) => entry.pid)).toEqual([70120])
        expect(promoted.headless).toEqual([])
      } finally {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
    }
  )

  it('reads renderer helper children (never a GPU helper) as the fallback sign of a window', () => {
    expect(hasWindowedChildren('70121 OmniConsole Helper (Renderer)')).toBe(true)
    expect(hasWindowedChildren('70123 OmniConsole Helper (Plugin)')).toBe(true)
    expect(hasWindowedChildren(`${executable} --type=renderer`)).toBe(true)
    // Every Electron main process starts a GPU helper, windowed or not.
    expect(hasWindowedChildren('70122 OmniConsole Helper (GPU)')).toBe(false)
    expect(hasWindowedChildren(`${executable} --type=gpu-process`)).toBe(false)
    expect(hasWindowedChildren('')).toBe(false)
    expect(hasWindowedChildren(undefined)).toBe(false)
    // A CLI/daemon child of the app (e.g. the PTY daemon helper) proves nothing about a window.
    expect(hasWindowedChildren(`${executable} /out/main/daemon-entry.js --socket /x`)).toBe(false)
  })

  it('reclassifies a promoted continuation host (ancestor windowed app) as the app, not headless', () => {
    // The defect measured 2026-09-24: an install run from a terminal INSIDE OmniConsole saw its
    // own ancestor — the real windowed app, with renderer and GPU processes, promoted in place
    // from an earlier outcome-continuation relaunch — still carrying `--outcome-continuation` in
    // argv. It read as "app is not running" and then got SIGTERM'd as a stale headless profile
    // holder (PID 70120), instead of being quit normally via AppleScript.
    const profile = '/Users/x/Library/Application Support/omniconsole-ide'
    const promotedHost = `${executable} --user-data-dir ${profile} --serve --serve-no-pairing --serve-port 0 --outcome-continuation`
    const classified = classifyBundleProcesses(`70120 ${promotedHost}`)
    expect(classified.app).toEqual([])
    expect(classified.headless.map((entry) => entry.pid)).toEqual([70120])

    const childrenByPid = {
      70120: '70121 OmniConsole Helper (Renderer)\n70122 OmniConsole Helper (GPU)'
    }
    const promoted = promoteWindowedHeadlessRuns(classified, (pid) => childrenByPid[pid] ?? '')
    expect(promoted.app.map((entry) => entry.pid)).toEqual([70120])
    expect(promoted.headless).toEqual([])
  })

  it('leaves a genuinely headless run (no window, no renderer/GPU children) as headless', () => {
    const profile = '/Users/x/Library/Application Support/omniconsole-ide'
    const holder = `${executable} --user-data-dir ${profile} --serve --serve-no-pairing --serve-port 0 --outcome-continuation`
    const classified = classifyBundleProcesses(`38071 ${holder}`)
    expect(classified.headless.map((entry) => entry.pid)).toEqual([38071])

    const promoted = promoteWindowedHeadlessRuns(classified, () =>
      [
        `38072 ${executable} /out/main/daemon-entry.js --socket /x`,
        `38073 ${executable} --type=utility --utility-sub-type=network.mojom.NetworkService`,
        '38074 /bin/zsh'
      ].join('\n')
    )
    expect(promoted.app).toEqual([])
    expect(promoted.headless.map((entry) => entry.pid)).toEqual([38071])
  })

  it('leaves the app-not-running case alone: nothing to promote', () => {
    const promoted = promoteWindowedHeadlessRuns(classifyBundleProcesses(''), () => '')
    expect(promoted).toEqual({ app: [], embedded: [], headless: [] })
  })
})
