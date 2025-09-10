// systems/SceneSetup.js
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';

/**
 * 建立並設定 WebGLRenderer（與原本 game.js 相同）
 * @param {HTMLCanvasElement} canvas
 * @param {{antialias?: boolean, alpha?: boolean, pixelRatioCap?: number}} [opts]
 * @returns {THREE.WebGLRenderer}
 */
export function createRenderer(canvas, opts = {}) {
  const {
    antialias = true,
    alpha = true,
    pixelRatioCap = 2,
  } = opts;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias, alpha });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  return renderer;
}

/**
 * 建立場景（預設黑色背景，與原本一致）
 * @param {{background?: number|null}} [opts]
 *   - background: number=顏色、null=透明
 * @returns {THREE.Scene}
 */
export function createScene(opts = {}) {
  const { background = 0x000000 } = opts;
  const scene = new THREE.Scene();
  if (background === null) {
    scene.background = null; // 透明
  } else {
    scene.background = new THREE.Color(background);
  }
  return scene;
}

/**
 * 佈光（與你現在邏輯一致：Ambient + Hemisphere）
 * @param {THREE.Scene} scene
 * @param {{ambientIntensity?: number, hemiIntensity?: number, hemiSky?: number, hemiGround?: number}} [opts]
 * @returns {{ambient: THREE.AmbientLight, hemisphere: THREE.HemisphereLight}}
 */
export function setupLights(scene, opts = {}) {
  const {
    ambientIntensity = 3.0,
    hemiIntensity = 0.65,
    hemiSky = 0xeaf2ff,
    hemiGround = 0x1f262d,
  } = opts;

  const ambient = new THREE.AmbientLight(0xffffff, ambientIntensity);
  scene.add(ambient);

  const hemisphere = new THREE.HemisphereLight(hemiSky, hemiGround, hemiIntensity);
  hemisphere.position.set(0, 1, 0);
  scene.add(hemisphere);

  return { ambient, hemisphere };
}
