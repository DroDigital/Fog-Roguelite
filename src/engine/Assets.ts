// Asset library: authored content (Blender exports, downloaded libraries)
// overrides the procedural fallbacks. Drop GLB files into public/assets/ and
// list them in public/assets/manifest.json:
//
//   { "geometry": { "tree": "models/dead_tree.glb", "rock": "models/rock.glb" },
//     "audio":    { "hitFlesh": "audio/hit_flesh.ogg" } }
//
// Missing files are ignored so the game always runs from procedural assets.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface Manifest {
  geometry?: Record<string, string>;
  audio?: Record<string, string>;
}

class AssetLibrary {
  private geos = new Map<string, THREE.BufferGeometry>();
  manifest: Manifest = {};

  async load(base = './assets/') {
    try {
      const res = await fetch(base + 'manifest.json');
      if (!res.ok) return;
      this.manifest = (await res.json()) as Manifest;
    } catch {
      return;
    }
    const loader = new GLTFLoader();
    const jobs = Object.entries(this.manifest.geometry ?? {}).map(async ([id, file]) => {
      try {
        const gltf = await loader.loadAsync(base + file);
        let found: THREE.BufferGeometry | null = null;
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!found && m.isMesh) {
            found = m.geometry.clone();
            found.applyMatrix4(m.matrixWorld);
          }
        });
        if (found) this.geos.set(id, found);
      } catch (e) {
        console.warn('[assets] failed to load', id, file, e);
      }
    });
    await Promise.all(jobs);
  }

  geometry(id: string): THREE.BufferGeometry | null {
    return this.geos.get(id) ?? null;
  }
}

export const assets = new AssetLibrary();
