import { describe, expect, it } from 'vitest'
import { describeTaskPlace, inferTaskFromSession } from './task-inference'

const HOME = '/Users/maintainer'
const companies = [
  {
    id: 'co_rogue',
    slug: 'omnirogue',
    name: 'OmniRogue',
    status: null,
    count: 2,
    domains: [
      {
        id: 'org_dev',
        name: 'Development',
        count: 2,
        parent_unit_id: null,
        projects: [{ id: 'proj_bots', name: 'OmniConsole', kind: 'project', status: 'active' }]
      }
    ]
  }
]

describe('inferring a task from a conversation', () => {
  it('takes the note over the conversation name, and files by the folder', () => {
    const inferred = inferTaskFromSession({
      conversationTitle: 'Claude conversation',
      note: '  \nSimplify OmniConsole handoffs\nmore detail',
      path: `${HOME}/Work/OmniRogue/Development/OmniConsole/app`,
      companies,
      home: HOME
    })
    expect(inferred.title).toBe('Simplify OmniConsole handoffs')
    expect(describeTaskPlace(inferred.place)).toBe('OmniRogue › Development › OmniConsole')
    expect(inferred.place?.project?.id).toBe('proj_bots')
  })

  it('falls back to the conversation name and files as deep as the folder reaches', () => {
    const inferred = inferTaskFromSession({
      conversationTitle: 'Finish Windows verification',
      path: `${HOME}/Work/OmniRogue/Development`,
      companies,
      home: HOME
    })
    expect(inferred.title).toBe('Finish Windows verification')
    expect(describeTaskPlace(inferred.place)).toBe('OmniRogue › Development')
  })

  it('knows when it cannot place the work, and says nothing rather than guessing', () => {
    const inferred = inferTaskFromSession({
      conversationTitle: 'Scratch',
      path: `${HOME}/Desktop/scratch`,
      companies,
      home: HOME
    })
    expect(inferred.place).toBeNull()
    expect(describeTaskPlace(inferred.place)).toBeNull()
  })
})
