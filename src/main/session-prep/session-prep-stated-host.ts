import type { PlannedItem, PrepRepoChoice } from '../../shared/session-prep-types'
import { choiceWords } from './session-prep-choices'
import { SessionPrepHostError } from './session-prep-execution-host'

/** A missed host is a planning failure, never permission to infer a destination. */
export function withStatedHost(
  items: PlannedItem[],
  request: string,
  repos: PrepRepoChoice[],
  sourceHostId?: string
): PlannedItem[] {
  const words = ` ${choiceWords(request)} `
  const aliases = (repo: PrepRepoChoice) =>
    [repo.host, ...(repo.hostAliases ?? [])]
      .filter((name): name is string => Boolean(name && name.length >= 3))
      .map(choiceWords)
  const owner = (repo: PrepRepoChoice) => repo.host
  const owners = new Set(
    repos
      .filter((repo) =>
        [repo.host, ...(repo.hostAliases ?? [])].some(
          (alias) =>
            alias &&
            alias.length >= 3 &&
            choiceWords(alias) !== 'local' &&
            !/^(?:ssh|runtime):/.test(alias) &&
            words.includes(` ${choiceWords(alias)} `)
        )
      )
      .map(owner)
  )
  // A local mention needs no retarget when a host-less item already inherits a local source.
  if (/\b(?:on|onto|host) (?:local|this mac|this computer)\b/.test(words)) {
    owners.add('local')
  }
  if (owners.size === 0) {
    return items
  }
  const implicitLocal = sourceHostId === 'local' && owners.size === 1 && owners.has('local')
  const assigned = new Set(
    items.flatMap((item) => {
      const choice = choiceWords(item.choices?.host ?? (implicitLocal ? 'local' : ''))
      return ['local', 'this mac', 'this computer'].includes(choice)
        ? ['local']
        : repos.filter((repo) => aliases(repo).includes(choice)).map(owner)
    })
  )
  if (
    (!implicitLocal && items.some((item) => !item.choices?.host)) ||
    [...owners].some((owner) => !assigned.has(owner))
  ) {
    throw new SessionPrepHostError(
      'Preparation could not assign every session to its requested Mac. No sessions launched.'
    )
  }
  return items
}
