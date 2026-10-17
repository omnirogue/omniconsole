import { describe, expect, it } from 'vitest'
import {
  describeSessionPrompt,
  freeEntryOption,
  persistentApproval,
  type SessionPromptOption
} from './session-prompt'

const options: SessionPromptOption[] = [
  { n: 1, label: 'Allow', value: 'allow', role: 'allow-once' },
  { n: 2, label: 'Deny', value: 'deny', role: 'deny' }
]

function fingerprint(
  change: {
    kind?: 'permission' | 'question'
    text?: string
    options?: SessionPromptOption[]
    readable?: boolean
    commandText?: string[]
  } = {}
): string {
  return describeSessionPrompt(
    change.kind ?? 'permission',
    change.text ?? 'Bash\npwd',
    change.options ?? options,
    change.readable ?? true,
    change.commandText ?? ['pwd']
  ).fingerprint
}

describe('prompt fingerprint', () => {
  it('is stable for the same prompt', () => {
    expect(fingerprint()).toBe(fingerprint())
    expect(fingerprint()).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    ['the kind', { kind: 'question' as const }],
    ['the text', { text: 'Bash\nls' }],
    ['readability', { readable: false }],
    ['the command body', { commandText: ['git push --force origin main'] }],
    [
      'an option id (value) behind the same label',
      { options: [{ ...options[0]!, value: 'allowForSession' }, options[1]!] }
    ],
    ['an option role', { options: [{ ...options[0]!, role: undefined }, options[1]!] }],
    ['a label', { options: [{ ...options[0]!, label: 'Allow once' }, options[1]!] }],
    ['an option number', { options: [{ ...options[0]!, n: 3 }, options[1]!] }],
    [
      'swapped terminal keys',
      {
        options: [
          { n: 1, label: 'Prod', value: '2' },
          { n: 2, label: 'Dev', value: '1' }
        ]
      }
    ]
  ])('changes with %s', (_name, change) => {
    expect(fingerprint(change)).not.toBe(fingerprint())
  })

  it('swapped question keys under the same labels are a different prompt', () => {
    const listed = [
      { n: 1, label: 'Prod', value: '1' },
      { n: 2, label: 'Dev', value: '2' }
    ]
    const swapped = [
      { n: 1, label: 'Prod', value: '2' },
      { n: 2, label: 'Dev', value: '1' }
    ]
    expect(describeSessionPrompt('question', 'Pick env?', swapped, true).fingerprint).not.toBe(
      describeSessionPrompt('question', 'Pick env?', listed, true).fingerprint
    )
  })
})

describe('persistent or scoped approvals', () => {
  it.each([
    "Yes, and don't ask again",
    'Yes, and don’t ask again for git status commands',
    'Always allow',
    'Allow always',
    'Yes, allow for this directory',
    'Allow for this project',
    'Allow for this workspace',
    'Allow for this session',
    'Approve for the session',
    'yes for this directory',
    'Yes, allow reading from src/ during this session',
    'Yes, allow all edits during this session',
    'Yes, permanently',
    'Remember this decision',
    'from now on',
    'Allow project-wide',
    'Yes to all',
    'Allow for all files',
    'Auto-approve edits',
    'Allow all',
    'allowAll',
    'allow-all',
    'allow_all',
    'allowForSession',
    'acceptForSession'
  ])('refuses %s', (text) => {
    expect(persistentApproval(text)).toBe(true)
  })

  it.each([
    'Yes',
    'Allow',
    'Allow once',
    'Yes, allow once',
    'Yes, proceed (y)',
    'No',
    'Deny',
    'No, and tell Claude what to do differently',
    'Allow allow',
    'allow Allow',
    'Allow accept',
    'Existing parser',
    'Use the existing parser',
    'Run the tests in the backend folder'
  ])('does not flag the one-time or ordinary %s', (text) => {
    expect(persistentApproval(text)).toBe(false)
  })
})

describe('free-entry options', () => {
  it.each([
    'Other',
    'Other (specify)',
    'Type something.',
    'Something else',
    'None of the above',
    'Chat about this',
    'Other\nDescribe it yourself'
  ])('recognizes %s', (label) => {
    expect(freeEntryOption(label)).toBe(true)
  })

  it.each(['Other parser', 'Otherwise continue', 'Existing parser', 'No'])(
    'leaves %s alone',
    (label) => {
      expect(freeEntryOption(label)).toBe(false)
    }
  )
})
