import { describe, expect, it } from 'vitest'
import { githubRepoReference } from './github-repo-reference'

describe('the GitHub repository an option names', () => {
  it('reads owner/name at the start, or a github.com link anywhere', () => {
    expect(githubRepoReference('timgit/pg-boss — Postgres job queue')).toEqual({
      owner: 'timgit',
      repo: 'pg-boss'
    })
    expect(
      githubRepoReference('A queue: https://github.com/graphile/worker.git, maintained')
    ).toEqual({ owner: 'graphile', repo: 'worker' })
    expect(githubRepoReference('taskforcesh/bullmq')).toEqual({
      owner: 'taskforcesh',
      repo: 'bullmq'
    })
  })

  it('takes nothing that is not a repository name', () => {
    for (const text of [
      'Use it for jobs and/or events',
      'bee-queue — simple Redis queue',
      'bad--owner/repo',
      '-owner/repo',
      'owner/ repo',
      'https://gitlab.com/owner/repo'
    ]) {
      expect(githubRepoReference(text), text).toBeUndefined()
    }
  })
})
