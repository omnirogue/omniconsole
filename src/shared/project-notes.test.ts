import { describe, expect, it } from 'vitest'
import { projectNotesDocument, withProjectNotes } from './project-notes'
import { sessionContextText, type SessionContextAttachment } from './session-context-attachments'

const plan: SessionContextAttachment = { id: 'slite:1', kind: 'slite', title: 'Plan', content: 'A' }
const notes: SessionContextAttachment = {
  id: 'slite:2',
  kind: 'slite',
  title: 'Notes',
  content: 'B'
}
const rules: SessionContextAttachment = { id: 'rules', kind: 'instructions', title: 'Rules' }

describe('project notes', () => {
  it('marks exactly one Slite document, and clears the mark with null', () => {
    const marked = withProjectNotes({ attachments: [plan, notes, rules] }, 'slite:2')
    expect(projectNotesDocument(marked)?.id).toBe('slite:2')
    const moved = withProjectNotes(marked, 'slite:1')
    expect(moved.attachments.filter((item) => item.notes).map((item) => item.id)).toEqual([
      'slite:1'
    ])
    expect(projectNotesDocument(withProjectNotes(moved, null))).toBeNull()
  })

  it('never marks anything but a Slite document, and keeps the first of several marks', () => {
    expect(projectNotesDocument(withProjectNotes({ attachments: [rules] }, 'rules'))).toBeNull()
    const twice = {
      attachments: [
        { ...plan, notes: true as const },
        { ...notes, notes: true as const }
      ]
    }
    expect(projectNotesDocument(twice)?.id).toBe('slite:1')
  })

  it('names the notes document in the context every thread reads', () => {
    expect(sessionContextText([{ ...notes, notes: true }])).toContain(
      'slite: Notes (the project’s notes)'
    )
    expect(sessionContextText([plan])).toContain('slite: Plan\n')
  })
})
