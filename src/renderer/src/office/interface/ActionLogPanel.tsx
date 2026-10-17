import { translate } from '@/i18n/i18n'
import { Download, Filter } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { getAllAgents } from '../data/agents'
import { useCoreStore } from '../integration/store/coreStore'
import { useActiveTeam } from '../integration/store/teamStore'
import { DebugEntryView } from './DebugEntryView'
import { downloadTechnicalLogs } from './download-technical-logs'
import { formatTime } from './log-timestamp'

export function ActionLogPanel() {
  const { setLogOpen, actionLog, debugLog, logFilterAgentIndex } = useCoreStore()
  const activeTeam = useActiveTeam()
  const agents = getAllAgents(activeTeam)
  const [activeTab, setActiveTab] = useState<'activity' | 'technical'>('activity')
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false)
  const topRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to top when a new log entry arrives (since order is reversed)
  useEffect(() => {
    const timer = setTimeout(() => topRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    return () => clearTimeout(timer)
  }, [actionLog, debugLog, activeTab])

  const filterAgent =
    logFilterAgentIndex !== null
      ? (agents.find((a) => a.index === logFilterAgentIndex) ?? null)
      : null

  const entries =
    logFilterAgentIndex !== null
      ? actionLog.filter((e) => e.agentIndex === logFilterAgentIndex).toReversed()
      : actionLog.toReversed()

  const debugEntries =
    logFilterAgentIndex !== null
      ? debugLog.filter((e) => e.agentIndex === logFilterAgentIndex).toReversed()
      : debugLog.toReversed()

  return (
    <div className="w-[320px] h-full bg-white border-r border-zinc-100 flex flex-col pointer-events-auto overflow-hidden shrink-0 relative">
      {/* Header */}
      <div className="h-10 px-5 border-b border-zinc-100 flex items-center justify-between bg-white shrink-0 z-10">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
            {translate('office.panels.actionLogPanel.title', 'Logs')}
          </span>
          {filterAgent && (
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-bold text-white uppercase tracking-tighter animate-in fade-in zoom-in duration-200"
              style={{ backgroundColor: filterAgent.color }}
            >
              {filterAgent.name}
              <button
                onClick={() => setLogOpen(true, null)}
                className="hover:scale-110 transition-transform cursor-pointer"
              >
                ×
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setIsFilterMenuOpen(!isFilterMenuOpen)}
              className={`p-1.5 rounded transition-colors cursor-pointer ${
                isFilterMenuOpen || logFilterAgentIndex !== null
                  ? 'bg-darkDelegation text-white'
                  : 'text-zinc-400 hover:text-darkDelegation hover:bg-zinc-50'
              }`}
              title={translate('office.panels.actionLogPanel.filterByAgent', 'Filter by agent')}
            >
              <Filter size={14} />
            </button>

            {isFilterMenuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setIsFilterMenuOpen(false)} />
                <div className="absolute right-0 mt-2 w-48 bg-white border border-zinc-100 rounded-xl shadow-xl z-30 py-1.5 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                  <button
                    onClick={() => {
                      setLogOpen(true, null)
                      setIsFilterMenuOpen(false)
                    }}
                    className={`w-full px-4 py-2 text-left text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 hover:bg-zinc-50 transition-colors ${
                      logFilterAgentIndex === null ? 'text-darkDelegation' : 'text-zinc-400'
                    }`}
                  >
                    <div
                      className={`w-2 h-2 rounded-full ${logFilterAgentIndex === null ? 'bg-darkDelegation' : 'bg-transparent border border-zinc-200'}`}
                    />
                    {translate('office.panels.actionLogPanel.allAgents', 'All Agents')}
                  </button>
                  <div className="h-px bg-zinc-50 my-1" />
                  {agents.map((agent) => (
                    <button
                      key={agent.index}
                      onClick={() => {
                        setLogOpen(true, agent.index)
                        setIsFilterMenuOpen(false)
                      }}
                      className={`w-full px-4 py-2 text-left text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 hover:bg-zinc-50 transition-colors ${
                        logFilterAgentIndex === agent.index
                          ? 'text-darkDelegation'
                          : 'text-zinc-400'
                      }`}
                    >
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: agent.color }}
                      />
                      {agent.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {activeTab === 'technical' && debugEntries.length > 0 && (
            <button
              onClick={() => downloadTechnicalLogs(debugLog, agents)}
              className="text-zinc-400 hover:text-darkDelegation transition-colors p-1 rounded hover:bg-zinc-50 cursor-pointer"
              title={translate('office.panels.actionLogPanel.downloadAll', 'Download all as .txt')}
            >
              <Download size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Tab Switcher */}
      <div className="flex border-b border-zinc-100 bg-zinc-50/30">
        <button
          onClick={() => setActiveTab('activity')}
          className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer ${
            activeTab === 'activity'
              ? 'bg-white border-b-2 border-darkDelegation text-darkDelegation'
              : 'text-zinc-400 hover:text-zinc-600'
          }`}
        >
          {translate('office.panels.actionLogPanel.activity', 'Activity')}
        </button>
        <button
          onClick={() => setActiveTab('technical')}
          className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer ${
            activeTab === 'technical'
              ? 'bg-white border-b-2 border-darkDelegation text-darkDelegation'
              : 'text-zinc-400 hover:text-zinc-600'
          }`}
        >
          {translate('office.panels.actionLogPanel.technical', 'Technical')}
        </button>
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-y-auto scrollbar-sleek p-5 space-y-4 shadow-[inset_0_-20px_20px_-20px_rgba(0,0,0,0.05)]">
        <div ref={topRef} />

        {activeTab === 'activity' ? (
          entries.length === 0 ? (
            <p className="text-zinc-300 text-[10px] font-bold uppercase tracking-widest text-center py-16">
              {translate('office.panels.actionLogPanel.awaitingActions', 'Awaiting actions...')}
            </p>
          ) : (
            entries.map((entry) => {
              const agent = agents.find((a) => a.index === entry.agentIndex)
              return (
                <div key={entry.id} className="flex flex-col gap-1.5 group">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-1.5 h-1.5 rounded-full shadow-sm"
                        style={{ backgroundColor: agent?.color ?? '#e4e4e7' }}
                      />
                      <span className="text-[10px] font-black text-darkDelegation uppercase tracking-widest leading-none">
                        {agent?.name ??
                          translate('office.panels.actionLogPanel.systemAgent', 'System')}
                      </span>
                    </div>
                    <span className="text-[9px] font-medium text-zinc-400 font-mono">
                      {formatTime(entry.timestamp)}
                    </span>
                  </div>

                  <div className="pl-3.5 border-l border-zinc-50 group-hover:border-zinc-200 transition-colors">
                    <p className="text-xs text-zinc-600 leading-relaxed font-medium">
                      {entry.action}
                    </p>
                  </div>
                </div>
              )
            })
          )
        ) : debugEntries.length === 0 ? (
          <p className="text-zinc-300 text-[10px] font-bold uppercase tracking-widest text-center py-16">
            {translate('office.panels.actionLogPanel.noTechnicalData', 'No technical data...')}
          </p>
        ) : (
          debugEntries.map((entry) => <DebugEntryView key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  )
}
