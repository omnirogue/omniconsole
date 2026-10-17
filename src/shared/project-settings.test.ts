import { describe, expect, it } from 'vitest'
import {
  emptyProjectSettings,
  isHostBoundAttachment,
  parseProjectSettings,
  projectSettingsError,
  withProjectCoordinator
} from './project-settings'

describe('project coordinator record', () => {
  it('keeps a coordinator naming an agent this build lacks, and refuses one with no agent', () => {
    const settings = {
      ...emptyProjectSettings(1),
      coordinator: {
        launch: {
          agent: 'agent-from-a-later-build',
          model: 'ollama/gemma3:12b',
          effort: 'max',
          team: true,
          templateId: 'coordinator'
        },
        sessionKey: 'provider-key'
      }
    }
    expect(parseProjectSettings(settings)).toEqual(settings)
    expect(parseProjectSettings({ ...settings, coordinator: { launch: { agent: '' } } })).toBeNull()
  })

  it('binds the coordinator and lists the orchestration skill once', () => {
    const coordinator = { launch: { agent: 'codex' as const, team: true } }
    const bound = withProjectCoordinator(emptyProjectSettings(1), coordinator)
    expect(bound.coordinator).toEqual(coordinator)
    expect(bound.attachments).toEqual([
      { id: 'skill-name:orchestration', kind: 'skill', title: 'orchestration' }
    ])
    expect(projectSettingsError(bound)).toBeNull()
    const started = withProjectCoordinator(bound, { ...coordinator, sessionKey: 'pane-key' })
    expect(started.attachments).toBe(bound.attachments)
    expect(started.coordinator?.sessionKey).toBe('pane-key')
  })
})

describe('repo-relative attachments', () => {
  it('keeps the repo a file sits in, which lets the file travel to another computer', () => {
    const file = {
      id: 'file:local:/Users/maintainer/omni-ide/docs/brief.md',
      kind: 'file' as const,
      title: 'brief.md',
      uri: '/Users/maintainer/omni-ide/docs/brief.md',
      hostId: 'local'
    }
    const repo = { gitIdentity: 'github.com/omnirogue/omni-ide', path: 'docs/brief.md' }
    const settings = { ...emptyProjectSettings(1), attachments: [{ ...file, repo }] }
    expect(parseProjectSettings(settings)).toEqual(settings)
    expect(isHostBoundAttachment(file)).toBe(true)
    expect(isHostBoundAttachment({ ...file, repo })).toBe(false)
  })
})

describe('project Jira issues', () => {
  const ref = {
    provider: 'jira' as const,
    cloud_id: 'bb6f9191-a21a-4857-b965-32de82dce68b',
    issue_id: '10001',
    issue_key: 'ADS-12',
    project_key: 'ADS'
  }

  it('keeps up to 20 issue links and refuses the same issue twice', () => {
    const settings = { ...emptyProjectSettings(1), tasks: [ref] }
    expect(parseProjectSettings(settings)).toEqual(settings)
    expect(parseProjectSettings(emptyProjectSettings(1))?.tasks).toBeUndefined()
    expect(projectSettingsError({ ...settings, tasks: [ref, ref] })).toBe(
      'That issue is already on this project.'
    )
    const many = Array.from({ length: 21 }, (_, index) => ({
      ...ref,
      issue_id: String(index + 1),
      issue_key: `ADS-${index + 1}`
    }))
    expect(projectSettingsError({ ...settings, tasks: many })).not.toBeNull()
  })
})
