import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Why a stable identity by default: macOS keys every keychain grant ("omniconsole-ide
// Safe Storage") and every TCC grant (Accessibility, Screen Recording, Automation)
// to the app's code identity. An ad-hoc signature (`-`) is a fresh identity per
// build, so every rebuild re-prompted for the login keychain password and the
// launch sat behind that prompt (measured 2026-09-11, three hung launches in a
// row). A certificate identity has a stable designated requirement, so grants
// survive rebuilds. Preference: Developer ID Application, then Apple Development,
// then ad-hoc when the login keychain holds neither. OMNI_MAC_SIGN_IDENTITY pins
// an identity by common name; set it to `-` to force ad-hoc.
export const DEFAULT_SIGNING_IDENTITY = '-'
const STABLE_IDENTITY_PREFIXES = ['Developer ID Application:', 'Apple Development:']

/** Common names from `security find-identity -v -p codesigning` output. */
export function parseCodesigningIdentities(output) {
  return [...String(output ?? '').matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"([^"]+)"\s*$/gm)].map(
    (match) => match[1]
  )
}

export function listCodesigningIdentities() {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8'
  })
  return result.status === 0 ? parseCodesigningIdentities(result.stdout) : []
}

/** The first identity of the most durable kind present, or null. */
export function pickStableSigningIdentity(identities) {
  for (const prefix of STABLE_IDENTITY_PREFIXES) {
    const match = identities.find((name) => name.startsWith(prefix))
    if (match) {
      return match
    }
  }
  return null
}

export function resolveSigningIdentity(
  env = process.env,
  listIdentities = listCodesigningIdentities
) {
  const identity = env.OMNI_MAC_SIGN_IDENTITY?.trim()
  if (identity) {
    return identity
  }
  return pickStableSigningIdentity(listIdentities()) ?? DEFAULT_SIGNING_IDENTITY
}

export const APP_NAME = 'OmniConsole'
export const BACKUP_SUFFIX = '.previous'

// Why: the IDE has lived in ~/Applications and, since 2026-09-11, in /Applications.
// Installing next to the copy that is actually there keeps one bundle on disk;
// OMNI_MAC_INSTALL_DIR pins the directory explicitly when that guess is wrong.
export function resolveApplicationsDir({
  env = process.env,
  home = homedir(),
  exists = existsSync
} = {}) {
  const override = env.OMNI_MAC_INSTALL_DIR?.trim()
  if (override) {
    return override
  }
  const userDir = join(home, 'Applications')
  const systemDir = '/Applications'
  if (!exists(join(userDir, `${APP_NAME}.app`)) && exists(join(systemDir, `${APP_NAME}.app`))) {
    return systemDir
  }
  return userDir
}

export function buildCommandPlan({ commit, identity, builtAppPath }) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const runScripts = [
    'build:desktop',
    'build:computer-macos',
    'build:keyboard-layout-macos',
    'build:notification-status-macos',
    'build:pty-process-observer-macos',
    'ensure:electron-runtime'
  ]
  return [
    ...runScripts.map((script) => ({ command: pnpm, args: ['run', script], env: {} })),
    {
      command: pnpm,
      args: [
        'exec',
        'electron-builder',
        '--config',
        'config/electron-builder.config.cjs',
        '--mac',
        '--arm64',
        '--dir'
      ],
      env: {
        ORCA_BUILD_COMMIT: commit,
        // Why: no auto-discovery, so electron-builder never picks the keychain's
        // Apple Development cert behind our back; the nested Computer Use helper
        // gets the same identity so its TCC grants survive too.
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        ORCA_COMPUTER_MACOS_SIGN_IDENTITY: identity
      }
    },
    {
      command: 'codesign',
      args: ['--force', '--deep', '-s', identity, builtAppPath],
      env: {}
    }
  ]
}

export function formatPlanStep(step) {
  const env = step.replaceEnv
    ? 'env -i <login session>'
    : Object.entries(step.env)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
  return `${env ? `${env} ` : ''}${step.command} ${step.args.join(' ')}`.trim()
}

/** What a Dock launch hands the app from the login session. */
const LAUNCH_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'SSH_AUTH_SOCK',
  '__CF_USER_TEXT_ENCODING'
]

/**
 * The environment the installed app starts with: the login session's, as from the Dock, and
 * nothing of the caller's. Why: `open` hands its own environment to the app, so an install run
 * from an agent's terminal put that agent's session (CLAUDECODE, its session id and messaging
 * socket, NODE_OPTIONS) into the app and into every terminal the app then opened.
 */
export function launchEnvironment(env = process.env) {
  return {
    ...Object.fromEntries(LAUNCH_ENV_KEYS.filter((key) => env[key]).map((key) => [key, env[key]])),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
  }
}

export function readPlistVersion(infoPlistText) {
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
    infoPlistText
  )
  return match ? match[1].trim() : null
}

export function assertVersionMatches(builtVersion, packageVersion) {
  if (!builtVersion) {
    throw new Error('Built Info.plist has no CFBundleShortVersionString')
  }
  if (builtVersion !== packageVersion) {
    throw new Error(
      `Built app version ${builtVersion} does not match package.json version ${packageVersion}`
    )
  }
  return builtVersion
}

// Why: `codesign -dvv` prints "Signature=adhoc" for `-` and "Authority=<name>"
// lines for a certificate (plain `-dv` omits the Authority chain, measured
// 2026-09-11, so a certificate identity could never verify); either way the
// installed identity must be the one we chose, or the next launch re-prompts
// for every keychain/TCC grant.
export function signatureMatchesIdentity(codesignOutput, identity) {
  if (identity === DEFAULT_SIGNING_IDENTITY) {
    return /^Signature=adhoc$/m.test(codesignOutput)
  }
  return codesignOutput.split('\n').some((line) => line.trim() === `Authority=${identity}`)
}

export function assertPreSignedIdentity(identity, explicitIdentity, installedSignature) {
  if (!explicitIdentity?.trim() || identity === DEFAULT_SIGNING_IDENTITY) {
    throw new Error('--pre-signed requires an explicit certificate OMNI_MAC_SIGN_IDENTITY')
  }
  if (!signatureMatchesIdentity(installedSignature, identity)) {
    throw new Error(`Installed app is not signed with ${identity}; refusing pre-signed replacement`)
  }
}

/** Everything under applicationsDir that is an older backup of the app bundle. */
export function planBackupRotation(applicationsDir, appName = APP_NAME) {
  const current = join(applicationsDir, `${appName}.app`)
  const backup = join(applicationsDir, `${appName}.app${BACKUP_SUFFIX}`)
  const entries = existsSync(applicationsDir) ? readdirSync(applicationsDir) : []
  const stale = entries
    .filter((entry) => entry.startsWith(appName))
    .filter((entry) => entry.includes(BACKUP_SUFFIX) || entry.includes('.bak'))
    .map((entry) => join(applicationsDir, entry))
    .sort()
  return {
    deletePaths: stale,
    moveFrom: existsSync(current) ? current : null,
    moveTo: backup
  }
}

export function applyBackupRotation(plan) {
  for (const path of plan.deletePaths) {
    rmSync(path, { recursive: true, force: true })
  }
  if (plan.moveFrom) {
    renameSync(plan.moveFrom, plan.moveTo)
  }
}

/**
 * Where the new bundle is copied before it takes the app's name. Why a sibling, not a temp dir:
 * the final step is a rename, which is atomic only within one volume. Why the leading dot: the
 * backup rotation never mistakes it for an old bundle, and Finder/LaunchServices do not list it.
 */
export function stagedBundlePath(applicationsDir, appName = APP_NAME) {
  return join(applicationsDir, `.${appName}.app.installing`)
}

/**
 * Rotate the backup and move the fully copied staged bundle into place, back to back.
 *
 * Why: copying straight into the app path left a half-written bundle there for the whole copy,
 * and the quitting app's outcome-continuation relaunch started from it and died on a missing
 * chunk (bootstrap-fatal ENOENT, 2026-09-25/26). A launch now finds the old bundle or the whole
 * new one, never part of one.
 */
export function swapInStagedBundle(plan, stagedPath, installedPath) {
  if (!existsSync(stagedPath)) {
    throw new Error(`Staged bundle missing at ${stagedPath}`)
  }
  applyBackupRotation(plan)
  renameSync(stagedPath, installedPath)
}

/** How long after the app exits its continuation relaunch may still appear. */
export const RELAUNCH_APPEAR_MS = 3_000
/** How long a relaunched profile holder needs to get past bootstrap. */
export const HOLDER_STARTUP_MS = 3_000

/**
 * True once no continuation relaunch can still be starting from the old bundle.
 *
 * Why: on quit the app relaunches itself (`--serve --outcome-continuation`) from its bundle path
 * once its process is gone. Renaming the bundle while that child boots crashed it at startup
 * (EXC_BREAKPOINT, 2026-09-26 10:43). A holder that is past bootstrap is safe to leave to
 * stopProfileHolders, which restarts it from the new bundle.
 */
export function relaunchSettled({ exitedAtMs, nowMs, holderFirstSeenMs }) {
  if (nowMs - exitedAtMs < RELAUNCH_APPEAR_MS) {
    return false
  }
  return [...holderFirstSeenMs.values()].every((seenMs) => nowMs - seenMs >= HOLDER_STARTUP_MS)
}

function crashReportEntries(parsed) {
  if (Array.isArray(parsed)) {
    return parsed
  }
  if (parsed && typeof parsed === 'object') {
    const list = parsed.reports ?? parsed.entries
    return Array.isArray(list) ? list : Object.values(parsed)
  }
  return []
}

/** Each crash report on disk by its id (else its creation time or content); empty when unreadable. */
export function readCrashReportKeys(crashReportsPath) {
  if (!existsSync(crashReportsPath)) {
    return new Set()
  }
  try {
    const entries = crashReportEntries(JSON.parse(readFileSync(crashReportsPath, 'utf8')))
    return new Set(
      entries.map((entry) => String(entry?.id ?? entry?.createdAt ?? JSON.stringify(entry)))
    )
  } catch {
    return new Set()
  }
}

/**
 * Reports present now that were not before. Why not a count: the app keeps only its newest few
 * reports, so a new crash can push an old one out and leave the count unchanged.
 */
export function newCrashReports(before, after) {
  let added = 0
  for (const key of after) {
    if (!before.has(key)) {
      added += 1
    }
  }
  return added
}

/** True when the daemon accepted a client hello at or after `sinceMs`. */
export function daemonAcceptedHelloSince(daemonLogText, sinceMs) {
  for (const line of daemonLogText.split('\n')) {
    if (!line.includes('client-hello-accepted')) {
      continue
    }
    try {
      const entry = JSON.parse(line)
      if (entry.event === 'client-hello-accepted' && Date.parse(entry.ts) >= sinceMs) {
        return true
      }
    } catch {
      // Why: a torn last line while the daemon is writing is not evidence either way.
    }
  }
  return false
}

/**
 * Startup deaths the app's own crash-reports.json never sees: a main process that fails before
 * it can write a report logs `[bootstrap] fatal-exit` instead. Counts lines stamped at or after
 * `sinceMs`.
 */
export function bootstrapFatalExitsSince(bootstrapLogText, sinceMs) {
  let count = 0
  for (const line of bootstrapLogText.split('\n')) {
    const match = /^(\S+) \[bootstrap\] fatal-exit /.exec(line)
    if (match && Date.parse(match[1]) >= sinceMs) {
      count += 1
    }
  }
  return count
}

/** macOS crash reports (`<App>-*.ips`) written at or after `sinceMs`; 0 when the dir is unreadable. */
export function macCrashReportsSince(diagnosticReportsDir, sinceMs, appName = APP_NAME) {
  let entries
  try {
    entries = readdirSync(diagnosticReportsDir)
  } catch {
    return 0
  }
  return entries.filter((entry) => {
    if (!entry.startsWith(`${appName}-`) || !entry.endsWith('.ips')) {
      return false
    }
    try {
      return statSync(join(diagnosticReportsDir, entry)).mtimeMs >= sinceMs
    } catch {
      return false
    }
  }).length
}

export function bundleExecutablePath(appPath, appName = APP_NAME) {
  return join(appPath, 'Contents', 'MacOS', appName)
}

/**
 * pgrep -f pattern for "this bundle executable appears in a command line". Anchored
 * at the start so a different bundle never matches, but open at the end so an
 * instance launched with arguments (for example a remote-debugging port) still
 * matches. This is only a prefilter: see classifyBundleProcesses for why matching
 * the executable is not the same as the app running.
 */
export function runningExecutablePattern(executablePath) {
  const escaped = executablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `^${escaped}( |$)`
}

/**
 * pgrep arguments that list every process running this bundle executable.
 *
 * Why `-a`: macOS pgrep leaves out its own ancestors by default, and an install run from an
 * OmniConsole terminal descends from the app itself (app → PTY helper → login → shell). The
 * app was then invisible: the installer reported it not running, renamed the bundle under
 * the live app and `open` merely re-focused the old instance (measured 2026-09-23).
 */
export function bundleProcessPgrepArgs(executablePath) {
  return ['-a', '-fl', runningExecutablePattern(executablePath)]
}

/**
 * True when this command line runs the bundle executable as a plain Node runtime
 * rather than launching the app.
 *
 * The bundle's executable is reused for the `omni` CLI, so
 * `…/MacOS/OmniConsole …/out/cli/index.js claude-teams` is a terminal session, not
 * the desktop app. Electron decides this the same way: handed a script path it runs
 * that script instead of the packaged app, so a `.js` argument is the discriminator.
 *
 * Why it matters: these runs are long-lived sessions of a person's own work. Treating
 * one as the app made the installer wait 60s for a quit nobody had sent, then abort
 * (measured 2026-09-12 with five `claude-teams` sessions up); and after the swap it
 * made the "main process running" check pass whether or not the app had launched,
 * which is the worse half — a failed launch reported as a good install.
 */
export function isEmbeddedRun(commandLine) {
  return String(commandLine ?? '')
    .trim()
    .split(/\s+/)
    .slice(1)
    .some((argument) => argument.endsWith('.js'))
}

/**
 * True when this command line is a HEADLESS run of the bundle — the serve host and the
 * outcome-continuation relauncher — rather than the desktop app.
 *
 * Why it matters: AppleScript `quit` is delivered to the GUI app, and a headless run does
 * not receive it. Counted as the app, one made the installer wait out its full 60s after
 * the window had already quit and then abort without installing (measured 2026-09-19 with
 * `--serve --serve-no-pairing --serve-port 0 --outcome-continuation` up). The other half is
 * worse: a headless process keeps the OLD bundle's path in its argv, so after the swap it
 * would satisfy the post-install "main process running" check whether or not the new app
 * ever launched — the same false reading `isEmbeddedRun` exists to prevent.
 */
export function isHeadlessRun(commandLine) {
  const args = String(commandLine ?? '')
    .trim()
    .split(/\s+/)
    .slice(1)
  return args.includes('--serve') || args.includes('--outcome-continuation')
}

/**
 * True when this is a headless run of the bundle that holds the app's OWN profile
 * (`--user-data-dir <profileDir>`) — in practice the outcome-continuation host a quit leaves
 * behind to keep outcomes running, which is also what draws the window when the app is
 * activated again.
 *
 * Why it matters: it keeps the profile lock, so the freshly installed app hands its launch to
 * it and exits — and it is still running the OLD bundle's code. Measured on every install
 * 2026-09-22/23 (three in a row): "Main process FAIL" and "Daemon hello FAIL" until it was
 * stopped by hand. A serve host on some other profile (an e2e or scratch instance) is not
 * this and is left alone.
 */
export function holdsAppProfile(commandLine, profileDir) {
  const text = String(commandLine ?? '')
  if (!isHeadlessRun(text) || !profileDir) {
    return false
  }
  return [`--user-data-dir ${profileDir}`, `--user-data-dir=${profileDir}`].some((flag) => {
    const at = text.indexOf(flag)
    if (at === -1) {
      return false
    }
    const next = text.charAt(at + flag.length)
    return next === '' || next === ' '
  })
}

/**
 * pgrep arguments that list the direct children of a process (its renderer/GPU helpers, if any).
 */
export function childProcessPgrepArgs(pid) {
  // Why -f: macOS short names truncate both renderer and GPU helpers to "OmniConsole Hel".
  return ['-P', String(pid), '-fl']
}

/**
 * True when a process's children include an Electron renderer — the fallback sign of a window,
 * used only when the window server cannot be read (see promoteWindowedHeadlessRuns).
 *
 * Why not a GPU helper: every Electron main process starts one, windowed or not. Counting it made
 * a plain headless continuation host read as the app (measured 2026-10-12 installing 1.12.28): on
 * the MacBook the quit wait ran out its 60s on a process no quit reaches, and on the Mac Studio the
 * old 1.12.27 host was never stopped after the swap and kept drawing the window.
 */
export function hasWindowedChildren(childPgrepOutput) {
  return /Helper \((Renderer|Plugin)\)|--type=renderer/.test(String(childPgrepOutput ?? ''))
}

/**
 * osascript arguments that print the pids owning an on-screen, normal-level (layer 0) window,
 * after a `windows=<n>` count of every on-screen window. Owner pid and layer need no Screen
 * Recording grant; only window titles do.
 */
export function windowOwnersOsascriptArgs() {
  return [
    '-l',
    'JavaScript',
    '-e',
    `ObjC.import('CoreGraphics')
function run() {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))
  const owners = []
  for (let i = 0; i < list.count; i++) {
    const window = list.objectAtIndex(i)
    if (ObjC.unwrap(window.objectForKey('kCGWindowLayer')) === 0) {
      owners.push(ObjC.unwrap(window.objectForKey('kCGWindowOwnerPID')))
    }
  }
  return ['windows=' + list.count].concat(owners).join(' ')
}`
  ]
}

/**
 * The pids that own an on-screen window, or null when the window server could not be read. Why
 * null for zero windows: a GUI session always has on-screen windows (menu bar, Dock), so an empty
 * list means no window-server access (an SSH session outside the login session), not "no app".
 */
export function parseWindowOwnerPids(output) {
  const [count, ...pids] = String(output ?? '')
    .trim()
    .split(/\s+/)
  const match = /^windows=(\d+)$/.exec(count ?? '')
  if (!match || Number(match[1]) === 0) {
    return null
  }
  return new Set(pids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))
}

/**
 * Move headless-looking entries that are actually showing a window into `app`. Applied after
 * `classifyBundleProcesses` so every caller (quit, profile-holder stop, launch/verify checks) sees a
 * promoted continuation host as the app it now is, never as a stale headless run.
 *
 * Why: `--serve`/`--outcome-continuation` in a command line is not a live state, it is whatever argv
 * the process started with. `focusExistingMainWindow()` promotes a headless continuation host to
 * the desktop app in place — same pid, same argv, now with a window — so `isHeadlessRun` alone keeps
 * reading it as headless forever. Measured 2026-09-24: the promoted process (PID 70120) was
 * reported "not running" as the app and then SIGTERM'd as a stale headless profile holder.
 *
 * Why the window server and not child helpers: a headless serve host has a GPU helper and, with
 * the offscreen browser backend, renderers too, so neither proves a window. `windowOwnerPids` (from
 * parseWindowOwnerPids) is the proof; only when it is null do renderer children stand in for it.
 */
export function promoteWindowedHeadlessRuns(
  { app, embedded, headless },
  lookupChildren,
  windowOwnerPids = null
) {
  const isWindowed = (pid) =>
    windowOwnerPids ? windowOwnerPids.has(pid) : hasWindowedChildren(lookupChildren(pid))
  const stillHeadless = []
  const promoted = []
  for (const entry of headless) {
    if (isWindowed(entry.pid)) {
      promoted.push(entry)
    } else {
      stillHeadless.push(entry)
    }
  }
  return { app: [...app, ...promoted], embedded, headless: stillHeadless }
}

/**
 * Split `pgrep -fl` output into the app's own processes, the embedded runs that share its
 * executable, and the headless runs of the bundle. Embedded runs and headless runs on other
 * profiles are reported, never quit and never waited on: the install swap is a rename, which
 * they survive because their files move with them. A headless run on the app's own profile
 * is the exception (see holdsAppProfile): the installer stops it after the swap. A headless
 * entry that owns an on-screen window is not really headless at all — see promoteWindowedHeadlessRuns.
 */
export function classifyBundleProcesses(pgrepOutput) {
  const app = []
  const embedded = []
  const headless = []
  for (const line of String(pgrepOutput ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line)
    if (!match) {
      continue
    }
    const entry = { pid: Number(match[1]), command: match[2] }
    if (isEmbeddedRun(entry.command)) {
      embedded.push(entry)
    } else if (isHeadlessRun(entry.command)) {
      headless.push(entry)
    } else {
      app.push(entry)
    }
  }
  return { app, embedded, headless }
}

/**
 * The pids that run the app's code for its profile: the app itself and any headless run holding
 * the app's own profile. CLI runs and serve hosts on other profiles are not the app.
 */
export function appCodePids({ app, headless }, profileDir) {
  return new Set([
    ...app.map((entry) => entry.pid),
    ...headless.filter((entry) => holdsAppProfile(entry.command, profileDir)).map((e) => e.pid)
  ])
}

/**
 * Split the app-code pids running now into those that started after the swap (new bundle) and
 * those that were already running before it (old bundle, still executing the old code).
 *
 * Why: the version check reads the plist on disk, so it said "ok" on 2026-10-12 while the old
 * 1.12.27 continuation host kept running 1.12.27 and drawing the window. A pid from before the swap
 * is the old code whatever the plist says, so it neither proves the launch nor may outlive it.
 */
export function splitByPreSwap(currentPids, preSwapPids) {
  const fresh = []
  const old = []
  for (const pid of currentPids) {
    ;(preSwapPids.has(pid) ? old : fresh).push(pid)
  }
  return { fresh, old }
}

export function bundleInfoPlistPath(appPath) {
  return join(appPath, 'Contents', 'Info.plist')
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function formatSummary(rows) {
  const width = Math.max(...rows.map(([label]) => label.length))
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n')
}
