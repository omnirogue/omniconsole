import { translate } from '@/i18n/i18n'
import { ChevronRight, MessageSquare, Terminal, Zap } from 'lucide-react'
import React from 'react'
import type { RequestDebugLogEntry } from '../integration/store/coreStore'
import { CopyButton } from './LogCopyButton'

export function RequestLogDetails({
  entry,
  totalTools
}: {
  entry: RequestDebugLogEntry
  totalTools: number
}) {
  return (
    <>
      {/* System Instruction — collapsed by default */}
      {entry.systemInstruction && (
        <details className="group/sp">
          <summary className="flex items-center justify-between gap-1.5 py-1 cursor-pointer list-none">
            <div className="flex items-center gap-1.5 opacity-50 hover:opacity-100 transition-opacity">
              <ChevronRight
                size={10}
                className="text-zinc-400 group-open/sp:rotate-90 transition-transform"
              />
              <Terminal size={10} />
              <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">
                {translate(
                  'office.panels.requestLogDetails.systemInstruction',
                  'System Instruction'
                )}
              </span>
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <CopyButton text={entry.systemInstruction} />
            </div>
          </summary>
          <pre className="mt-1.5 text-[10px] bg-zinc-50 p-2 rounded leading-relaxed text-zinc-600 whitespace-pre-wrap font-mono border border-zinc-100/50">
            {entry.systemInstruction}
          </pre>
        </details>
      )}

      {/* Tools — collapsed by default */}
      <details className={`group/tools ${totalTools === 0 ? 'pointer-events-none' : ''}`}>
        <summary className="flex items-center justify-between gap-1.5 py-1 cursor-pointer list-none">
          <div
            className={`flex items-center gap-1.5 ${totalTools === 0 ? 'opacity-20' : 'opacity-50 hover:opacity-100 transition-opacity'}`}
          >
            <ChevronRight
              size={10}
              className={`text-zinc-400 group-open/tools:rotate-90 transition-transform ${totalTools === 0 ? 'invisible' : ''}`}
            />
            <Zap size={10} />
            <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">
              {translate(
                'office.panels.requestLogDetails.systemToolsCount',
                'System Tools ({{count}})',
                { count: totalTools }
              )}
            </span>
          </div>
          {totalTools > 0 && (
            <div onClick={(e) => e.stopPropagation()}>
              <CopyButton text={JSON.stringify(entry.systemTools, null, 2)} />
            </div>
          )}
        </summary>
        {totalTools > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1 bg-emerald-50/20 p-2 rounded border border-emerald-100/20">
            {(entry.systemTools ?? []).map((toolGroup, i) => (
              <React.Fragment key={i}>
                {('functionDeclarations' in toolGroup
                  ? toolGroup.functionDeclarations
                  : [toolGroup.function]
                ).map((fd, j) => (
                  <span
                    key={j}
                    className="text-[9px] font-mono font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100/50 shadow-xs"
                  >
                    {fd.name}
                  </span>
                ))}
              </React.Fragment>
            ))}
          </div>
        )}
      </details>

      {/* Contents Array — collapsed by default */}
      {entry.contents && entry.contents.length > 0 && (
        <details className="group/msgs" open>
          <summary className="flex items-center justify-between gap-1.5 py-1 cursor-pointer list-none">
            <div className="flex items-center gap-1.5 opacity-50 hover:opacity-100 transition-opacity">
              <ChevronRight
                size={10}
                className="text-zinc-400 group-open/msgs:rotate-90 transition-transform"
              />
              <MessageSquare size={10} />
              <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">
                {translate(
                  'office.panels.requestLogDetails.messageCount',
                  'Contents / Messages ({{count}})',
                  { count: entry.contents.length }
                )}
              </span>
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <CopyButton text={JSON.stringify(entry.contents, null, 2)} />
            </div>
          </summary>
          <div className="mt-2 space-y-2 max-h-80 overflow-y-auto pr-1 scrollbar-sleek border-l-2 border-zinc-50 pl-2">
            {entry.contents.map((m, i) => (
              <div
                key={i}
                className={`p-2 rounded border group/msg transition-all ${
                  m.role === 'user'
                    ? 'bg-white border-zinc-100'
                    : 'bg-emerald-50/20 border-emerald-100/30'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={`text-[8px] font-black uppercase tracking-widest ${
                      m.role === 'user' ? 'text-zinc-400' : 'text-emerald-600'
                    }`}
                  >
                    {m.role}
                  </span>
                  <div className="opacity-0 group-hover/msg:opacity-100 transition-opacity">
                    <CopyButton text={JSON.stringify(m, null, 2)} />
                  </div>
                </div>
                <div className="mt-1.5 space-y-2">
                  {/* Standard content (string) support */}
                  {m.content && (
                    <div className="text-[10px] text-zinc-700 leading-relaxed font-sans whitespace-pre-wrap py-1">
                      {m.content}
                    </div>
                  )}

                  {/* Standard tool_calls support */}
                  {m.tool_calls && m.tool_calls.length > 0 && (
                    <div className="space-y-2 mt-2">
                      {m.tool_calls.map((tc, idx) => (
                        <div
                          key={idx}
                          className="bg-darkDelegation rounded-lg overflow-hidden border border-darkDelegation shadow-lg"
                        >
                          <div className="bg-darkDelegation px-2.5 py-1.5 flex items-center justify-between">
                            <span className="text-[9px] font-black text-emerald-400 font-mono tracking-wider">
                              {tc.function?.name}
                            </span>
                            <span className="text-[8px] font-bold text-zinc-500 uppercase tracking-tighter">
                              {translate('office.panels.requestLogDetails.call', 'Call')}
                            </span>
                          </div>
                          <div className="p-2.5 bg-darkDelegation/50">
                            <pre className="text-[9px] text-zinc-300 font-mono wrap-break-word whitespace-pre-wrap">
                              {tc.function?.arguments}
                            </pre>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  )
}
