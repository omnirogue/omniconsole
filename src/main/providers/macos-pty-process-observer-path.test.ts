import { describe, expect, it } from 'vitest'
import { macosPtyProcessObserverCandidates } from './macos-pty-process-observer-path'

describe('macOS PTY process observer candidates', () => {
  it('finds the packaged helper from the main app executable', () => {
    expect(
      macosPtyProcessObserverCandidates('/Applications/OmniConsole.app/Contents/MacOS/OmniConsole')
    ).toEqual(['/Applications/OmniConsole.app/Contents/MacOS/omni-pty-process-observer'])
  })

  it('finds the packaged helper from the Electron helper the PTY daemon runs as', () => {
    expect(
      macosPtyProcessObserverCandidates(
        '/Applications/OmniConsole.app/Contents/Frameworks/OmniConsole Helper.app/Contents/MacOS/OmniConsole Helper'
      )
    ).toEqual([
      '/Applications/OmniConsole.app/Contents/Frameworks/OmniConsole Helper.app/Contents/MacOS/omni-pty-process-observer',
      '/Applications/OmniConsole.app/Contents/MacOS/omni-pty-process-observer'
    ])
  })

  it('adds nothing for an executable outside an app bundle', () => {
    expect(macosPtyProcessObserverCandidates('/usr/local/bin/node')).toEqual([
      '/usr/local/bin/omni-pty-process-observer'
    ])
  })
})
