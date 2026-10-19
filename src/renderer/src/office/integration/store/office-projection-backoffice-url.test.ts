import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree, WorkspaceLinkedItem } from '../../../../../shared/worktree/types'
import { officeProjectionBackofficeUrl } from './office-projection-backoffice-url'

const origin = 'https://omnios.example.com'
const item: WorkspaceLinkedItem = {
  provider: 'backoffice',
  type: 'issue',
  number: 0,
  title: 'Reply to the customer',
  url: `${origin}/work#work?task=btk_card1234`,
  hubTaskId: 'btk_card1234'
}

function state(worktrees: Partial<Worktree>[] = []) {
  return {
    settings: {
      backofficeEnv: 'production',
      backofficeProductionUrl: origin
    } as AppState['settings'],
    worktreesByRepo: { repo: worktrees as Worktree[] },
    detectedWorktreesByRepo: {},
    folderWorkspaces: []
  }
}

describe('office projection backoffice navigation', () => {
  it('uses the configured person backoffice and existing session detail path', () => {
    expect(officeProjectionBackofficeUrl('sess:ses_reply/1', state())).toBe(
      `${origin}/sessions/ses_reply%2F1`
    )
  })

  it('reuses a same-origin source link for the explicitly bound card', () => {
    const source = `${origin}/work#work?task=btk_card1234&view=review`
    expect(
      officeProjectionBackofficeUrl(
        'worktree:workspace',
        state([{ id: 'workspace', linkedWorkItem: { ...item, url: source } }])
      )
    ).toBe(source)
  })

  it.each([
    'https://elsewhere.example.com/card',
    'https://user:pass@omnios.example.com/card',
    'invalid'
  ])('uses canonical card navigation when its source URL is unsuitable: %s', (url) => {
    expect(
      officeProjectionBackofficeUrl(
        'worktree:workspace',
        state([{ id: 'workspace', linkedWorkItem: { ...item, url } }])
      )
    ).toBe(`${origin}/work#work?task=btk_card1234`)
  })

  it('does not guess a hub card from titles or conflicting host bindings', () => {
    expect(
      officeProjectionBackofficeUrl(
        'worktree:workspace',
        state([{ id: 'workspace', displayName: 'btk_title1234' }])
      )
    ).toBe(origin)
    expect(
      officeProjectionBackofficeUrl(
        'worktree:workspace',
        state([
          { id: 'workspace', hostId: 'local', linkedWorkItem: item },
          {
            id: 'workspace',
            hostId: 'ssh:remote',
            linkedWorkItem: { ...item, hubTaskId: 'btk_other1234' }
          }
        ])
      )
    ).toBe(origin)
  })

  it('never links ad hoc tasks or a backoffice without a usable URL', () => {
    expect(officeProjectionBackofficeUrl('task_local', state())).toBeNull()
    expect(
      officeProjectionBackofficeUrl('sess:ses_reply', {
        ...state(),
        settings: {
          backofficeEnv: 'local',
          backofficeLocalUrl: ''
        } as AppState['settings']
      })
    ).toBeNull()
  })

  it('falls back to the live console when no production URL was configured', () => {
    expect(
      officeProjectionBackofficeUrl('sess:ses_reply', {
        ...state(),
        settings: {} as AppState['settings']
      })
    ).toBe('https://console.example.com/sessions/ses_reply')
  })
})
