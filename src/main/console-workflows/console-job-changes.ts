import { SESSION_CHAIN_OUTPUT_ROOT } from '../../shared/session-chain-types'
import { gitExecFileAsync } from '../git/runner'

export function isUntrackedConsoleRuntimePath(file: string, ownedPaths: string[] | null): boolean {
  return (
    file.startsWith(`${SESSION_CHAIN_OUTPUT_ROOT}/`) &&
    !ownedPaths?.some(
      (pattern) => isRepositoryPath(pattern) && matchesOwnedPath(file, pattern.trim())
    )
  )
}

export async function snapshotConsoleJobChanges(
  cwd: string,
  startSha: string,
  ignoreUntracked?: (file: string) => boolean
): Promise<string[]> {
  if (!/^[a-f0-9]{40,64}$/i.test(startSha)) {
    throw new Error('The attempt start commit is invalid.')
  }
  // All flags predate Git 2.25; no host capability probe is needed.
  const outputs = await Promise.all([
    gitExecFileAsync(['diff', '--name-only', '-z', '--no-renames', startSha, 'HEAD', '--'], {
      cwd
    }),
    gitExecFileAsync(['diff', '--name-only', '-z', '--no-renames', '--cached', '--'], { cwd }),
    gitExecFileAsync(['diff', '--name-only', '-z', '--no-renames', '--'], { cwd }),
    gitExecFileAsync(['ls-files', '--others', '--exclude-standard', '-z'], { cwd })
  ])
  // Reverted writes still occurred and remain in the unpublished history.
  const history = await gitExecFileAsync(
    ['log', '--format=', '--name-only', '-z', '--no-renames', '-m', `${startSha}..HEAD`, '--'],
    { cwd }
  )
  return [
    ...new Set([
      ...outputs.flatMap(({ stdout }, index) =>
        stdout.split('\0').filter((file) => file && !(index === 3 && ignoreUntracked?.(file)))
      ),
      ...history.stdout.split('\0').filter(Boolean)
    ])
  ].sort()
}

export function consoleJobPathViolations(
  files: string[],
  ownedPaths: string[] | null,
  readOnly: boolean
): string[] {
  if (readOnly) {
    return [...new Set(files)].sort()
  }
  return [...new Set(files)]
    .filter((file) => {
      if (!isRepositoryPath(file)) {
        return true
      }
      if (ownedPaths === null) {
        return false
      }
      return !ownedPaths.some((pattern) => {
        if (!isRepositoryPath(pattern)) {
          return false
        }
        return matchesOwnedPath(file, pattern.trim())
      })
    })
    .sort()
}

function isRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split('/').some((part) => part === '..' || part === '.')
  )
}

function matchesOwnedPath(file: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const root = pattern.slice(0, -3)
    return file === root || file.startsWith(`${root}/`)
  }
  if (pattern.endsWith('/')) {
    return file.startsWith(pattern)
  }
  if (!/[*?[]/.test(pattern)) {
    return file === pattern || file.startsWith(`${pattern}/`)
  }
  let expression = ''
  for (let index = 0; index < pattern.length; index++) {
    if (pattern.startsWith('**/', index)) {
      expression += '(?:.*/)?'
      index += 2
    } else if (pattern.startsWith('**', index)) {
      expression += '.*'
      index++
    } else if (pattern[index] === '*') {
      expression += '[^/]*'
    } else if (pattern[index] === '?') {
      expression += '[^/]'
    } else if (pattern[index] === '[' && pattern.includes(']', index)) {
      const end = pattern.indexOf(']', index)
      expression += pattern.slice(index, end + 1).replaceAll('\\', '\\\\')
      index = end
    } else {
      expression += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  try {
    return new RegExp(`^(?:${expression})$`, 'u').test(file)
  } catch {
    return false
  }
}
