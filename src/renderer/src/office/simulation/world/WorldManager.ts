// @ts-nocheck

import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import * as THREE from 'three/webgpu'
import { getAgentSet } from '../../data/agents'
import { useTeamStore } from '../../integration/store/teamStore'
import type { NavMeshManager } from '../pathfinding/NavMeshManager'
import type { PoiManager } from './PoiManager'
import { DRACO_LIB_PATH, OFFICE_ASSET_BASE } from '../constants'

export class WorldManager {
  private office: THREE.Group | null = null

  constructor(
    private scene: THREE.Scene,
    private navMesh: NavMeshManager,
    private poiManager: PoiManager
  ) {}

  public async load(): Promise<void> {
    const loader = new GLTFLoader()
    // The GLBs are Draco-compressed — measured: GLTFLoader refused them with
    // "No DRACOLoader instance provided" and the room never appeared. The
    // decoders ship beside the models.
    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath(DRACO_LIB_PATH)
    loader.setDRACOLoader(dracoLoader)
    // Not fetch(): the packaged renderer loads from file://, which fetch refuses.
    // FileLoader rides XHR, which Electron permits for the app's own files.
    const buf = (await new THREE.FileLoader()
      .setResponseType('arraybuffer')
      .loadAsync(`${OFFICE_ASSET_BASE}models/office.glb`)) as ArrayBuffer
    const officeGltf = await new Promise<GLTF>((res, rej) => loader.parse(buf, '', res, rej))
    this.office = officeGltf.scene
    this.scene.add(this.office)

    // Get current AgentSet color
    const { selectedAgentSetId, customSystems } = useTeamStore.getState()
    const activeSet = getAgentSet(selectedAgentSetId, customSystems)
    const themeColor = new THREE.Color(activeSet.color)

    // Extract NavMesh and setup
    this.office.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh
        const name = mesh.name.toLowerCase()

        if (name.includes('navmesh')) {
          this.navMesh.loadFromGeometry(mesh.geometry)
          mesh.visible = false
        } else {
          mesh.receiveShadow = true
          mesh.castShadow = true

          // Apply specific material for WebGPU shadow compatibility as requested
          if (mesh.material) {
            const oldMat = mesh.material as THREE.MeshStandardMaterial

            // Check if mesh name starts with "colored" to apply thematic color
            const isColoredMesh = name.startsWith('colored')

            // DARK THEME: the office ships with light/white surfaces (floor, walls,
            // furniture) that clash inside the dark Omni Console shell. Retint every
            // non-"colored" surface toward a dark slate so the room reads as a dark
            // room. We darken the mesh's ORIGINAL color (preserving relative tone
            // between floor/walls/props) and drop the baked light textures on plain
            // surfaces so a bright map can't wash the room back to white. The
            // "colored" accent meshes keep the bright agent-set theme color, and the
            // colored CHARACTERS are a separate system (CharacterManager) — both
            // stay vivid and pop against the dark environment.
            let material: THREE.MeshStandardNodeMaterial
            if (isColoredMesh) {
              material = new THREE.MeshStandardNodeMaterial({
                color: themeColor,
                map: oldMat.map,
                roughness: 1,
                metalness: 0.35
              })
            } else {
              const dark = (oldMat.color?.clone() ?? new THREE.Color(0xffffff)).lerp(
                new THREE.Color(0x0d1220),
                0.95
              )
              material = new THREE.MeshStandardNodeMaterial({
                color: dark,
                roughness: 1,
                metalness: 0.2
              })
            }
            mesh.material = material
          }
        }
      }
    })

    // Extract Points of Interest
    this.poiManager.loadFromGlb(this.office)
  }

  public updateThemeColor(color: string): void {
    if (!this.office) {
      return
    }

    const themeColor = new THREE.Color(color)

    this.office.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh
        const name = mesh.name.toLowerCase()

        if (name.startsWith('colored') && mesh.material) {
          // Update existing material color if it's a NodeMaterial
          // or replace it if needed. Since we already replaced them in load(),
          // we can just update the color property.
          const material = mesh.material as THREE.MeshStandardNodeMaterial
          if (material.color) {
            material.color.copy(themeColor)
          }
        }
      }
    })
  }

  public getOffice(): THREE.Group | null {
    return this.office
  }
}
