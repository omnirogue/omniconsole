import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../shared/automations-types'
import type { ConversationFleetSidebarGroup } from './conversation-fleet-sidebar'
import { addConversationRoutineRows } from './conversation-routine-rows'
import { emptySessionFolderMetadata, type SessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView, type SessionSidebarView } from './session-sidebar-view'

const FOLDER = '11111111-1111-4111-8111-111111111111'

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'ads',
    name: 'Advertising',
    prompt: 'Check the ads',
    rrule: '*/30 * * * *',
    enabled: true,
    nextRunAt: Date.now() + 60_000,
    ...overrides
  } as Automation
}

function group(
  overrides: Partial<ConversationFleetSidebarGroup> & Pick<ConversationFleetSidebarGroup, 'key'>
): ConversationFleetSidebarGroup {
  return {
    kind: 'workspace',
    label: 'Active',
    rows: [],
    fleetRows: [],
    collapsed: false,
    hidden: false,
    attentionCount: 0,
    canReorder: true,
    canHide: true,
    ...overrides
  }
}

function place(
  automations: Automation[],
  options: {
    groups?: ConversationFleetSidebarGroup[]
    metadata?: SessionFolderMetadata
    view?: SessionSidebarView
    archivedKeys?: string[]
    query?: string
    showHidden?: boolean
    showArchived?: boolean
  } = {}
) {
  return addConversationRoutineRows({
    groups: options.groups ?? [],
    automations,
    target: { kind: 'local' },
    metadata: options.metadata ?? emptySessionFolderMetadata(),
    view: options.view ?? emptySessionSidebarView(),
    archivedKeys: new Set(options.archivedKeys ?? []),
    query: options.query ?? '',
    showHidden: options.showHidden ?? false,
    showArchived: options.showArchived ?? false
  })
}

function listing(result: ReturnType<typeof place>) {
  return result.groups.map((entry) => [
    entry.key,
    entry.label,
    entry.routineRows.map((row) => row.automation.name)
  ])
}

describe('routines listed among the conversations', () => {
  it('excludes a deleted archived routine from rows and counts, and restores it on Undo', () => {
    const key = 'routine:local:ads'
    const view = { ...emptySessionSidebarView(), archived: [key], deleted: [key] }
    const removed = place([automation({ enabled: false })], { view, showArchived: true })
    expect(removed.groups).toEqual([])
    expect(removed.archivedCount).toBe(0)
    const restored = place([automation({ enabled: false })], {
      view: { ...view, deleted: [] },
      showArchived: true
    })
    expect(listing(restored)).toEqual([['archived', 'Archived (1)', ['Advertising']]])
    expect(restored.archivedCount).toBe(1)
  })

  it('lists a running routine with Active and a paused one with Stopped', () => {
    const result = place(
      [automation(), automation({ id: 'brief', name: 'Briefing', enabled: false })],
      { groups: [group({ key: 'workspace:other' })] }
    )
    expect(listing(result)).toEqual([
      ['workspace:other', 'Active', ['Advertising']],
      ['stopped', 'Stopped (1)', ['Briefing']]
    ])
  })

  it('adds an Active group when no conversation is active, ahead of the settled groups', () => {
    const result = place([automation()], {
      groups: [group({ key: 'completed', kind: 'completed', label: 'Done (2)' })]
    })
    expect(result.groups.map((entry) => entry.key)).toEqual(['workspace:other', 'completed'])
  })

  it('files a routine in the conversation folder it was moved to', () => {
    const metadata: SessionFolderMetadata = {
      version: 1,
      folders: [{ id: FOLDER, name: 'Routines' }],
      membership: { 'routine:local:ads': FOLDER }
    }
    const folderGroup = group({
      key: `folder:${FOLDER}`,
      kind: 'folder',
      label: 'Routines',
      folder: metadata.folders[0]
    })
    const result = place([automation()], {
      metadata,
      groups: [folderGroup, group({ key: 'workspace:other' })]
    })
    expect(listing(result)).toEqual([
      [`folder:${FOLDER}`, 'Routines', ['Advertising']],
      ['workspace:other', 'Active', []]
    ])
  })

  it('keeps hidden and archived routines out until they are asked for, and counts them', () => {
    const view = { ...emptySessionSidebarView(), hidden: ['routine:routine:local:ads'] }
    const archived = automation({ id: 'old', name: 'Old routine' })
    const quiet = place([automation(), archived], { view, archivedKeys: ['routine:local:old'] })
    expect(quiet.groups).toEqual([])
    expect([quiet.hiddenCount, quiet.archivedCount]).toEqual([1, 1])

    const shown = place([automation(), archived], {
      view,
      archivedKeys: ['routine:local:old'],
      showHidden: true,
      showArchived: true
    })
    expect(listing(shown)).toEqual([
      ['hidden-conversations', 'Hidden (1)', ['Advertising']],
      ['archived', 'Archived (1)', ['Old routine']]
    ])
  })

  it('leaves a routine out with the folder the person hid', () => {
    const metadata: SessionFolderMetadata = {
      version: 1,
      folders: [{ id: FOLDER, name: 'Routines' }],
      membership: { 'routine:local:ads': FOLDER }
    }
    const view = { ...emptySessionSidebarView(), hidden: [`folder:${FOLDER}`] }
    expect(place([automation()], { metadata, view }).groups).toEqual([])
  })

  it('finds a routine by its name while searching and skips the rest', () => {
    const result = place([automation(), automation({ id: 'brief', name: 'Briefing' })], {
      query: 'brief'
    })
    expect(listing(result)).toEqual([['workspace:other', 'Active', ['Briefing']]])
  })
})
