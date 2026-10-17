// Values must be skipped before identifying a subcommand: a model or workspace
// named "exec" is not a headless launch. `--` makes the rest a positional prompt.
const VALUE_FLAGS = new Set([
  '--provider',
  '--model',
  '--reasoning-effort',
  '--effort',
  '-c',
  '--config',
  '--workspace',
  '--approval-mode',
  '--permission-profile',
  '--approval-judge',
  '--echo-delay-ms',
  '--sandbox-network'
])

export function isMuseHeadlessCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      return false
    }
    if (VALUE_FLAGS.has(token)) {
      index += 1
      continue
    }
    if (token === '-w' || token === '--worktree') {
      if (['off', 'create', 'existing'].includes(tokens[index + 1] ?? '')) {
        index += 1
      }
      continue
    }
    if (token.startsWith('-')) {
      continue
    }
    return token === 'exec' || token === 'serve'
  }
  return false
}
