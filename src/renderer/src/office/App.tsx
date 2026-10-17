// @ts-nocheck
/**
 * Fleet Office — the-delegation's 3D office, mounted NATIVELY in the Omni Console
 * React tree (no iframe, no separate bundle). Driven entirely by our real fleet
 * data via the FleetBridge poller. Fills its parent container (the console's
 * .omni-content work area), not the whole viewport.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useCoreStore } from './integration/store/coreStore'
import { ActionLogPanel } from './interface/ActionLogPanel'
import { FinalOutputModal } from './interface/FinalOutputModal'
import Header from './interface/Header'
import InspectorPanel from './interface/InspectorPanel'
import { KanbanPanel } from './interface/KanbanPanel'
import { OutputReviewModal } from './interface/OutputReviewModal'
import SimulationView from './interface/SimulationView'
import { SceneContext } from './simulation/SceneContext'
import { SceneManager } from './simulation/SceneManager'
import { FleetBridge } from './integration/fleet/FleetBridge'
import { WorktreeOfficeBridge } from './integration/worktrees/WorktreeOfficeBridge'

const OfficeApp: React.FC = () => {
  const canvasRef = useRef<HTMLDivElement>(null)
  const managerRef = useRef<SceneManager | null>(null)
  const bridgeRef = useRef<WorktreeOfficeBridge | null>(null)
  const telemetryRef = useRef<FleetBridge | null>(null)
  const [sceneManager, setSceneManager] = useState<SceneManager | null>(null)

  const { isLogOpen, isKanbanOpen, setIsResizing } = useCoreStore()

  const [isFullscreen, setIsFullscreen] = useState(false)
  const [kanbanHeight, setKanbanHeight] = useState(220)

  const startResizing = useCallback(() => {
    setIsResizing(true)
  }, [setIsResizing])

  const stopResizing = useCallback(() => {
    setIsResizing(false)
  }, [setIsResizing])

  const resize = useCallback((e: MouseEvent) => {
    if (useCoreStore.getState().isResizing) {
      const windowHeight = window.innerHeight
      const newHeight = windowHeight - e.clientY
      const minHeight = windowHeight * 0.2
      const maxHeight = windowHeight * 0.5
      if (newHeight >= minHeight && newHeight <= maxHeight) {
        setKanbanHeight(newHeight)
      }
    }
  }, [])

  useEffect(() => {
    window.addEventListener('mousemove', resize)
    window.addEventListener('mouseup', stopResizing)
    return () => {
      window.removeEventListener('mousemove', resize)
      window.removeEventListener('mouseup', stopResizing)
    }
  }, [resize, stopResizing])

  // Mount the WebGPU scene UNCONDITIONALLY once the canvas container exists. There
  // is no LLM/isRunning gate — the office is always "running", populated by the
  // FleetBridge. (The original gated the world behind a Gemini-driven project;
  // that coupling is fully removed.)
  //
  // The live-data poller (FleetBridge) starts IMMEDIATELY on mount — it must NOT
  // wait on the large 3D GLB download. The local /api/sessions feed is tiny and
  // paints the Kanban, header counts, logs and brief on the first pass, so the
  // office looks populated while the 3D world and slow hub feeds stream in.
  // The 3D world paints itself in WebGPU, so the stylesheet cannot theme it.
  // Watch the same `dark` class on <html> that the CSS keys off and hand the
  // change to the scene, so both halves of the office switch together.
  useEffect(() => {
    if (!sceneManager) {
      return
    }
    sceneManager.applyTheme()
    const observer = new MutationObserver(() => sceneManager.applyTheme())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [sceneManager])

  useEffect(() => {
    if (!bridgeRef.current) {
      bridgeRef.current = new WorktreeOfficeBridge()
      bridgeRef.current.start()
    }
    // Provider usage, dispatch load and reliability are the backoffice's to know,
    // and the side panels render them; telemetry mode keeps that poller off the
    // stores the workspace bridge owns.
    if (!telemetryRef.current) {
      telemetryRef.current = new FleetBridge('telemetry')
      telemetryRef.current.start()
    }

    if (canvasRef.current && !managerRef.current) {
      const manager = new SceneManager(canvasRef.current, () => {})
      managerRef.current = manager
      setSceneManager(manager)
    }
    return () => {
      if (bridgeRef.current) {
        bridgeRef.current.dispose()
        bridgeRef.current = null
      }
      if (telemetryRef.current) {
        telemetryRef.current.dispose()
        telemetryRef.current = null
      }
      if (managerRef.current) {
        managerRef.current.dispose()
        managerRef.current = null
        setSceneManager(null)
      }
    }
  }, [])

  return (
    <SceneContext.Provider value={sceneManager}>
      <div className="office-root w-full h-full bg-[var(--office-ground)] overflow-hidden flex flex-col font-sans">
        {!isFullscreen && <Header />}

        <div className="flex-1 flex flex-row min-h-0 min-w-0 overflow-hidden">
          {/* Left: Activity / Technical LOGS */}
          {isLogOpen && !isFullscreen && <ActionLogPanel />}

          {/* Center: 3D office + Kanban drawer */}
          <div className="relative flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden bg-[var(--office-ground)]">
            <div className="flex-1 flex flex-col min-w-0 min-h-0">
              <SimulationView
                canvasRef={canvasRef}
                isFullscreen={isFullscreen}
                setIsFullscreen={setIsFullscreen}
              />

              {isKanbanOpen && !isFullscreen && (
                <div
                  className="h-2 bg-transparent hover:bg-[var(--office-hover)] border-t border-[var(--office-border)] transition-colors cursor-row-resize z-30 flex items-center justify-center group shrink-0"
                  onMouseDown={startResizing}
                >
                  <div className="w-12 h-1 bg-[var(--office-grip)] rounded-full group-hover:bg-[var(--office-grip-hover)]" />
                </div>
              )}

              {/* The workspace board: coreStore.tasks, which WorktreeOfficeBridge owns.
                  The console's JobsKanbanPanel shows backoffice jobs instead — not
                  what this app's office is for. */}
              {isKanbanOpen && !isFullscreen && <KanbanPanel height={kanbanHeight} />}
            </div>
          </div>

          {/* Right: Project-Info / provider-usage inspector */}
          {!isFullscreen && <InspectorPanel />}
        </div>

        <FinalOutputModal />
        <OutputReviewModal />
      </div>
    </SceneContext.Provider>
  )
}

export default OfficeApp
