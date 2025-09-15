// SceneSetup.js
// three v0.165.0
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';

// ★ 後處理（選配）：需要時才使用
import { EffectComposer } from 'https://unpkg.com/three@0.165.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://unpkg.com/three@0.165.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://unpkg.com/three@0.165.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutlinePass } from 'https://unpkg.com/three@0.165.0/examples/jsm/postprocessing/OutlinePass.js';

/**
 * 建立並設定 WebGLRenderer
 * @param {HTMLCanvasElement} canvas
 * @param {{
 *   antialias?: boolean,
 *   alpha?: boolean,
 *   pixelRatioCap?: number,
 *   toneMapping?: number,           // ★ 可帶 THREE.NoToneMapping / ACESFilmicToneMapping...
 *   exposure?: number               // ★ 曝光
 * }} [opts]
 * @returns {THREE.WebGLRenderer}
 */
export function createRenderer(canvas, opts = {}) {
  const {
    antialias = true,
    alpha = true,
    pixelRatioCap = 2,
    toneMapping = THREE.ACESFilmicToneMapping, // ★ 預設 ACES
    exposure = 1.0,                             // ★ 預設 1.0
  } = opts;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias, alpha });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = toneMapping;
  renderer.toneMappingExposure = exposure;
  return renderer;
}

/**
 * 建立場景
 * @param {{
 *   background?: number|null,       // number=顏色、null=透明
 *   environment?: 'skybox'|null,    // ★ 若想讓 PBR 有環境貼圖，選 'skybox'（會跟 setupLights 的 skybox 一致）
 * }} [opts]
 * @returns {THREE.Scene}
 */
export function createScene(opts = {}) {
  const { background = 0x000000, environment = null } = opts;
  const scene = new THREE.Scene();
  if (background === null) {
    scene.background = null; // 透明
  } else {
    scene.background = new THREE.Color(background);
  }
  // environment 會在 setupLights 設定 skybox 後一併給 scene.environment
  scene.userData.__wantEnvironmentFromSkybox = environment === 'skybox';
  return scene;
}

/**
 * 佈光（Ambient + Hemisphere）並可選載入 Skybox
 * @param {THREE.Scene} scene
 * @param {{
 *   ambientIntensity?: number,
 *   hemiIntensity?: number,
 *   hemiSky?: number,
 *   hemiGround?: number,
 *   skybox?: boolean,
 *   skyboxPath?: string,
 *   skyboxFiles?: string[],         // [px, nx, py, ny, pz, nz] 或任意順序，視你的檔名排列
 *   setAsEnvironment?: boolean      // ★ skybox 是否同時賦給 scene.environment（PBR 反射）
 * }} [opts]
 * @returns {{ambient: THREE.AmbientLight, hemisphere: THREE.HemisphereLight, skyboxTex?: THREE.CubeTexture}}
 */
export function setupLights(scene, opts = {}) {
  const {
    ambientIntensity = 3.0,
    hemiIntensity = 0.65,
    hemiSky = 0xeaf2ff,
    hemiGround = 0x1f262d,
    skybox = true,
    skyboxPath = '../public/skybox/',
    // 這組順序對應 three 的 CubeTextureLoader 預設：[px, nx, py, ny, pz, nz]
    skyboxFiles = ['yonder_rt.jpg', 'yonder_lf.jpg', 'yonder_up.jpg', 'yonder_dn.jpg', 'yonder_ft.jpg', 'yonder_bk.jpg'],
    setAsEnvironment = true, // ★ 一併指定為環境貼圖
  } = opts;

  const ambient = new THREE.AmbientLight(0xffffff, ambientIntensity);
  scene.add(ambient);

  const hemisphere = new THREE.HemisphereLight(hemiSky, hemiGround, hemiIntensity);
  hemisphere.position.set(0, 1, 0);
  scene.add(hemisphere);

  let skyboxTex;
  if (skybox) {
    const loader = new THREE.CubeTextureLoader().setPath(skyboxPath);
    skyboxTex = loader.load(skyboxFiles);
    scene.background = skyboxTex;

    // 若 createScene 有要求 environment=skybox，或 setAsEnvironment=true，就同步設置
    if (setAsEnvironment || scene.userData.__wantEnvironmentFromSkybox) {
      scene.environment = skyboxTex;
    }
  }

  return { ambient, hemisphere, skyboxTex };
}

/**
 * 建立後處理管線（Bloom + Outline）—— 完全選配
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {{
 *   enabled?: boolean,                 // ★ 是否啟用整個 VFX（false 則不建立 composer）
 *   size?: { width:number, height:number },
 *   bloom?: {
 *     enabled?: boolean,
 *     strength?: number,               // 預設 0.5
 *     radius?: number,                 // 預設 0.0
 *     threshold?: number               // 預設 1.0
 *   },
 *   outline?: {
 *     enabled?: boolean,
 *     edgeGlow?: number,               // 預設 1.0
 *     edgeThickness?: number,          // 預設 1.5
 *     edgeStrength?: number,           // 預設 7.0
 *     visibleEdgeColor?: string|number, // 預設 '#ffffff'
 *     hiddenEdgeColor?: string|number   // 預設 '#190a05'
 *   }
 * }} [opts]
 * @returns {{
 *   composer?: EffectComposer,
 *   passes?: { render?: RenderPass, bloom?: UnrealBloomPass, outline?: OutlinePass },
 *   setOutlineTargets?: (objects:THREE.Object3D[])=>void,
 *   render: ()=>void,                 // 若無 composer 則 fallback renderer.render
 *   resize: (w:number,h:number)=>void
 * }}
 */
export function setupVFX(renderer, scene, camera, opts = {}) {
  const {
    enabled = true,
    size = { width: window.innerWidth, height: window.innerHeight },
    bloom: bloomOpt = {},
    outline: outlineOpt = {},
  } = opts;

  // 若整包關閉，回傳最小 wrapper，主程式依舊可呼叫 render()/resize()
  if (!enabled) {
    return {
      composer: undefined,
      passes: {},
      setOutlineTargets: () => {},
      render: () => renderer.render(scene, camera),
      resize: (w, h) => renderer.setSize(w, h, false),
    };
  }

  const composer = new EffectComposer(renderer);
  composer.setSize(size.width, size.height);

  // 基本渲染 Pass
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // Bloom
  const bloomEnabled = bloomOpt.enabled ?? true;
  let bloomPass;
  if (bloomEnabled) {
    const strength = bloomOpt.strength ?? 0.5;
    const radius = bloomOpt.radius ?? 0.0;
    const threshold = bloomOpt.threshold ?? 1.0;
    bloomPass = new UnrealBloomPass(new THREE.Vector2(size.width, size.height), strength, radius, threshold);
    composer.addPass(bloomPass);
  }

  // Outline
  const outlineEnabled = outlineOpt.enabled ?? true;
  let outlinePass;
  if (outlineEnabled) {
    outlinePass = new OutlinePass(new THREE.Vector2(size.width, size.height), scene, camera);
    outlinePass.edgeGlow = outlineOpt.edgeGlow ?? 1.0;
    outlinePass.edgeThickness = outlineOpt.edgeThickness ?? 1.5;
    outlinePass.edgeStrength = outlineOpt.edgeStrength ?? 7.0;
    outlinePass.visibleEdgeColor = new THREE.Color(outlineOpt.visibleEdgeColor ?? '#ffffff');
    outlinePass.hiddenEdgeColor = new THREE.Color(outlineOpt.hiddenEdgeColor ?? '#190a05');
    composer.addPass(outlinePass);
  }

  const setOutlineTargets = (objects = []) => {
    if (outlinePass) outlinePass.selectedObjects = objects;
  };

  const render = () => {
    composer.render();
  };

  const resize = (w, h) => {
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w, h);
    if (outlinePass) outlinePass.setSize(w, h);
  };

  return {
    composer,
    passes: { render: renderPass, bloom: bloomPass, outline: outlinePass },
    setOutlineTargets,
    render,
    resize,
  };
}

/* ------------------------------
 * 使用示例（在你的主程式中）
 * ------------------------------
 *
 * import { createRenderer, createScene, setupLights, setupVFX } from './systems/SceneSetup.js';
 *
 * // 1) Renderer
 * const renderer = createRenderer(canvas, {
 *   pixelRatioCap: 2,
 *   toneMapping: THREE.ACESFilmicToneMapping,
 *   exposure: 1.0,
 * });
 *
 * // 2) Scene
 * const scene = createScene({ background: 0x000000, environment: 'skybox' });
 *
 * // 3) Lights + Skybox
 * const { skyboxTex } = setupLights(scene, {
 *   ambientIntensity: 3.0,
 *   hemiIntensity: 0.65,
 *   skybox: true,
 *   skyboxPath: '/public/skybox/',
 *   skyboxFiles: ['yonder_rt.jpg','yonder_lf.jpg','yonder_up.jpg','yonder_dn.jpg','yonder_ft.jpg','yonder_bk.jpg'],
 *   setAsEnvironment: true,
 * });
 *
 * // 4) VFX
 * const vfx = setupVFX(renderer, scene, camera, {
 *   enabled: true,
 *   size: { width: innerWidth, height: innerHeight },
 *   bloom: { enabled: true, strength: 0.5, radius: 0.0, threshold: 1.0 },
 *   outline: { enabled: true, edgeGlow: 1.0, edgeThickness: 1.5, edgeStrength: 7.0 }
 * });
 *
 * // 若要套外框對象：
 * // vfx.setOutlineTargets([horsePlayerInstance.model]);
 *
 * // render loop
 * function tick() {
 *   requestAnimationFrame(tick);
 *   // ... 更新動畫、特效參數（例如 vfx.passes.bloom.strength = uiValue） ...
 *   vfx.render(); // 若 vfx.disabled，會 fallback 直接 renderer.render
 * }
 * tick();
 *
 * // resize
 * window.addEventListener('resize', () => {
 *   camera.aspect = innerWidth / innerHeight;
 *   camera.updateProjectionMatrix();
 *   vfx.resize(innerWidth, innerHeight);
 * });
 */
