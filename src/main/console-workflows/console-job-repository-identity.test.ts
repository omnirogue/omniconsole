import { describe, expect, it } from 'vitest'
import { consoleJobRepositoryIdentity } from './console-job-repository-identity'

describe('canonical console job repository identity', () => {
  it.each([
    'omnirogue/omni-ide',
    'https://github.com/omnirogue/omni-ide.git',
    'git@github.com:omnirogue/omni-ide.git',
    'ssh://git@github.com/omnirogue/omni-ide.git'
  ])('maps the GitHub slug and its transport equivalent %s to the same identity', (repo) => {
    expect(consoleJobRepositoryIdentity(repo)).toBe('github.com/omnirogue/omni-ide')
  })

  it('keeps the same owner and repository on GitLab distinct from the Foreman GitHub slug', () => {
    expect(consoleJobRepositoryIdentity('https://gitlab.com/omnirogue/omni-ide.git')).toBe(
      'gitlab.com/omnirogue/omni-ide'
    )
    expect(consoleJobRepositoryIdentity('https://gitlab.com/omnirogue/omni-ide.git')).not.toBe(
      consoleJobRepositoryIdentity('omnirogue/omni-ide')
    )
  })

  it.each([
    'gitlab.example/team/project',
    'https://gitlab.example/team/project.git',
    'git@gitlab.example:team/project.git'
  ])('preserves the explicit host in %s', (repo) => {
    expect(consoleJobRepositoryIdentity(repo)).toBe('gitlab.example/team/project')
  })

  it.each([
    '',
    'not a repository',
    'owner',
    'owner//repo',
    '/tmp/owner/repo',
    'C:\\repo',
    'https://',
    'owner/repo\0',
    '../repo',
    './repo',
    'owner/..',
    'owner/.'
  ])('refuses malformed repository identity %j', (repo) => {
    expect(consoleJobRepositoryIdentity(repo)).toBeNull()
  })
})
