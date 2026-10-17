// @ts-nocheck
import type { AtlasCoords } from '../types'

// ── Character Visual ─────────────────────────────────────────
/** Vertical offset from position origin to character center (for raycasting/picking). */
export const CHARACTER_Y_OFFSET = 0.9
/** Vertical offset from position origin to name/chat bubble anchor. */
export const BUBBLE_Y_OFFSET = 1.3
/** World-space sphere radius used for mouse-picking characters. */
export const PICK_RADIUS = 0.65
/** World-space sphere radius used for mouse-picking POIs. */
export const POI_PICK_RADIUS = 0.4

// ── Expression Atlas ─────────────────────────────────────────
export const ATLAS_COLS = 2
export const ATLAS_ROWS = 4
/** Atlas cell used for the blink frame (eyes closed). */
export const BLINK_FRAME: AtlasCoords = { col: 1, row: 3 }
/** Seconds the blink frame is held. */
export const BLINK_DURATION = 0.15
/** Seconds per speaking mouth frame. */
export const SPEAKING_FRAME_DURATION = 0.12
/** Random blink interval range [min, min+range] in seconds. */
export const BLINK_INTERVAL_MIN = 2
export const BLINK_INTERVAL_RANGE = 3

// ── Pathfinding & Navigation ─────────────────────────────────
/** Distance (world units) at which a path node is considered reached. */
export const PATH_NODE_ARRIVAL = 0.25
/** Distance at which player arrival at a GOTO waypoint is detected on CPU. */
export const ARRIVAL_RADIUS = 0.3
/** Distance at which player↔NPC encounter is triggered. */
export const ENCOUNTER_RADIUS = 1.5
/** Zone ID used with three-pathfinding. */
export const NAVMESH_ZONE = 'level'

/** Scene background — Omni Console app ground (dark), so the 3D room reads as a
 * dark room mounted inside the dark console shell, not a white block. */
/**
 * Where this copy's 3D assets live.
 *
 * The console served the office at /office/ and fetched models off that path.
 * Vendored into the IDE they ship with the renderer instead, so every loader
 * goes through this one constant.
 */
export const OFFICE_ASSET_BASE = `${import.meta.env.BASE_URL}office-assets/`
/** Draco decoders. The GLBs ARE Draco-compressed (KHR_draco_mesh_compression is in
 *  both files), whatever the loader comments inherited from the console claimed. */
export const DRACO_LIB_PATH = `${OFFICE_ASSET_BASE}vendor/draco/`

/** The console's dark ground — the scene's background under a dark theme. */
export const SCENE_BACKGROUND_COLOR = 0x0b0e14
/** The office's own authored ground, used under a light theme. */
export const SCENE_BACKGROUND_COLOR_LIGHT = 0xfafcfb

/**
 * The scene background for the theme in force.
 *
 * The 3D world paints itself in WebGPU, where the stylesheet cannot reach it, so
 * the one place CSS could not theme the office is read from the same signal CSS
 * uses: the `dark` class the app toggles on <html>.
 */
export function sceneBackgroundColor(): number {
  const dark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  return dark ? SCENE_BACKGROUND_COLOR : SCENE_BACKGROUND_COLOR_LIGHT
}
