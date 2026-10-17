#!/usr/bin/env node
// Build the macOS app the way the installed ~/Applications/OmniConsole.app was
// built, sign it with ONE documented identity, swap it into ~/Applications
// keeping exactly one backup, relaunch, and verify. `pnpm run install:mac`.
//
//   --dry-run     print every step; perform no build, quit, move, or launch
//   --skip-build  install the bundle already in dist/mac-arm64 (no build phase)
//   --pre-signed  with --skip-build, verify the installed identity instead of signing locally
//   --signed-candidate <manifest> --candidate-sha256 <hash>  pinned ad-hoc → signed upgrade
//   OMNI_MAC_INSTALL_DIR=<dir>  install there instead of the auto-detected Applications dir
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  APP_NAME,
  appCodePids,
  assertPreSignedIdentity,
  assertVersionMatches,
  bootstrapFatalExitsSince,
  buildCommandPlan,
  bundleExecutablePath,
  bundleInfoPlistPath,
  bundleProcessPgrepArgs,
  childProcessPgrepArgs,
  classifyBundleProcesses,
  holdsAppProfile,
  daemonAcceptedHelloSince,
  formatPlanStep,
  formatSummary,
  isDirectory,
  launchEnvironment,
  macCrashReportsSince,
  newCrashReports,
  parseWindowOwnerPids,
  planBackupRotation,
  promoteWindowedHeadlessRuns,
  readCrashReportKeys,
  readPlistVersion,
  relaunchSettled,
  resolveApplicationsDir,
  resolveSigningIdentity,
  signatureMatchesIdentity,
  splitByPreSwap,
  stagedBundlePath,
  swapInStagedBundle,
  windowOwnersOsascriptArgs
} from './install-mac-local-lib.mjs'

const APPLICATIONS_DIR = resolveApplicationsDir()
const INSTALLED_APP = join(APPLICATIONS_DIR, `${APP_NAME}.app`)
const APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'omniconsole-ide')
const CRASH_REPORTS = join(APP_SUPPORT, 'crash-reports.json')
const DAEMON_LOG = join(APP_SUPPORT, 'logs', 'daemon.log')
const BOOTSTRAP_LOG = join(APP_SUPPORT, 'bootstrap-fatal.log')
const DIAGNOSTIC_REPORTS = join(homedir(), 'Library', 'Logs', 'DiagnosticReports')
const BUILT_APP = resolve('dist', 'mac-arm64', `${APP_NAME}.app`)
const QUIT_TIMEOUT_MS = 60_000
const CRASH_SETTLE_MS = 20_000
/**
 * How long a launch may take before the install is reported as failed.
 *
 * Why a deadline and not a fixed sleep: the old check slept 20s once and then read the state.
 * A slower cold start — a bigger rebuild, a busy machine — made a perfectly good install report
 * "main process not running" and "no daemon hello" moments before both became true. A deploy that
 * worked must never read as a deploy that failed; that is how a real failure stops being believed.
 */
const LAUNCH_TIMEOUT_MS = 90_000

export function parseArgs(argv) {
  const flags = new Set()
  const values = {}
  const unknown = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (['--signed-candidate', '--candidate-sha256'].includes(arg)) {
      if (values[arg] || !argv[index + 1] || argv[index + 1].startsWith('--')) {
        throw new Error(`${arg} requires one value`)
      }
      values[arg] = argv[++index]
    } else if (['--dry-run', '--skip-build', '--pre-signed'].includes(arg)) {
      flags.add(arg)
    } else {
      unknown.push(arg)
    }
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(' ')}`)
  }
  if (flags.has('--pre-signed') && !flags.has('--skip-build')) {
    throw new Error('--pre-signed requires --skip-build')
  }
  if (values['--signed-candidate'] || values['--candidate-sha256']) {
    if (
      !flags.has('--pre-signed') ||
      !values['--signed-candidate'] ||
      !/^[a-f0-9]{64}$/.test(values['--candidate-sha256'] ?? '')
    ) {
      throw new Error(
        'Signed candidate requires --skip-build --pre-signed, a manifest and its SHA256 pin'
      )
    }
  }
  return {
    dryRun: flags.has('--dry-run'),
    skipBuild: flags.has('--skip-build'),
    preSigned: flags.has('--pre-signed'),
    ...(values['--signed-candidate']
      ? {
          candidateManifest: values['--signed-candidate'],
          candidateSha256: values['--candidate-sha256']
        }
      : {})
  }
}

function log(message) {
  console.log(`[install:mac] ${message}`)
}

function run(step, { dryRun }) {
  log(`${dryRun ? 'would run' : 'run'}: ${formatPlanStep(step)}`)
  if (dryRun) {
    return
  }
  execFileSync(step.command, step.args, {
    env: step.replaceEnv ? step.env : { ...process.env, ...step.env },
    stdio: 'inherit'
  })
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

/** Direct children of a process, for `promoteWindowedHeadlessRuns` to read for renderer helpers. */
function childProcessesOutput(pid) {
  const result = spawnSync('pgrep', childProcessPgrepArgs(pid), { encoding: 'utf8' })
  return result.status === 0 ? result.stdout : ''
}

/** Pids owning an on-screen window, or null when the window server cannot be read. */
function windowOwnerPids() {
  const result = spawnSync('osascript', windowOwnersOsascriptArgs(), { encoding: 'utf8' })
  return result.status === 0 ? parseWindowOwnerPids(result.stdout) : null
}

/**
 * The app's own processes and the CLI/daemon runs that share its executable. A headless-looking
 * entry that has actually been promoted to the desktop app (see promoteWindowedHeadlessRuns) is
 * reported as the app, not as a headless run to leave alone or stop.
 */
function bundleProcesses(executablePath) {
  const result = spawnSync('pgrep', bundleProcessPgrepArgs(executablePath), {
    encoding: 'utf8'
  })
  const classified = classifyBundleProcesses(result.status === 0 ? result.stdout : '')
  if (classified.headless.length === 0) {
    return classified
  }
  return promoteWindowedHeadlessRuns(classified, childProcessesOutput, windowOwnerPids())
}

function isAppRunning(executablePath) {
  return bundleProcesses(executablePath).app.length > 0
}

async function quitInstalledApp({ dryRun }) {
  const executable = bundleExecutablePath(INSTALLED_APP)
  // Why AppleScript quit and never SIGTERM/pkill: a normal quit lets the main
  // process detach from the terminal daemon, so every PTY session survives the
  // swap. A signal kills the daemon's owner mid-handshake and drops sessions.
  const step = {
    command: 'osascript',
    args: ['-e', `tell application "${APP_NAME}" to quit`],
    env: {}
  }
  if (dryRun) {
    log(`would run: ${formatPlanStep(step)}`)
    log(`would wait up to ${QUIT_TIMEOUT_MS / 1000}s for ${executable} to exit`)
    log('would wait for its continuation relaunch to get past startup before the swap')
    return
  }
  const { app, embedded, headless } = bundleProcesses(executable)
  // Named, not killed, and never waited on: these are someone's live terminal
  // sessions. The swap renames the bundle, so their files move with them.
  if (embedded.length > 0) {
    log(
      `${embedded.length} CLI session(s) keep running from this bundle and are left alone: ${embedded
        .map((entry) => entry.pid)
        .join(', ')}`
    )
  }
  // A serve host or continuation relauncher never receives the AppleScript quit, so
  // waiting on one spends the whole timeout and aborts an install that was ready. One that
  // holds the app's own profile is stopped after the swap (stopProfileHolders); others stay.
  const others = headless.filter((entry) => !holdsAppProfile(entry.command, APP_SUPPORT))
  if (others.length > 0) {
    log(
      `${others.length} headless run(s) of this bundle are left alone: ${others
        .map((entry) => entry.pid)
        .join(', ')}`
    )
  }
  if (app.length === 0) {
    // Do not send the quit: AppleScript would LAUNCH the app to deliver it.
    log('app is not running; nothing to quit')
    return
  }
  run(step, { dryRun })
  const deadline = Date.now() + QUIT_TIMEOUT_MS
  while (isAppRunning(executable)) {
    if (Date.now() > deadline) {
      throw new Error(`${APP_NAME} did not exit within ${QUIT_TIMEOUT_MS / 1000}s after quit`)
    }
    await sleep(500)
  }
  log('app exited')
  await waitForContinuationRelaunch(executable)
}

/** Hold the swap until the quit's continuation relaunch has appeared and got past bootstrap. */
async function waitForContinuationRelaunch(executable) {
  const exitedAtMs = Date.now()
  const holderFirstSeenMs = new Map()
  const deadline = exitedAtMs + QUIT_TIMEOUT_MS
  for (;;) {
    const nowMs = Date.now()
    const holders = profileHolders(executable)
    const live = new Set(holders.map((entry) => entry.pid))
    for (const pid of holderFirstSeenMs.keys()) {
      if (!live.has(pid)) {
        holderFirstSeenMs.delete(pid)
      }
    }
    for (const pid of live) {
      if (!holderFirstSeenMs.has(pid)) {
        holderFirstSeenMs.set(pid, nowMs)
      }
    }
    if (relaunchSettled({ exitedAtMs, nowMs, holderFirstSeenMs })) {
      if (holderFirstSeenMs.size > 0) {
        log(`continuation relaunch up: ${[...holderFirstSeenMs.keys()].join(', ')}`)
      }
      return
    }
    if (nowMs > deadline) {
      throw new Error(`continuation relaunch did not settle within ${QUIT_TIMEOUT_MS / 1000}s`)
    }
    await sleep(250)
  }
}

/** The headless runs holding the app's own profile right now. */
function profileHolders(executable) {
  return bundleProcesses(executable).headless.filter((entry) =>
    holdsAppProfile(entry.command, APP_SUPPORT)
  )
}

/**
 * Stop the headless run that holds the app's profile, AFTER the new bundle is in place.
 *
 * Why after the swap: stopping it makes it relaunch an outcome continuation from the bundle
 * path, and that must be the new bundle, not the old one. Why SIGTERM here when the quit above
 * uses AppleScript: a headless run has no Apple-event route, and it exits cleanly on SIGTERM —
 * the terminal sessions live in the daemon and reattach (measured three times, 2026-09-22/23).
 * Returns the stopped pids, so the launch check does not count them as the new app.
 */
async function stopProfileHolders({ dryRun }) {
  const executable = bundleExecutablePath(INSTALLED_APP)
  if (dryRun) {
    log(`would stop any headless run holding ${APP_SUPPORT} (SIGTERM) and wait for it to exit`)
    return new Set()
  }
  const holders = profileHolders(executable)
  if (holders.length === 0) {
    return new Set()
  }
  const stale = new Set(holders.map((entry) => entry.pid))
  log(
    `stopping ${holders.length} headless run(s) holding the app profile (old bundle): ${[...stale].join(', ')}`
  )
  for (const pid of stale) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const deadline = Date.now() + QUIT_TIMEOUT_MS
  while ([...stale].some(alive)) {
    if (Date.now() > deadline) {
      throw new Error(
        `headless run(s) ${[...stale].filter(alive).join(', ')} holding the app profile did not exit within ${QUIT_TIMEOUT_MS / 1000}s`
      )
    }
    await sleep(500)
  }
  log('headless profile holder(s) exited')
  return stale
}

/** The app-code pids running now, split into new launches and survivors from before the swap. */
function appCodeSincePreSwap(executable, stale) {
  return splitByPreSwap(appCodePids(bundleProcesses(executable), APP_SUPPORT), stale)
}

/**
 * A process that came up after the swap: the app itself, or — when the continuation host carries
 * the window — a headless run on the app's profile. One already running before the swap is the
 * old code, so it never counts, whatever it looks like.
 */
function newAppRunning(executable, stale) {
  return appCodeSincePreSwap(executable, stale).fresh.length > 0
}

async function launchApp({ dryRun, stale }) {
  const open = {
    command: 'open',
    args: [INSTALLED_APP],
    env: launchEnvironment(),
    replaceEnv: true
  }
  if (dryRun) {
    log(
      `would run: ${formatPlanStep(open)} (and once more after it is up, to bring its window forward)`
    )
    return 0
  }
  const launchedAtMs = Date.now()
  await openWithRetry(open)
  // Why a second open: when the continuation host carries the app, the first activation can
  // land before it is ready and leave no window; a second activation is harmless otherwise.
  const executable = bundleExecutablePath(INSTALLED_APP)
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  while (!newAppRunning(executable, stale) && Date.now() < deadline) {
    await sleep(1_000)
  }
  await sleep(5_000)
  await openWithRetry(open)
  return launchedAtMs
}

/**
 * `open` the app, retrying briefly. Why: right after the profile holder is stopped it relaunches
 * a continuation host from the new bundle, and an `open` that lands mid-relaunch fails with
 * LaunchServices error -600 (measured 2026-09-23) although the app comes up a moment later.
 */
async function openWithRetry(open) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      run(open, { dryRun: false })
      return
    } catch (error) {
      if (attempt >= 5) {
        throw error
      }
      log(`open did not take (attempt ${attempt}); retrying in 2s`)
      await sleep(2_000)
    }
  }
}

/** Copy the new bundle beside the app before the quit, so the swap itself is two renames. */
function stageBundle({ dryRun }) {
  const staged = stagedBundlePath(APPLICATIONS_DIR)
  const ditto = { command: 'ditto', args: [BUILT_APP, staged], env: {} }
  if (dryRun) {
    log(`would delete ${staged} if present`)
    run(ditto, { dryRun })
    return
  }
  rmSync(staged, { recursive: true, force: true })
  run(ditto, { dryRun })
}

function installBundle({ dryRun }) {
  const rotation = planBackupRotation(APPLICATIONS_DIR)
  for (const path of rotation.deletePaths) {
    log(`${dryRun ? 'would delete' : 'delete'} stale backup ${path}`)
  }
  const staged = stagedBundlePath(APPLICATIONS_DIR)
  if (rotation.moveFrom) {
    log(`${dryRun ? 'would move' : 'move'} ${rotation.moveFrom} -> ${rotation.moveTo}`)
  }
  log(`${dryRun ? 'would move' : 'move'} ${staged} -> ${INSTALLED_APP}`)
  if (dryRun) {
    return { backupPath: rotation.moveFrom ? rotation.moveTo : '(none)' }
  }
  swapInStagedBundle(rotation, staged, INSTALLED_APP)
  return { backupPath: rotation.moveFrom ? rotation.moveTo : '(none)' }
}

async function verifyInstall({
  dryRun,
  expectedVersion,
  crashReportsBefore,
  installStartedAtMs,
  launchedAtMs,
  stale
}) {
  if (dryRun) {
    log(
      `would verify: a main process started after the swap, no pre-install process still running, and daemon client-hello-accepted within ${LAUNCH_TIMEOUT_MS / 1000}s, version == ${expectedVersion}, no new crash report, bootstrap fatal exit or macOS .ips after ${CRASH_SETTLE_MS / 1000}s`
    )
    return {
      running: 'skipped',
      oldCode: 'skipped',
      version: 'skipped',
      crashes: 'skipped',
      daemon: 'skipped'
    }
  }
  await sleep(CRASH_SETTLE_MS)
  // Must be the app, not any process sharing its executable: a CLI session left
  // this reading "ok" whether or not the app had actually launched. Both readings are
  // polled to a deadline rather than sampled once, so a slow cold start is reported as
  // slow rather than as a failed install.
  const executable = bundleExecutablePath(INSTALLED_APP)
  const readHello = () =>
    daemonAcceptedHelloSince(
      existsSync(DAEMON_LOG) ? readFileSync(DAEMON_LOG, 'utf8') : '',
      launchedAtMs
    )
  let running = newAppRunning(executable, stale)
  let hello = readHello()
  let { old } = appCodeSincePreSwap(executable, stale)
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  while ((!running || !hello || old.length > 0) && Date.now() < deadline) {
    await sleep(1_000)
    running = running || newAppRunning(executable, stale)
    hello = hello || readHello()
    old = appCodeSincePreSwap(executable, stale).old
  }
  const installedVersion = readPlistVersion(
    readFileSync(bundleInfoPlistPath(INSTALLED_APP), 'utf8')
  )
  // Why three sources: a process that dies during startup never reaches crash-reports.json; it
  // leaves a bootstrap-fatal line or a macOS .ips. Counting only the app's own reports printed
  // "Crash reports ok" over two startup crashes on 2026-09-26.
  const added =
    newCrashReports(crashReportsBefore, readCrashReportKeys(CRASH_REPORTS)) +
    bootstrapFatalExitsSince(
      existsSync(BOOTSTRAP_LOG) ? readFileSync(BOOTSTRAP_LOG, 'utf8') : '',
      installStartedAtMs
    ) +
    macCrashReportsSince(DIAGNOSTIC_REPORTS, installStartedAtMs)
  return {
    running: running ? 'ok' : 'FAIL (main process not running)',
    // Why: the version check reads the plist on disk, which is new the moment the swap lands.
    oldCode:
      old.length === 0 ? 'ok' : `FAIL (pre-install process(es) still running: ${old.join(', ')})`,
    version: installedVersion === expectedVersion ? 'ok' : `FAIL (${installedVersion})`,
    crashes: added === 0 ? 'ok' : `FAIL (${added} new crash report(s))`,
    daemon: hello ? 'ok' : 'FAIL (no client-hello-accepted after launch)'
  }
}

async function loadCandidateContracts() {
  const [{ candidateSigningIdentity }, install] = await Promise.all([
    import('./candidate-assembly-contract.mjs'),
    import('./candidate-install-contract.mjs')
  ])
  return { candidateSigningIdentity, ...install }
}

export async function main(argv = process.argv.slice(2), { beforeRelaunch } = {}) {
  const { dryRun, skipBuild, preSigned, candidateManifest, candidateSha256 } = parseArgs(argv)
  const packageVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  const identity = resolveSigningIdentity()
  let candidateOptions
  // Why lazy: the signed-candidate route is private release tooling the public export omits.
  const candidate = candidateManifest ? await loadCandidateContracts() : null
  if (preSigned) {
    const installedSignature = spawnSync('codesign', ['-dvv', INSTALLED_APP], { encoding: 'utf8' })
    if (candidate) {
      if (
        identity !== candidate.candidateSigningIdentity ||
        process.env.OMNI_MAC_SIGN_IDENTITY?.trim() !== candidate.candidateSigningIdentity ||
        installedSignature.status !== 0
      ) {
        throw new Error(
          'Candidate transition requires the explicit pinned Developer ID identity and an installed app'
        )
      }
      candidateOptions = {
        manifest: candidate.readPinnedCandidateManifest(candidateManifest, candidateSha256),
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        architecture: process.arch,
        installedVersion: readPlistVersion(
          readFileSync(bundleInfoPlistPath(INSTALLED_APP), 'utf8')
        ),
        installedSignature: `${installedSignature.stdout}\n${installedSignature.stderr}`
      }
    } else {
      assertPreSignedIdentity(
        identity,
        process.env.OMNI_MAC_SIGN_IDENTITY,
        `${installedSignature.stdout}\n${installedSignature.stderr}`
      )
    }
  }
  log(
    `${dryRun ? 'DRY RUN — ' : ''}commit ${commit}, package version ${packageVersion}, sign identity ${identity}`
  )

  const plan = buildCommandPlan({ commit, identity, builtAppPath: BUILT_APP })
  const steps = preSigned ? [] : skipBuild ? plan.slice(-1) : plan
  for (const step of steps) {
    run(step, { dryRun })
  }

  let builtVersion = packageVersion
  if (candidateOptions) {
    candidateOptions.builtVersion = readPlistVersion(
      readFileSync(bundleInfoPlistPath(BUILT_APP), 'utf8')
    )
    builtVersion = candidate.verifyCandidateInstallBundle(BUILT_APP, candidateOptions)
    log(`verified pinned signed candidate ${builtVersion} from ${candidateOptions.sourceCommit}`)
  } else if (!dryRun) {
    if (!isDirectory(BUILT_APP)) {
      throw new Error(`Built app not found at ${BUILT_APP}`)
    }
    builtVersion = assertVersionMatches(
      readPlistVersion(readFileSync(bundleInfoPlistPath(BUILT_APP), 'utf8')),
      packageVersion
    )
    const signature = spawnSync('codesign', ['-dvv', BUILT_APP], { encoding: 'utf8' })
    const signatureText = `${signature.stdout}\n${signature.stderr}`
    if (!signatureMatchesIdentity(signatureText, identity)) {
      throw new Error(`Built app is not signed with ${identity}:\n${signatureText}`)
    }
    execFileSync('codesign', ['--verify', '--deep', '--strict', BUILT_APP], { stdio: 'inherit' })
  } else {
    log(
      `would verify ${bundleInfoPlistPath(BUILT_APP)} version == ${packageVersion} and codesign identity == ${identity}`
    )
  }

  const crashReportsBefore = readCrashReportKeys(CRASH_REPORTS)
  stageBundle({ dryRun })
  if (candidateOptions && !dryRun) {
    // Recheck the staged copy before quitting any process. No source/copy race
    // may turn the narrowly authorized identity transition into another bundle.
    const staged = stagedBundlePath(APPLICATIONS_DIR)
    candidate.verifyCandidateInstallBundle(staged, {
      ...candidateOptions,
      builtVersion: readPlistVersion(readFileSync(bundleInfoPlistPath(staged), 'utf8'))
    })
  }
  const installStartedAtMs = Date.now()
  await quitInstalledApp({ dryRun })
  // Every app-code pid alive now runs the old bundle: none of them may count as the new launch,
  // and none may still be running once it is up.
  const preSwap = dryRun
    ? new Set()
    : appCodePids(bundleProcesses(bundleExecutablePath(INSTALLED_APP)), APP_SUPPORT)
  const { backupPath } = installBundle({ dryRun })
  const stale = new Set([...preSwap, ...(await stopProfileHolders({ dryRun }))])
  if (!dryRun) {
    await beforeRelaunch?.()
  }
  const launchedAtMs = await launchApp({ dryRun, stale })
  const checks = await verifyInstall({
    dryRun,
    expectedVersion: builtVersion,
    crashReportsBefore,
    installStartedAtMs,
    launchedAtMs,
    stale
  })

  console.log('')
  console.log(
    formatSummary([
      [
        'Mode',
        dryRun
          ? 'dry run (no side effects)'
          : skipBuild
            ? 'install existing build'
            : 'build + install'
      ],
      ['Commit', commit],
      ['Version', builtVersion],
      ['Sign identity', identity === '-' ? 'ad-hoc (-)' : identity],
      ['Installed to', INSTALLED_APP],
      ['Backup', backupPath],
      ['Main process', checks.running],
      ['Old code gone', checks.oldCode],
      ['Version check', checks.version],
      ['Crash reports', checks.crashes],
      ['Daemon hello', checks.daemon]
    ])
  )
  const failed = Object.values(checks).some((value) => value.startsWith('FAIL'))
  return failed ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[install:mac] ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  )
}
