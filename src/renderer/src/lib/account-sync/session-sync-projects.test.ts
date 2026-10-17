import { describe, expect, it } from 'vitest'
import {
  collectRemote,
  mergeProjects,
  parseProjectDoc
} from '../../../../shared/account-sync-session-docs'
import { deviceDocKey, parseDeviceDocKey } from '../../../../shared/account-sync-session-keys'
import { emptyProjectSettings, type ProjectSettings } from '../../../../shared/project-settings'
import type { SessionFolder } from '@/lib/session-folders'
import { docValue } from './session-sync-layout'
import { applySyncedProjects, authorProjectEdits, changedProjectIds } from './session-sync-projects'

const ADS = '11111111-1111-4111-8111-111111111111'
const folders: SessionFolder[] = [{ id: ADS, name: 'Ads' }]
const settings = (company?: string): ProjectSettings => ({
  ...emptyProjectSettings(1),
  ...(company ? { company } : {})
})

describe('project settings sync', () => {
  it('writes a p document an older version skips and this one reads back', () => {
    const key = deviceDocKey('0123abcd', 'projects', 0)
    expect(key).toBe('omni-ide.sync.d.0123abcd.p.0')
    expect(parseDeviceDocKey(key)).toEqual({ device: '0123abcd', kind: 'projects' })
    // Why: an older version's key rule only knows f and s documents.
    expect(/^omni-ide\.sync\.d\.([0-9a-f]{8})\.([fs])\.(\d{1,3})$/.test(key)).toBe(false)
    const value = docValue('projects', { [ADS]: { v: settings('omnirogue'), t: 5 } })
    const { all } = collectRemote({ [key]: value }, 'ffffffff')
    expect(all.projects?.[ADS]?.v?.company).toBe('omnirogue')
  })

  it('drops a record no person made, and anything malformed', () => {
    const agentMade = { ...settings(), createdBy: 'agent' }
    const doc = {
      v: 1,
      p: {
        [ADS]: { v: agentMade, t: 3 },
        'not-a-folder': { v: settings(), t: 3 },
        '22222222-2222-4222-8222-222222222222': { v: { repos: 'x' }, t: 3 }
      }
    }
    expect(parseProjectDoc(doc)).toEqual({})
  })

  it('publishes only what the person changed, and a removal as a tombstone', () => {
    let clock = 10
    const stamp = () => ++clock
    const changed = authorProjectEdits({
      merged: { [ADS]: { v: settings('old'), t: 4 } },
      local: { [ADS]: settings('new') },
      noted: new Set([ADS]),
      stamp
    })
    expect(changed).toEqual({ [ADS]: { v: settings('new'), t: 11 } })
    const unnoted = authorProjectEdits({
      merged: { [ADS]: { v: settings('old'), t: 4 } },
      local: { [ADS]: settings('stale copy') },
      noted: new Set(),
      stamp
    })
    expect(unnoted).toEqual({})
    const removed = authorProjectEdits({
      merged: { [ADS]: { v: settings('old'), t: 4 } },
      local: {},
      noted: new Set([ADS]),
      stamp
    })
    expect(removed).toEqual({ [ADS]: { t: 12, x: 1 } })
  })

  it('applies the later write, removals included, for folders this computer has', () => {
    const later = mergeProjects(
      { [ADS]: { v: settings('a'), t: 4 } },
      { [ADS]: { v: settings('b'), t: 9 } }
    )
    expect(applySyncedProjects(folders, { [ADS]: settings('a') }, later)).toEqual({
      [ADS]: settings('b')
    })
    expect(
      applySyncedProjects(folders, { [ADS]: settings('a') }, { [ADS]: { t: 10, x: 1 } })
    ).toEqual({})
    expect(applySyncedProjects([], {}, later)).toBeNull()
    expect(applySyncedProjects(folders, { [ADS]: settings('b') }, later)).toBeNull()
  })

  it('notes a project edit for the journal', () => {
    expect(changedProjectIds({}, { [ADS]: settings() })).toEqual([ADS])
    expect(changedProjectIds({ [ADS]: settings() }, { [ADS]: settings() })).toEqual([])
    expect(changedProjectIds({ [ADS]: settings() }, {})).toEqual([ADS])
  })
})
