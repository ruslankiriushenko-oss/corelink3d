/**
 * CoreLink 3D — Environment Manager (environmentManager.js)
 * Manages lighting presets ("Studio", "Sunset", "Cyberpunk", "Night"), shadow maps, ambient intensity,
 * scene backgrounds and lighting presets.
 */

import * as THREE from 'three';
import viewer3d from './viewer3d.js';

class EnvironmentManager {
  constructor() {
    this.currentPreset = 'studio';

    this.presets = {
      studio: {
        background: 0x080a0f,
        ambientColor: 0xffffff,
        ambientIntensity: 0.6,
        keyColor: 0xffffff,
        keyIntensity: 1.5,
        keyPos: [5, 8, 5],
        fillColor: 0x8899ff,
        fillIntensity: 0.4,
        rimColor: 0x00f2fe,
        rimIntensity: 0.6
      },
      sunset: {
        background: 0x1a0f1d,
        ambientColor: 0x4a154b,
        ambientIntensity: 0.4,
        keyColor: 0xff8c00, // Warm orange
        keyIntensity: 2.2,
        keyPos: [7, 4, 3],
        fillColor: 0x9333ea, // Deep violet
        fillIntensity: 0.6,
        rimColor: 0xf59e0b,
        rimIntensity: 1.2
      },
      cyberpunk: {
        background: 0x030712,
        ambientColor: 0x0f172a,
        ambientIntensity: 0.3,
        keyColor: 0x00f2fe, // Neon cyan
        keyIntensity: 2.5,
        keyPos: [-4, 6, 4],
        fillColor: 0xff007f, // Neon magenta
        fillIntensity: 2.0,
        rimColor: 0x3b82f6,
        rimIntensity: 1.5
      },
      night: {
        background: 0x020408,
        ambientColor: 0x0f172a,
        ambientIntensity: 0.2,
        keyColor: 0x38bdf8, // Cold moonlight blue
        keyIntensity: 1.2,
        keyPos: [2, 10, -2],
        fillColor: 0x1e1b4b,
        fillIntensity: 0.3,
        rimColor: 0xffffff,
        rimIntensity: 1.0
      }
    };
  }

  /**
   * Apply lighting environment preset.
   * @param {string} presetName ("studio" | "sunset" | "cyberpunk" | "night")
   */
  setEnvironmentPreset(presetName) {
    const key = presetName ? presetName.toLowerCase() : 'studio';
    const config = this.presets[key] || this.presets.studio;
    this.currentPreset = key;

    // Background
    viewer3d.scene.background = new THREE.Color(config.background);

    // Ambient Light
    if (viewer3d.lights.ambient) {
      viewer3d.lights.ambient.color.setHex(config.ambientColor);
      viewer3d.lights.ambient.intensity = config.ambientIntensity;
    }

    // Key Light
    if (viewer3d.lights.key) {
      viewer3d.lights.key.color.setHex(config.keyColor);
      viewer3d.lights.key.intensity = config.keyIntensity;
      viewer3d.lights.key.position.set(...config.keyPos);
    }

    // Fill Light
    if (viewer3d.lights.fill) {
      viewer3d.lights.fill.color.setHex(config.fillColor);
      viewer3d.lights.fill.intensity = config.fillIntensity;
    }

    // Rim Light
    if (viewer3d.lights.rim) {
      viewer3d.lights.rim.color.setHex(config.rimColor);
      viewer3d.lights.rim.intensity = config.rimIntensity;
    }

    return this.currentPreset;
  }

  setAmbientIntensity(val) {
    const intensity = THREE.MathUtils.clamp(parseFloat(val), 0, 3);
    if (viewer3d.lights.ambient) {
      viewer3d.lights.ambient.intensity = intensity;
    }
  }

  setKeyLightIntensity(val) {
    const intensity = THREE.MathUtils.clamp(parseFloat(val), 0, 5);
    if (viewer3d.lights.key) {
      viewer3d.lights.key.intensity = intensity;
    }
  }

  setLightIntensity(name, value) {
    viewer3d.setLightIntensity(name, value);
  }

  setLightEnabled(name, enabled) {
    viewer3d.setLightEnabled(name, enabled);
  }

  setLightColor(name, color) {
    viewer3d.setLightColor(name, color);
  }

  setExposure(value) {
    viewer3d.setExposure(value);
  }

  setEnvironmentIntensity(value) {
    viewer3d.setEnvironmentIntensity(value);
  }

  setShadowsEnabled(enabled) {
    viewer3d.setShadows(enabled);
  }

  setBackgroundColor(colorHex) {
    try {
      viewer3d.scene.background = new THREE.Color(colorHex);
    } catch (e) {
      console.warn('[EnvironmentManager] Invalid background color:', colorHex);
    }
  }
}

const environmentManager = new EnvironmentManager();
export default environmentManager;
