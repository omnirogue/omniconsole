import { describe, expect, it } from 'vitest'
import type { SessionPrepRepo } from './session-prep-host'
import { matchSessionPrepRepoHint, sessionPrepItemWorkspace } from './session-prep-target'
import type { SessionPrepItemRecord } from './session-prep-records'
import {
  assertSessionPrepExecutionHost,
  assertSessionPrepWorkspaceUnchanged
} from './session-prep-execution-host'

const repo = (name: string, path: string): SessionPrepRepo => ({
  id: name,
  name,
  path,
  selector: `id:${name}`,
  isFolder: false,
  isRemote: false
})

describe('session prep execution host', () => {
  const local = {
    ...repo('app-local', '/same/path'),
    repositoryKey: 'github:example/app',
    hostId: 'local'
  }
  const remote = {
    ...repo('app-ssh', '/same/path'),
    repositoryKey: local.repositoryKey,
    connectionId: 'ssh-one',
    hostId: 'ssh:ssh-one',
    host: 'mw0001',
    hostAliases: ['mw0001'],
    isRemote: true
  }
  const source = { ...local, repoId: local.id }
  const item = (host?: string, repoHint?: string): SessionPrepItemRecord => ({
    index: 0,
    planned: {
      title: 'Work',
      ask: 'Work',
      anchor: 'Work',
      direct: true,
      changesCode: true,
      ...(host ? { choices: { host } } : {}),
      ...(repoHint ? { repoHint } : {})
    },
    state: 'planned',
    verdicts: [],
    repairs: 0
  })

  it('uses registered project identity and preserves the SSH owner even at an identical path', () => {
    expect(sessionPrepItemWorkspace(item('mw0001'), source, [local, remote])).toMatchObject({
      repoId: remote.id,
      path: '/same/path',
      connectionId: 'ssh-one',
      hostId: 'ssh:ssh-one'
    })
  })

  it('never falls back to the local workspace for an unknown host or missing project copy', () => {
    expect(() => sessionPrepItemWorkspace(item('missing'), source, [local, remote])).toThrow(
      'No registered workspace'
    )
    expect(() =>
      sessionPrepItemWorkspace(item('mw0001'), source, [
        local,
        { ...remote, repositoryKey: 'other' }
      ])
    ).toThrow('No unambiguous registered workspace')
  })

  it('keeps an unspecified destination on the source host', () => {
    expect(sessionPrepItemWorkspace(item(), source, [local, remote])).toBe(source)
    const remoteSource = { ...remote, repoId: remote.id }
    expect(sessionPrepItemWorkspace(item(), remoteSource, [local, remote])).toBe(remoteSource)
  })

  it('refuses ambiguous registered copies and paired-runtime aliases', () => {
    expect(() =>
      sessionPrepItemWorkspace(item('mw0001'), source, [
        local,
        remote,
        { ...remote, id: 'duplicate', path: '/another/copy' }
      ])
    ).toThrow('No unambiguous')
    expect(() => assertSessionPrepExecutionHost({ ...source, hostId: 'runtime:peer' })).toThrow(
      'SSH workspace'
    )
    // Why: the refusal names the route that does reach a paired Mac.
    expect(() => assertSessionPrepExecutionHost({ ...source, hostId: 'runtime:peer' })).toThrow(
      'ask the project chat'
    )
  })

  it('rejects an edited SSH destination even when its registration id is unchanged', () => {
    const prepared = {
      ...remote,
      repoId: remote.id,
      connectionGeneration: 3,
      connectionBinding: 'original'
    }
    expect(() =>
      assertSessionPrepWorkspaceUnchanged(prepared, {
        ...prepared,
        connectionBinding: 'another-host'
      })
    ).toThrow('SSH target changed')
    expect(() =>
      assertSessionPrepWorkspaceUnchanged(prepared, {
        ...prepared,
        connectionGeneration: 4
      })
    ).toThrow('SSH target changed')
  })
})

const repos = [
  repo('Marketing', '/work/OmniRogue/Marketing'),
  repo('omnirogue-omniconsole', '/repos/omnirogue-omniconsole'),
  repo('betacorpai-site', '/work/BetaCorp/betacorpai-site'),
  repo('betacorp-admin', '/work/BetaCorp/betacorp-admin')
]

describe('matchSessionPrepRepoHint', () => {
  it('prefers an exact name or folder name', () => {
    expect(matchSessionPrepRepoHint(repos, 'marketing')?.name).toBe('Marketing')
    expect(matchSessionPrepRepoHint(repos, 'omnirogue-omniconsole')?.name).toBe(
      'omnirogue-omniconsole'
    )
  })

  it('falls back to the one repository whose name contains the hint', () => {
    expect(matchSessionPrepRepoHint(repos, 'OmniRogue')?.name).toBe('omnirogue-omniconsole')
  })

  it('refuses ambiguous or too-short hints', () => {
    expect(matchSessionPrepRepoHint(repos, 'betacorp')).toBeNull()
    expect(matchSessionPrepRepoHint(repos, 'om')).toBeNull()
    expect(matchSessionPrepRepoHint(repos, '')).toBeNull()
  })
})
