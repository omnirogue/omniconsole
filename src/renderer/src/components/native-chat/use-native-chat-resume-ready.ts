import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { detectAgentStartupIntervention } from '../../../../shared/agent-startup-intervention'
import { stripAnsiEscapeSequences } from '../../../../shared/ansi-escape-sequences'
import { readCodexSessionOptionsFromTerminalScreen } from './codex-terminal-session-options'
import { readClaudeSessionOptionsFromTerminalScreen } from './claude-terminal-session-options'

export function resumedAgentInputReady(agent: string, screen: string | null): boolean {
  if (!screen || detectAgentStartupIntervention(agent, screen)) {
    return false
  }
  if (agent === 'codex') {
    const text = stripAnsiEscapeSequences(screen)
    // Codex can report `default` without a concrete effort. Its input/footer is
    // still ready; do not turn that readiness signal into an applied effort.
    const defaultInput =
      /(?:^|\n)[ \t]*›[^\n]*\n(?:[ \t]*\n)*[ \t]*[\w.-]+\s+default\s+·\s+(?:~|\/|[A-Za-z]:[\\/])/.test(
        text.replace(/\r/g, '')
      )
    const reported = readCodexSessionOptionsFromTerminalScreen(text)
    return defaultInput || (typeof reported?.effort === 'string' && /(?:^|\n)\s*›/.test(text))
  }
  if (agent === 'claude') {
    return (
      Boolean(readClaudeSessionOptionsFromTerminalScreen(screen)) &&
      /─{3,}[^\n]*\n\s*❯[^\n]*(?:\n(?!\s*─{3,})[^\n]*)*\n\s*─{3,}/.test(screen)
    )
  }
  return true
}

/** Resume hooks can precede the input widget; keep the composer off that startup window. */
export function useNativeChatResumeReady(args: {
  resuming: boolean
  active: boolean
  paneKey: string
  ptyId: string | null
  agent: string
  readScreen?: () => string | null
}): boolean {
  const { resuming, active, paneKey, ptyId, agent, readScreen } = args
  const resumePane = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (resuming) {
      resumePane.current = paneKey
    }
  }, [resuming, paneKey])
  const required = resuming || resumePane.current === paneKey
  const generation = `${paneKey}:${ptyId ?? ''}`
  const [readyGeneration, setReadyGeneration] = useState<string | null>(null)
  const ready = !required || readyGeneration === generation
  useEffect(() => {
    if (ready || !active || !ptyId || !readScreen) {
      return
    }
    const check = () => {
      if (resumedAgentInputReady(agent, readScreen?.() ?? null)) {
        setReadyGeneration(generation)
      }
    }
    const timer = setInterval(check, 250)
    check()
    return () => clearInterval(timer)
  }, [ready, active, ptyId, agent, readScreen, generation])
  return ready
}
