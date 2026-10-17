// @ts-nocheck
/*
 * Jobs Kanban — the Office board now shows real WORK (titled jobs + stages +
 * click-to-prioritise), not raw CLI processes. Data source is GET /api/jobs
 * (the FleetBridge polls it into the jobsStore every ~5s); the 3D characters +
 * activity log stay driven by sessions. A card shows the TITLE prominently, a
 * one-line detail/owner, the bound agent chips, and a faint source tag (derived
 * jobs — synthesised from a running session — are dimmed and read-only). Clicking
 * a card opens a detail panel with a Prioritise (bump-to-top) + stage-move
 * control. Styled with the same light utility classes the vendored office uses,
 * so office.css remaps them to the dark palette automatically.
 */
import { ChevronRight } from 'lucide-react'
import React, { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useJobsStore } from '../integration/fleet/jobsStore'
import type { Job } from '../integration/fleet/jobsTypes'
import { COLUMNS, columnOf, isDerived, shortMachine } from './jobs-kanban-display'
import { JobsKanbanDetailModal } from './JobsKanbanDetailModal'

type JobsKanbanPanelProps = {
  height?: number
}

function AgentChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[9px] font-semibold text-zinc-500 bg-zinc-100 rounded-full px-1.5 py-0.5 whitespace-nowrap">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: '#4c8dff' }} />
      {label}
    </span>
  )
}

function JobCard({ job, onOpen }: { job: Job; onOpen: (id: string) => void }) {
  const derived = isDerived(job)
  const sessions = job.sessions ?? []
  const oneLine = (job.owner && `@${job.owner}`) || (job.detail || '').split('\n')[0] || ''
  return (
    <button
      type="button"
      onClick={() => onOpen(job.job_id)}
      className={`text-left w-full bg-white rounded-lg border border-black/5 shadow-sm p-3 space-y-2 group relative hover:bg-white transition-colors ${
        derived ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-1">
        <h3 className="text-xs text-darkDelegation leading-snug font-bold flex-1 break-words">
          {job.title || translate('office.panels.jobsKanbanPanel.untitledJob', 'Untitled job')}
        </h3>
        <ChevronRight size={14} className="text-zinc-300 group-hover:text-zinc-500 shrink-0" />
      </div>

      {oneLine && <p className="text-[11px] text-zinc-500 leading-relaxed truncate">{oneLine}</p>}

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <div className="flex flex-wrap gap-1">
          {sessions.slice(0, 3).map((s, i) => (
            <AgentChip
              key={s.session_ref || i}
              label={translate(
                'office.panels.jobsKanbanPanel.agentOnMachine',
                '{{agent}} · {{machine}}',
                {
                  agent: s.agent_name || translate('office.panels.jobsKanbanPanel.agent', 'agent'),
                  machine: shortMachine(s.machine_id)
                }
              )}
            />
          ))}
          {sessions.length === 0 && (
            <span className="text-[9px] text-zinc-300 uppercase tracking-widest font-bold">
              {translate('office.panels.jobsKanbanPanel.noAgent', 'no agent')}
            </span>
          )}
        </div>
        <span
          className={`text-[9px] uppercase tracking-widest font-bold shrink-0 ${
            derived ? 'text-zinc-300 italic' : 'text-zinc-400'
          }`}
        >
          {job.source || translate('office.panels.jobsKanbanPanel.manualSource', 'manual')}
        </span>
      </div>
    </button>
  )
}

export function JobsKanbanPanel({ height = 320 }: JobsKanbanPanelProps) {
  const jobs = useJobsStore((s) => s.jobs)
  const connected = useJobsStore((s) => s.connected)
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <div
      className="w-full bg-white border-t border-black/8 flex flex-col pointer-events-auto shrink-0 relative"
      style={{ height }}
    >
      <div className="flex-1 overflow-x-auto overflow-y-hidden bg-zinc-50/20">
        <div className="flex h-full min-w-max px-5 py-4 gap-4">
          {COLUMNS.map(({ status, label }) => {
            const colJobs = jobs
              .filter((j) => columnOf(j) === status)
              .sort(
                (a, b) =>
                  (a.priority ?? 1e9) - (b.priority ?? 1e9) ||
                  (b.updated_at ?? 0) - (a.updated_at ?? 0)
              )
            return (
              <div key={status} className="w-56 flex flex-col gap-3">
                <div className="flex items-center justify-between shrink-0 select-none">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400 leading-none">
                      {label()}
                    </span>
                    <span className="px-1.5 py-0.5 bg-zinc-100 text-zinc-400 text-[9px] font-bold rounded-md min-w-4.5 text-center">
                      {colJobs.length}
                    </span>
                  </div>
                </div>

                <div className="flex-1 flex flex-col gap-2 overflow-y-auto scrollbar-sleek pr-1">
                  {colJobs.map((j) => (
                    <JobCard key={j.job_id} job={j} onOpen={setOpenId} />
                  ))}
                  {colJobs.length === 0 && (
                    <div className="border border-dashed border-zinc-100 rounded-lg p-4 flex items-center justify-center select-none">
                      <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">
                        {connected
                          ? translate('office.panels.jobsKanbanPanel.noJobs', 'No jobs')
                          : translate('office.panels.jobsKanbanPanel.connecting', 'Connecting…')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {openId && <JobsKanbanDetailModal jobId={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}

export default JobsKanbanPanel
