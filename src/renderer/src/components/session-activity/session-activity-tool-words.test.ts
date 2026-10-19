import { describe, expect, it } from 'vitest'
import { plainToolActivity, shellCommandWords } from './session-activity-tool-words'

describe('shellCommandWords', () => {
  it.each([
    [
      "gh run view 35733438800 --repo omnirogue/omnirogue --log-failed | python3 -c 'import sys'",
      'gh run view'
    ],
    ['cd ~/repo && git push -u origin feat/x', 'git push'],
    ['FOO=1 BAR=2 pnpm test src/a.test.ts', 'pnpm test'],
    ['sudo /usr/bin/npm run build', 'npm run build'],
    ['export X=1; ls -la', 'ls'],
    ['python3 -c "print(1)"', 'python3']
  ])('%s → %s', (command, words) => {
    expect(shellCommandWords(command)).toBe(words)
  })

  it('finds nothing in a line that only sets things up', () => {
    expect(shellCommandWords('cd /tmp')).toBeNull()
    expect(shellCommandWords('   ')).toBeNull()
  })
})

describe('plainToolActivity', () => {
  it('names the command a shell tool runs, never the whole pipeline', () => {
    expect(
      plainToolActivity(
        'Bash',
        'gh run view 35733438800 --repo omnirogue/omnirogue --log-failed | python3 -c'
      )
    ).toBe('Running gh run view')
    expect(plainToolActivity('exec_command', 'git status --short')).toBe('Running git status')
  })

  it('names the file a read or edit touches', () => {
    expect(plainToolActivity('Read', 'src/main/index.ts')).toBe('Reading index.ts')
    expect(plainToolActivity('Edit', 'src/renderer/src/App.tsx')).toBe('Editing App.tsx')
    expect(plainToolActivity('Write', '/Users/maintainer/Desktop/plan.html')).toBe('Writing plan.html')
    expect(plainToolActivity('apply_patch', '*** Begin Patch\n*** Update File: a.ts')).toBe(
      'Editing files'
    )
  })

  it('describes search, web, helper, to-do and MCP tools', () => {
    expect(plainToolActivity('Grep', 'outcomeSentence')).toBe('Searching the code')
    expect(plainToolActivity('WebFetch', 'https://docs.github.com/en/rest')).toBe(
      'Reading docs.github.com'
    )
    expect(plainToolActivity('WebSearch', 'vite 7 release')).toBe('Searching the web')
    expect(plainToolActivity('Task', 'Audit the links')).toBe('Working with a helper agent')
    expect(plainToolActivity('TodoWrite', '')).toBe('Updating its to-do list')
    expect(plainToolActivity('mcp__apexlabs__list_ad_objects', '{}')).toBe('Using apexlabs')
  })

  it('leaves unknown tools and empty shell input to the literal line', () => {
    expect(plainToolActivity('CustomThing', 'x')).toBeNull()
    expect(plainToolActivity('Bash', '')).toBeNull()
  })
})
