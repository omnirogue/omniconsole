import { describe, expect, it } from 'vitest'
import { TASK_PROVIDERS } from './task-providers'
import {
  applyTaskSourcesMode,
  getConfiguredTaskProviders,
  readTaskSourcesMode,
  resolveTaskSourcesMode,
  selectTaskProviderCards,
  selectVisibleTaskProviders
} from './task-providers-mode'

describe('task sources mode', () => {
  it('defaults an unset or corrupt mode to all', () => {
    expect(readTaskSourcesMode(undefined)).toBe('all')
    expect(readTaskSourcesMode('nonsense')).toBe('all')
    expect(readTaskSourcesMode('all')).toBe('all')
    expect(readTaskSourcesMode('console-only')).toBe('console-only')
  })

  it('yields only the console provider in console-only mode', () => {
    expect(applyTaskSourcesMode('console-only', TASK_PROVIDERS)).toEqual(['backoffice'])
    expect(selectTaskProviderCards('console-only')).toEqual(['backoffice'])
    expect(
      selectVisibleTaskProviders({
        taskSourcesMode: 'console-only',
        visibleTaskProviders: ['github', 'gitlab', 'jira']
      })
    ).toEqual(['backoffice'])
  })

  it('answers with the console even when the saved list omits it', () => {
    // A list is never allowed to be empty; console-only means the console.
    expect(applyTaskSourcesMode('console-only', ['github', 'jira'])).toEqual(['backoffice'])
  })

  it('returns upstream behaviour untouched in all mode', () => {
    expect(applyTaskSourcesMode('all', ['github', 'jira'])).toEqual(['github', 'jira'])
    expect(selectTaskProviderCards('all')).toEqual([...TASK_PROVIDERS])
    expect(
      selectVisibleTaskProviders({
        taskSourcesMode: 'all',
        visibleTaskProviders: ['jira', 'github']
      })
    ).toEqual(['jira', 'github'])
  })

  it('never mutates the saved provider list, so all mode restores it exactly', () => {
    const saved = { taskSourcesMode: 'console-only', visibleTaskProviders: ['github', 'linear'] }
    expect(selectVisibleTaskProviders(saved)).toEqual(['backoffice'])
    expect(selectVisibleTaskProviders({ ...saved, taskSourcesMode: 'all' })).toEqual([
      'github',
      'linear'
    ])
    expect(saved.visibleTaskProviders).toEqual(['github', 'linear'])
  })
})

describe('configured task providers', () => {
  it('reads a last-used source other than the factory default', () => {
    expect(getConfiguredTaskProviders({ defaultTaskSource: 'jira' })).toEqual(['jira'])
    // 'github' is what a fresh profile ships with, so it proves nothing.
    expect(getConfiguredTaskProviders({ defaultTaskSource: 'github' })).toEqual([])
  })

  it('reads provider-specific setup written only after real use', () => {
    expect(getConfiguredTaskProviders({ defaultLinearTeamSelection: ['team_1'] })).toEqual([
      'linear'
    ])
    expect(
      getConfiguredTaskProviders({
        githubProjects: { pinned: [], recent: [{ owner: 'acme' }] },
        gitlabProjects: { pinned: [{ host: 'gitlab.com', path: 'acme/app' }], recent: [] }
      })
    ).toEqual(['github', 'gitlab'])
  })

  it('treats empty selections as not configured', () => {
    expect(
      getConfiguredTaskProviders({
        defaultLinearTeamSelection: [],
        githubProjects: { pinned: [], recent: [] }
      })
    ).toEqual([])
    expect(getConfiguredTaskProviders(undefined)).toEqual([])
  })
})

describe('task sources mode resolution at load', () => {
  it('keeps a mode the person chose in Settings', () => {
    expect(resolveTaskSourcesMode({ storedMode: 'console-only', storedModeChosen: true })).toBe(
      'console-only'
    )
    expect(resolveTaskSourcesMode({ storedMode: 'all', storedModeChosen: true })).toBe('all')
  })

  it('undoes the console-only stamp older builds wrote without a choice', () => {
    expect(resolveTaskSourcesMode({ storedMode: 'console-only' })).toBe('all')
    expect(resolveTaskSourcesMode({ storedMode: 'console-only', storedModeChosen: false })).toBe(
      'all'
    )
  })

  it('resolves a brand-new or corrupt profile to all', () => {
    expect(resolveTaskSourcesMode({})).toBe('all')
    expect(resolveTaskSourcesMode({ storedMode: 'nonsense', storedModeChosen: true })).toBe('all')
  })
})
