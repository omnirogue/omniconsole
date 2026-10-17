import { translate } from '@/i18n/i18n'
import { ChevronDown, ChevronRight, Zap } from 'lucide-react'
import React, { useState } from 'react'
import { getAllAgents } from '../data/agents'
import { USER_COLOR, USER_COLOR_LIGHT } from '../theme/brand'
import type { DebugLogEntry } from '../integration/store/coreStore'
import { useActiveTeam } from '../integration/store/teamStore'
import { formatTokens } from './ProjectView'
import { formatTime } from './log-timestamp'
import { CopyButton } from './LogCopyButton'
import { RequestLogDetails } from './RequestLogDetails'
import { ResponseLogDetails } from './ResponseLogDetails'

export const DebugEntryView: React.FC<{ entry: DebugLogEntry }> = ({ entry }) => {
  const [isOpen, setIsOpen] = useState(false)
  const activeTeam = useActiveTeam()
  const agents = getAllAgents(activeTeam)
  const agent =
    entry.agentIndex === -1
      ? { name: translate('office.panels.debugEntryView.systemAgent', 'System'), color: '#71717a' }
      : agents.find((a) => a.index === entry.agentIndex)

  const totalTools =
    entry.phase === 'request'
      ? entry.systemTools?.reduce(
          (count, tool) =>
            count + ('functionDeclarations' in tool ? tool.functionDeclarations.length : 1),
          0
        ) || 0
      : 0

  const fullContent = `
AGENT: ${agent?.name} (${entry.phase})
TIME: ${formatTime(entry.timestamp)}
PHASE: ${entry.phase}

${
  entry.phase === 'request'
    ? `
SYSTEM INSTRUCTION:
${entry.systemInstruction || 'None'}

USER BRIEF / MESSAGES:
${JSON.stringify(entry.contents, null, 2)}
`
    : `
CONTENT:
${entry.content || 'None'}

RAW RESPONSE:
${JSON.stringify(entry.raw, null, 2)}
`
}
    `.trim()

  return (
    <div className="border-b border-zinc-50 last:border-0 py-3 group">
      <div className="flex items-center gap-1 mb-1 pr-1">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex-1 flex items-center justify-between text-left hover:bg-zinc-50/50 rounded p-1 transition-colors cursor-pointer"
        >
          <div className="flex flex-col gap-1.5 w-full">
            <div className="flex items-center justify-between w-full overflow-hidden">
              <div className="flex flex-col gap-1 overflow-hidden">
                <div className="flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: agent?.color ?? '#ccc' }}
                  />
                  <span className="text-[10px] font-black text-darkDelegation uppercase tracking-widest leading-none truncate">
                    {agent?.name}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 ml-4">
                  <span
                    className="text-[8px] font-bold px-1.5 py-0.5 rounded uppercase tracking-tighter whitespace-nowrap"
                    style={
                      entry.phase === 'request'
                        ? {
                            backgroundColor: USER_COLOR_LIGHT,
                            color: USER_COLOR
                          }
                        : {
                            backgroundColor: '#ecfdf5', // bg-emerald-50
                            color: '#059669' // text-emerald-600
                          }
                    }
                  >
                    {entry.phase}
                  </span>
                  {entry.phase === 'response' && entry.usage && (
                    <span className="text-[8px] font-mono font-bold text-zinc-400 bg-zinc-50 border border-zinc-100 px-1 py-0.5 rounded leading-none whitespace-nowrap">
                      {translate('office.panels.debugEntryView.tokenCount', 'T: {{tokens}}', {
                        tokens: formatTokens(entry.usage.totalTokens)
                      })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 self-start mt-0.5">
                <span className="text-[8px] font-mono text-zinc-400">
                  {formatTime(entry.timestamp)}
                </span>
                {isOpen ? (
                  <ChevronDown size={12} className="text-zinc-300" />
                ) : (
                  <ChevronRight size={12} className="text-zinc-300" />
                )}
              </div>
            </div>

            {/* Summary of tool calls in preview */}
            {entry.phase === 'response' &&
              entry.tool_calls &&
              entry.tool_calls.length > 0 &&
              !isOpen && (
                <div className="flex flex-wrap gap-1 pl-4">
                  {entry.tool_calls.map((tc, i) => (
                    <span
                      key={i}
                      className="flex items-center gap-1 text-[8px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded shadow-sm"
                    >
                      <Zap size={8} />
                      {tc.function?.name ||
                        translate('office.panels.debugEntryView.unknownTool', '(unknown)')}
                    </span>
                  ))}
                </div>
              )}
          </div>
        </button>
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
          <CopyButton text={fullContent} />
        </div>
      </div>

      {isOpen && (
        <div className="mt-2 space-y-2 pl-4 border-l border-zinc-100">
          {entry.phase === 'request' ? (
            <RequestLogDetails entry={entry} totalTools={totalTools} />
          ) : (
            <ResponseLogDetails entry={entry} />
          )}
        </div>
      )}
    </div>
  )
}
