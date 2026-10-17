import { translate } from '@/i18n/i18n'
import { ChevronRight, Download, MessageSquare, Zap } from 'lucide-react'
import type { ResponseDebugLogEntry } from '../integration/store/coreStore'
import { CopyButton } from './LogCopyButton'
import { parseLogToolArguments } from './log-tool-arguments'

export function ResponseLogDetails({ entry }: { entry: ResponseDebugLogEntry }) {
  return (
    <>
      <div className="pt-2">
        <div className="flex items-center justify-between gap-1.5 mb-1.5 opacity-50">
          <div className="flex items-center gap-1.5">
            <MessageSquare size={10} />
            <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">
              {translate('office.panels.responseLogDetails.title', 'Response Details')}
            </span>
          </div>
          <CopyButton text={entry.content || ''} />
        </div>
        <div className="space-y-3">
          {/* Formatted Text Content */}
          {entry.content && (
            <div className="text-[11px] bg-white p-3 rounded leading-relaxed text-zinc-700 border border-zinc-100 shadow-sm relative italic whitespace-pre-wrap">
              <div className="absolute -top-2 left-2 bg-white px-1 text-[8px] font-black uppercase text-zinc-400 border border-zinc-100 rounded">
                {translate('office.panels.responseLogDetails.text', 'Text')}
              </div>
              {entry.content}
            </div>
          )}

          {/* Formatted Tool Calls */}
          {entry.tool_calls && entry.tool_calls.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 ml-1">
                <Zap size={10} className="text-emerald-500" />
                <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600">
                  {translate('office.panels.responseLogDetails.toolCalls', 'Tool calls')}
                </span>
              </div>
              {entry.tool_calls.map((tc, i) => {
                const name =
                  tc.function?.name ||
                  translate('office.panels.responseLogDetails.unknownTool', '(unknown)')
                const args = parseLogToolArguments(tc)
                return (
                  <div
                    key={i}
                    className="bg-darkDelegation rounded-lg overflow-hidden border border-darkDelegation shadow-lg"
                  >
                    <div className="bg-darkDelegation px-2.5 py-1.5 flex items-center justify-between">
                      <span className="text-[10px] font-black text-emerald-400 font-mono tracking-wider">
                        {name}
                      </span>
                      <span className="text-[8px] font-bold text-zinc-500 uppercase tracking-tighter">
                        {translate('office.panels.responseLogDetails.arguments', 'Arguments')}
                      </span>
                    </div>
                    <div className="p-2.5 bg-darkDelegation/50">
                      {args && Object.keys(args).length > 0 ? (
                        <div className="space-y-1.5">
                          {Object.entries(args).map(([key, value]) => (
                            <div key={key} className="flex flex-col gap-0.5">
                              <span className="text-[8px] font-bold text-zinc-500 uppercase tracking-tighter">
                                {key}
                              </span>
                              <div className="text-[9px] text-zinc-300 font-mono bg-darkDelegation/50 p-1.5 rounded border border-zinc-700/50 wrap-break-word whitespace-pre-wrap">
                                {typeof value === 'object'
                                  ? JSON.stringify(value, null, 2)
                                  : String(value)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-[9px] text-zinc-500 italic">
                          {translate(
                            'office.panels.responseLogDetails.noArguments',
                            'No arguments'
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Raw LLM Response — collapsed by default */}
      {entry.raw && (
        <details className="group/raw">
          <summary className="flex items-center justify-between gap-1.5 py-1 cursor-pointer list-none">
            <div className="flex items-center gap-1.5 opacity-50 hover:opacity-100 transition-opacity">
              <ChevronRight
                size={10}
                className="text-zinc-400 group-open/raw:rotate-90 transition-transform"
              />
              <Download size={10} />
              <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">
                {translate('office.panels.responseLogDetails.rawResponse', 'Raw LLM Response')}
              </span>
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <CopyButton text={JSON.stringify(entry.raw, null, 2)} />
            </div>
          </summary>
          <pre className="mt-1.5 text-[9px] bg-darkDelegation text-zinc-400 p-2 rounded leading-relaxed whitespace-pre overflow-x-auto font-mono border border-darkDelegation">
            {JSON.stringify(entry.raw, null, 2)}
          </pre>
        </details>
      )}
    </>
  )
}
