import { X, ArrowUpToLine } from 'lucide-react'
import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useJobsStore } from '../integration/fleet/jobsStore'
import { patchJob, prioritizeJob, refreshJobs } from '../integration/fleet/jobsApi'
import { COLUMNS, columnOf, isDerived, shortMachine } from './jobs-kanban-display'

function fmtTime(sec?: number | null): string {
  if (sec == null) {
    return '—'
  }
  try {
    return new Date(sec * 1000).toLocaleString()
  } catch {
    return '—'
  }
}

export function JobsKanbanDetailModal({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const jobs = useJobsStore((s) => s.jobs)
  const job = jobs.find((j) => j.job_id === jobId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!job) {
    // The job left the board (e.g. a derived session ended) — close quietly.
    return null
  }
  const derived = isDerived(job)
  const sessions = job.sessions ?? []

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fn()
      if (res === null) {
        setError(
          translate(
            'office.panels.jobsKanbanPanel.writeRejected',
            'The write was rejected (is the console cookie set / agent up?).'
          )
        )
      }
      await refreshJobs()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-full overflow-y-auto scrollbar-sleek bg-white rounded-xl border border-black/10 shadow-2xl p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-bold text-darkDelegation leading-snug break-words">
            {job.title || translate('office.panels.jobsKanbanPanel.untitledJob', 'Untitled job')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-600 rounded shrink-0"
            title={translate('office.panels.jobsKanbanPanel.close', 'Close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-widest">
          <span className="px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-500">
            {COLUMNS.find((c) => c.status === columnOf(job))?.label() ?? job.status}
          </span>
          <span
            className={`px-2 py-0.5 rounded-full bg-zinc-100 ${derived ? 'text-zinc-300 italic' : 'text-zinc-400'}`}
          >
            {job.source || translate('office.panels.jobsKanbanPanel.manualSource', 'manual')}
          </span>
          {job.priority != null && (
            <span className="px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-400">
              {translate('office.panels.jobsKanbanPanel.priority', 'p{{priority}}', {
                priority: job.priority
              })}
            </span>
          )}
          {job.owner && (
            <span className="text-zinc-500 normal-case tracking-normal">@{job.owner}</span>
          )}
        </div>

        {job.detail && (
          <p className="text-[12px] text-zinc-500 leading-relaxed whitespace-pre-wrap bg-zinc-50 p-3 rounded-lg border border-black/5">
            {job.detail}
          </p>
        )}

        <div className="space-y-1.5">
          <div className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
            {translate('office.panels.jobsKanbanPanel.boundAgents', 'Bound agents')}
          </div>
          {sessions.length === 0 && (
            <div className="text-[11px] text-zinc-400">
              {translate('office.panels.jobsKanbanPanel.noAgentBound', 'No agent bound yet.')}
            </div>
          )}
          {sessions.map((s, i) => (
            <div
              key={s.session_ref || i}
              className="text-[11px] text-zinc-500 flex items-center gap-2"
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: '#2fd27a' }}
              />
              <span className="font-semibold text-zinc-600">
                {s.agent_name || translate('office.panels.jobsKanbanPanel.agent', 'agent')}
              </span>
              <span className="text-zinc-400">· {shortMachine(s.machine_id)}</span>
              <span className="text-zinc-400">
                ·{' '}
                {s.agent_status ||
                  translate('office.panels.jobsKanbanPanel.unknownAgentStatus', 'unknown')}
              </span>
            </div>
          ))}
        </div>

        <div className="text-[10px] text-zinc-400 flex flex-wrap gap-x-4 gap-y-1">
          <span>
            {translate('office.panels.jobsKanbanPanel.createdAt', 'created {{time}}', {
              time: fmtTime(job.created_at)
            })}
          </span>
          <span>
            {translate('office.panels.jobsKanbanPanel.updatedAt', 'updated {{time}}', {
              time: fmtTime(job.updated_at)
            })}
          </span>
        </div>

        {derived ? (
          <div className="text-[11px] text-zinc-400 italic border-t border-black/5 pt-3">
            {translate(
              'office.panels.jobsKanbanPanel.derivedDescription',
              'Derived from a running session — read-only. It disappears when the session ends.'
            )}
          </div>
        ) : (
          <div className="space-y-3 border-t border-black/5 pt-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => prioritizeJob(job.job_id, 'top'))}
              className="w-full flex items-center justify-center gap-2 text-[11px] font-bold uppercase tracking-widest text-white rounded-lg py-2 disabled:opacity-50"
              style={{ backgroundColor: '#4c8dff' }}
            >
              <ArrowUpToLine size={13} strokeWidth={2.5} />{' '}
              {translate('office.panels.jobsKanbanPanel.prioritise', 'Prioritise — bump to top')}
            </button>
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-zinc-400 mb-1.5">
                {translate('office.panels.jobsKanbanPanel.moveStage', 'Move stage')}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {COLUMNS.map((c) => {
                  const current = c.status === columnOf(job)
                  return (
                    <button
                      key={c.status}
                      type="button"
                      disabled={busy || current}
                      onClick={() => run(() => patchJob(job.job_id, { status: c.status }))}
                      className={`text-[10px] font-bold uppercase tracking-widest rounded-lg py-1.5 border transition-colors disabled:opacity-40 ${
                        current
                          ? 'bg-zinc-100 text-zinc-400 border-black/5'
                          : 'bg-white text-zinc-500 border-black/10 hover:bg-zinc-50'
                      }`}
                    >
                      {c.label()}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {error && <div className="text-[11px] text-red-500">{error}</div>}
      </div>
    </div>
  )
}
