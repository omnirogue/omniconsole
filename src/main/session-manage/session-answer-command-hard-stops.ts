import { tokenizeCustomCommandTemplate } from '../../shared/commit-message-prompt'

const GIT_ARGUMENT_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix'
])
const GIT_SWITCHES = new Set([
  '-p',
  '-P',
  '--paginate',
  '--no-pager',
  '--no-replace-objects',
  '--bare',
  '--literal-pathspecs',
  '--no-literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-lazy-fetch',
  '--no-advice'
])

function rememberAlias(
  aliases: Map<string, string | null>,
  value: string,
  fromEnvironment = false
): void {
  const match = /^alias\.([^=]+)(?:=(.*))?$/i.exec(value)
  if (match) {
    aliases.set(match[1]!.toLowerCase(), fromEnvironment ? null : (match[2] ?? null))
  }
}

type ResolvedGitCommand = { command: string; aliasText?: string }

function resolveAlias(
  command: string,
  aliases: Map<string, string | null>,
  words: readonly string[],
  commandIndex: number
): ResolvedGitCommand {
  const aliasArguments: string[] = []
  const seen = new Set<string>()
  while (aliases.has(command.toLowerCase())) {
    const key = command.toLowerCase()
    if (seen.has(key)) {
      return { command: 'unknown-inline-alias' }
    }
    seen.add(key)
    const value = aliases.get(key)
    if (!value) {
      return { command: 'unknown-inline-alias' }
    }
    const parsed = tokenizeCustomCommandTemplate(value)
    if (
      !parsed.ok ||
      !parsed.tokens.length ||
      parsed.spans.some((span) => span.divergesFromShell)
    ) {
      return { command: 'unknown-inline-alias' }
    }
    aliasArguments.unshift(parsed.tokens.slice(1).join(' '))
    command = parsed.tokens[0]!
    if (command.startsWith('-') || command.startsWith('!')) {
      return { command: 'unknown-inline-alias' }
    }
  }
  return {
    command,
    ...(seen.size
      ? {
          aliasText: ['git', command, ...aliasArguments, ...words.slice(commandIndex + 1)].join(' ')
        }
      : {})
  }
}

/** Follow Git globals and explicit inline aliases. Environment-backed aliases cannot be verified. */
function gitSubcommand(
  words: readonly string[],
  start: number,
  lastClean: number
): ResolvedGitCommand | null {
  const aliases = new Map<string, string | null>()
  for (let index = start + 1; index < words.length; index += 1) {
    const word = words[index]!
    if (word === '-c' || word === '--config-env') {
      rememberAlias(aliases, words[++index] ?? '', word === '--config-env')
      continue
    }
    if (word.startsWith('-c') && word.length > 2) {
      rememberAlias(aliases, word.slice(2))
      continue
    }
    if (word.startsWith('--config-env=')) {
      rememberAlias(aliases, word.slice('--config-env='.length), true)
      continue
    }
    if (GIT_ARGUMENT_FLAGS.has(word)) {
      index += 1
      continue
    }
    if (
      GIT_SWITCHES.has(word) ||
      /^-C.+/.test(word) ||
      /^--(?:git-dir|work-tree|namespace|super-prefix)=/.test(word)
    ) {
      continue
    }
    if (word.startsWith('-')) {
      return lastClean > index ? { command: 'clean' } : { command: 'unknown-inline-alias' }
    }
    return resolveAlias(word, aliases, words, index)
  }
  return null
}

function executableName(word: string): string | undefined {
  return word
    .split(/[/\\]/)
    .at(-1)
    ?.replace(/\.exe$/i, '')
    .toLowerCase()
}

function deletesHttpResource(words: readonly string[], index: number): boolean {
  const word = words[index]!
  const method =
    word === '--request' || word === '-X'
      ? words[index + 1]
      : word.startsWith('--request=')
        ? word.slice('--request='.length)
        : /^-[^-]*X(.*)$/.exec(word)?.[1]
  const effectiveMethod = method === '' && /^-[^-]*X$/.test(word) ? words[index + 1] : method
  return effectiveMethod?.toUpperCase() === 'DELETE'
}

/** Classify literal executable subsequences too: assignments and env/command/sudo wrappers
 * do not make their destructive child command safe. Quoted argv stay intact here. */
export function destructiveLiteralCommand(
  text: string,
  classifyAlias: (canonical: string) => boolean
): boolean {
  const parsed = tokenizeCustomCommandTemplate(text)
  if (!parsed.ok || !parsed.tokens.length || parsed.spans.some((span) => span.divergesFromShell)) {
    return false
  }
  const words = parsed.tokens
  const lastClean = words.lastIndexOf('clean')
  let sawCurl = false
  let gitConfigEnvironment = false
  // Walk by index, without repeatedly copying/scanning every suffix of a long command.
  for (let index = 0; index < words.length; index += 1) {
    gitConfigEnvironment ||= /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)=/.test(
      words[index]!
    )
    const executable = executableName(words[index]!)
    if (executable === 'git') {
      // Inline environment config can define aliases whose effective expansion is unknown here.
      if (gitConfigEnvironment) {
        return true
      }
      const resolved = gitSubcommand(words, index, lastClean)
      if (
        resolved?.command === 'clean' ||
        resolved?.command === 'unknown-inline-alias' ||
        (resolved?.aliasText && classifyAlias(resolved.aliasText))
      ) {
        return true
      }
    }
    if (sawCurl && deletesHttpResource(words, index)) {
      return true
    }
    sawCurl ||= executable === 'curl'
  }
  return false
}
