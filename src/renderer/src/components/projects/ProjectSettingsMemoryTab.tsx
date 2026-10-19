import React from 'react'
import type { ProjectThreadMemory } from '../../../../shared/project-settings'
import { Label } from '@/components/ui/label'

export type ProjectSettingsMemoryTabProps = {
  folderName: string
  workspaceRoot: string
  threadMemories: ProjectThreadMemory[]
}

export function ProjectSettingsMemoryTab({
  folderName,
  workspaceRoot,
  threadMemories
}: ProjectSettingsMemoryTabProps): React.JSX.Element {
  return (
    <div className="space-y-4" data-project-settings-memory-panel="">
      <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">
            Project Memory & Per-Thread Memory Architecture
          </span>
          <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
            Survives Thread Deletion · MCP Transferable
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Every thread in <strong>{folderName || 'this project'}</strong> writes its own memory file
          in <code>{workspaceRoot}/.omni-project/memory/threads/&lt;id&gt;.md</code> and a clean
          prose transcript (stripped of all tool calls, Argon/JEV format) in{' '}
          <code>{workspaceRoot}/.omni-project/transcripts/&lt;id&gt;/Output.txt</code>. Even when a
          thread is deleted from the UI, its memory and <code>Output.txt</code> stay preserved here
          and can be transferred to Claude App, Codex App, or Grok App via MCP.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold">
            Individual Thread Memories ({threadMemories.length})
          </Label>
          <span className="text-[11px] text-muted-foreground">
            {threadMemories.filter((m) => m.deletedFromUi).length} preserved from deleted threads
          </span>
        </div>
        {threadMemories.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            No thread memories recorded yet. Launch a thread or run <code>omni-cross-sync</code> to
            populate per-thread memories and <code>Output.txt</code> transcripts.
          </p>
        ) : (
          <ul className="scrollbar-sleek max-h-72 space-y-2 overflow-y-auto pr-1">
            {threadMemories.map((mem) => (
              <li key={mem.threadId} className="rounded-lg border bg-card p-3 text-xs space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{mem.title}</span>
                    <span className="rounded border px-1.5 py-px font-mono text-[10px] uppercase text-muted-foreground">
                      {mem.agent}
                      {mem.model ? ` · ${mem.model}` : ''}
                      {mem.effort ? ` (${mem.effort})` : ''}
                    </span>
                  </div>
                  {mem.deletedFromUi ? (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                      Deleted thread · Memory preserved
                    </span>
                  ) : (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                      {mem.status ?? 'active'}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">{mem.summary}</p>
                <div className="flex flex-wrap items-center gap-2 pt-1 font-mono text-[10px] text-muted-foreground">
                  <span className="rounded bg-muted px-1.5 py-0.5">
                    Memory:{' '}
                    {mem.memoryPath ??
                      `${workspaceRoot}/.omni-project/memory/threads/${mem.threadId}.md`}
                  </span>
                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">
                    Clean Transcript:{' '}
                    {mem.outputTxtPath ??
                      `${workspaceRoot}/.omni-project/transcripts/${mem.threadId}/Output.txt`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
