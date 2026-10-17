import type { AgentNode } from '../data/agents'
import type { DebugLogEntry } from '../integration/store/coreStore'

export function downloadTechnicalLogs(debugLog: DebugLogEntry[], agents: AgentNode[]): void {
  const content = debugLog
    .map((entry) => {
      const agent =
        entry.agentIndex === -1
          ? { name: 'System' }
          : agents.find((a) => a.index === entry.agentIndex)
      return `
=========================================
AGENT: ${agent?.name} (${entry.phase})
TIME: ${new Date(entry.timestamp).toLocaleString()}
PHASE: ${entry.phase}
=========================================

${
  entry.phase === 'request'
    ? `
SYSTEM INSTRUCTION:
${entry.systemInstruction || 'None'}

USER BRIEF / MESSAGES:
${JSON.stringify(entry.contents, null, 2)}

SYSTEM TOOLS:
${JSON.stringify(entry.systemTools, null, 2)}
`
    : `
CONTENT:
${entry.content || 'None'}

TOOL CALLS:
${JSON.stringify(entry.tool_calls || [], null, 2)}

RAW RESPONSE:
${JSON.stringify(entry.raw, null, 2)}
`
}
`.trim()
    })
    .join('\n\n\n')

  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `the-delegation-technical-logs-${Date.now()}.txt`
  a.click()
  URL.revokeObjectURL(url)
}
