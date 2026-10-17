/**
 * A typed command line as argv, without a shell: quotes group words. On Windows a backslash is a
 * path separator and escapes only a double quote; elsewhere it escapes as it does in sh.
 */
export function graphCheckArgv(
  command: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const windows = platform === 'win32'
  const argv: string[] = []
  let word = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    const next = command[index + 1]
    const escapes =
      char === '\\' &&
      next !== undefined &&
      quote !== "'" &&
      (windows ? next === '"' : quote !== '"' || '"\\$`'.includes(next))
    if (escapes) {
      word += next
      index++
      started = true
    } else if (quote) {
      if (char === quote) {
        quote = undefined
      } else {
        word += char
      }
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        argv.push(word)
        word = ''
        started = false
      }
    } else {
      word += char
      started = true
    }
  }
  if (started) {
    argv.push(word)
  }
  return argv
}

// What a test or benchmark needs to find its tools; none of these hold credentials.
const KEEP = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TERM',
  'NVM_DIR',
  'PNPM_HOME',
  'VOLTA_HOME',
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'PYENV_ROOT',
  'VIRTUAL_ENV',
  'CONDA_PREFIX'
])
const KEEP_WINDOWS = new Set([
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS'
])

/**
 * The environment a check runs with. The check may run code a model wrote, so it never inherits
 * the app's environment, where API keys and tokens live: only tool locations and locale pass.
 */
export function graphCheckEnvironment(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    // Windows names are case-insensitive, so `Path` is PATH there.
    const key = platform === 'win32' ? name.toUpperCase() : name
    if (
      value !== undefined &&
      (KEEP.has(key) ||
        key.startsWith('LC_') ||
        key.startsWith('XDG_') ||
        (platform === 'win32' && KEEP_WINDOWS.has(key)))
    ) {
      env[name] = value
    }
  }
  // Colour codes would only clutter the output the next round reads.
  return { ...env, NO_COLOR: '1', FORCE_COLOR: '0', ...extra }
}
