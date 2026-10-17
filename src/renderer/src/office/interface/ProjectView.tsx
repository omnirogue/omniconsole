// @ts-nocheck
import { Loader2, RefreshCcw, Wifi, WifiOff } from 'lucide-react'
import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { translate } from '@/i18n/i18n'

import { useCoreStore } from '../integration/store/coreStore'
import { useFleetStore } from '../integration/fleet/fleetStore'
import { useSceneManager } from '../simulation/SceneContext'
import { USER_COLOR } from '../theme/brand'
import ResetModal from './ResetModal'
import { ProviderCard } from './ProjectUsageCards'

export function formatTokens(num: number): string {
  if (num >= 1000000) {
    return translate('office.panels.projectView.millionTokens', '{{value}}M', {
      value: (num / 1000000).toFixed(1).replace(/\.0$/, '')
    })
  }
  if (num >= 1000) {
    return translate('office.panels.projectView.thousandTokens', '{{value}}k', {
      value: (num / 1000).toFixed(1).replace(/\.0$/, '')
    })
  }
  return num.toString()
}

const ProjectView: React.FC = () => {
  const { userBrief, phase, actionLog, resetProject } = useCoreStore()
  const { usage, connected, lastUpdated, lastError, usageStatus } = useFleetStore()
  const [isResetModalOpen, setIsResetModalOpen] = useState(false)
  const scene = useSceneManager()

  const hasLogs = actionLog.length > 0

  const handleResetConfirm = () => {
    scene?.resetScene()
    resetProject()
    setIsResetModalOpen(false)
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto scrollbar-sleek p-6 bg-white/50">
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xl font-black text-darkDelegation leading-tight">
            {translate('office.panels.projectView.projectInfo', 'Project Info')}
          </h2>
          <div className="flex items-center gap-2">
            <div
              className="px-2.5 py-1 rounded-xl text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5 transition-colors border border-transparent"
              style={{
                backgroundColor:
                  phase === 'working' ? USER_COLOR : phase === 'done' ? '#2fd27a' : '#1a2233',
                color: phase === 'idle' ? '#8b97ad' : 'white',
                borderColor: phase === 'idle' ? '#2b3a55' : 'transparent'
              }}
            >
              <div
                className={`w-1.5 h-1.5 rounded-full ${phase === 'working' ? 'bg-white animate-pulse' : 'bg-white opacity-40'}`}
              />
              {phase === 'idle'
                ? translate('office.panels.projectView.readyToStart', 'Ready to Start')
                : phase === 'working'
                  ? translate('office.panels.projectView.live', 'live')
                  : phase === 'done'
                    ? translate('office.panels.projectView.done', 'done')
                    : phase}
            </div>
          </div>
        </div>
      </div>

      <div className="h-px bg-zinc-100 w-full mb-6" />

      {hasLogs && (
        <div className="mb-8 w-full">
          <button
            onClick={() => setIsResetModalOpen(true)}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl transition-all active:scale-[0.98] group bg-zinc-100 hover:bg-zinc-200 text-zinc-400 hover:text-zinc-600"
          >
            <RefreshCcw
              size={14}
              strokeWidth={3}
              className="transition-transform group-hover:rotate-180 duration-500"
            />
            <span className="text-[10px] font-black uppercase tracking-widest">
              {translate('office.panels.projectView.clearActivity', 'Clear Activity')}
            </span>
          </button>
        </div>
      )}

      {/* Brief */}
      <div className="mb-10">
        <div className="flex items-center gap-2 mb-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
            {translate('office.panels.projectView.userBrief', 'User Brief')}
          </p>
          <div className="h-px flex-1 bg-zinc-100" />
        </div>
        {userBrief ? (
          <div className="markdown-content text-xs text-zinc-600 leading-relaxed font-medium bg-white/40 p-4 rounded-xl border border-zinc-100/50 max-h-[300px] overflow-y-auto scrollbar-sleek">
            <ReactMarkdown>{userBrief}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-xs text-zinc-400 italic">
            {translate('office.panels.projectView.connectingToFleet', 'Connecting to the fleet…')}
          </p>
        )}
      </div>

      {/* Provider Usage (real /api/usage) */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 flex-1">
            <p className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
              {translate('office.panels.projectView.providerUsage', 'Provider Usage')}
            </p>
            <div className="h-px flex-1 bg-zinc-100" />
          </div>
          <div
            className="flex items-center gap-1.5 ml-4"
            title={
              lastUpdated
                ? translate('office.panels.projectView.updatedAt', 'Updated {{time}}', {
                    time: new Date(lastUpdated).toLocaleTimeString()
                  })
                : translate('office.panels.projectView.noDataYet', 'No data yet')
            }
          >
            {connected ? (
              <Wifi size={12} className="text-emerald-500" />
            ) : (
              <WifiOff size={12} className="text-zinc-300" />
            )}
            <span
              className={`text-[9px] font-black uppercase tracking-widest ${connected ? 'text-emerald-600' : 'text-zinc-400'}`}
            >
              {connected
                ? translate('office.panels.projectView.live', 'live')
                : translate('office.panels.projectView.offline', 'offline')}
            </span>
          </div>
        </div>

        {usage.length > 0 ? (
          <div className="flex flex-col gap-3">
            {usage.map((a) => (
              <ProviderCard
                key={JSON.stringify([a.provider, a.account_key || a.root || a.email || a.source])}
                account={a}
              />
            ))}
          </div>
        ) : usageStatus === 'loading' ? (
          <p className="flex items-center gap-2 text-xs text-zinc-400 italic">
            <Loader2 size={12} className="animate-spin text-zinc-300" />
            {translate('office.panels.projectView.loadingProviderUsage', 'Loading provider usage…')}
          </p>
        ) : usageStatus === 'error' ? (
          <p className="text-xs text-zinc-400 italic">
            {translate(
              'office.panels.projectView.providerUsageUnavailable',
              'Hub slow / offline — provider usage unavailable.'
            )}
          </p>
        ) : (
          <p className="text-xs text-zinc-400 italic">
            {lastError ||
              translate(
                'office.panels.projectView.noProviderUsage',
                'No provider usage reported by the local agent.'
              )}
          </p>
        )}
      </div>

      <ResetModal
        isOpen={isResetModalOpen}
        onClose={() => setIsResetModalOpen(false)}
        onConfirm={handleResetConfirm}
      />
    </div>
  )
}

export default ProjectView
