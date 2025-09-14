// 主要遊戲腳本：11 匹馬、Lock/SlowMo 解耦、強制前五名次、UI 以 finalRank 為主（RaceEngine 抽離移動邏輯）
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';
import { GameCamera } from './systems/GameCamera.js';
import { AudioSystem } from './systems/AudioSystem.js';
import { buildField } from './FieldBuilder.js';
import { buildRoadBetween } from './TrackBuilder.js';

import { UIController } from './systems/ui/UIController.js';
import { GameReadyView } from './systems/ui/views/GameReadyView.js';
import { GameView } from './systems/ui/views/GameView.js';
import { FinishedView } from './systems/ui/views/FinishedView.js';
// ★ 新增：相機調校工具（可選開關）
import { mountEditTool } from './systems/EditTool.js';

// 場景/馬匹載入
import { createRenderer, createScene, setupLights } from './SceneSetup.js';
import { loadHorsesAsync } from './systems/HorsesFactory.js';

// ★ 新增：賽跑數值引擎（移動/名次/完賽判定全部在這支）
import { RaceEngine } from './systems/RaceEngine.js';

// ===== 小工具 =====
const $log = document.getElementById('log');
const canvas = document.getElementById('three-canvas');
const log = (...a) => { if ($log) $log.textContent += a.join(' ') + '\n'; console.log(...a); };
const reportProgress = (v) => parent?.postMessage({ type: 'game:progress', value: v }, '*');
const reportReady = () => parent?.postMessage({ type: 'game:ready' }, '*');
const reportError = (e) => parent?.postMessage({ type: 'game:error', error: String(e) }, '*');
const banner = (msg, ok = true) => {
  const d = document.createElement('div');
  d.className = 'banner ' + (ok ? 'ok' : 'err');
  d.textContent = msg;
  document.documentElement.appendChild(d);
  setTimeout(() => d.remove(), 3600);
};

let currentGameId = '';

// ===== 狀態機 =====
const STATE = { Ready: 'Ready', Running: 'Running', Paused: 'Paused', Finished: 'Finished' };
let gameState = STATE.Ready;

// ===== 場景物件 / 遊戲資料 =====
let renderer, scene, camera, clock;
let horses = []; // { player: HorsePlayer, startPos: THREE.Vector3, laneZ:number, faceRight:boolean }
const laneCount = 11;
const trackLength = 10;
const startLineX = -trackLength / 2;
const finishLineX = trackLength / 2;
const finishDetectX = finishLineX - 0.5; // 衝線判定（略早一點）

let gameCam, audioSystem, ui;
let leader = null;
let disposed = false;

let minLaneZ = +Infinity;
let maxLaneZ = -Infinity;

let forcedTop5Rank = null; // 由 onGameStart 設定

let editTool = null;

// —— 倒數期間：就位補間
let standbyPlan = null; // { items:[{i,from,to,t0,dur}], done }

// —— 數學小工具（RaceEngine 也會使用）
const randFloat = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const noise = (t, i) => Math.sin(t * 5 + i * 1.3) * 0.3;

// 建立注入方法
const getCAM = () => CAM;
const getCamera = () => camera;
const getDirVec = () => FIXED_DIR; // 若你改成 CAM.DIR，這裡回傳一個共享 THREE.Vector3 即可

// ======== 透視攝影機參數（唯一模式） ========
const CAM = {
  VIEW_HEIGHT: 30,
  FRAMING_BIAS_Y: 0.80,
  FOV_DEG: 55,
  LOOK_AHEAD_MIN: 8,
  SIDE_READY: { x: startLineX, z: 180, h: 60, lerp: 0.18 },
  SIDE_RUN: { z: 180, h: 60, lerp: 0.18 },
  SIDE_FIN: { x: finishLineX, z: 180, h: 60, lerp: 0.15 },
  AWARD: {
    ZOOM: 0.3,
    POS: { x: -50, y: 8, z: 0 },   // y=相機高度；x/z 不再用來決定角度（可忽略）
    LOOK: { x: 0, y: 5, z: 0 },
    AZIMUTH_DEG: 90,               // ★ 新增：繞頒獎台的水平角度（0=正面，90=右側，-90=左側，180=背面）
    DIST_SCALE: 1.0                // ★ 新增：距離倍率（可微調遠近，預設 1）
  },
};

// ===== 固定相機視角方向：正規化 (0, -0.4, -1) =====
const FIXED_DIR = new THREE.Vector3(0, -0.4, -1);

// ===== 頒獎台（在原點、Z 軸展開；視角拉近）=====
const PODIUM_SCALE = 10.0; // 整體放大倍率
const podiumX = 0, podiumZ = 0;
// ★ 調整間距讓馬不重疊，仍以原點為中心展開
const podiumGap = 3.0;
const podiumHeights = [2.2, 1.7, 1.3, 1.0, 0.8];
let podiumGroup = null; // ★★★ 頒獎台群組
// 置中到賽道中段（X 軸）
const podiumMidX = (startLineX + finishLineX) * 0.5;


// ★★★ 建立頒獎台幾何（原點附近）
// — 規格：5 座台階，Z 軸依序 [-2, -1, 0, +1, +2]*gap 展開；高度乘以 PODIUM_SCALE
function ensurePodium() {
  if (podiumGroup && podiumGroup.parent) return podiumGroup;

  const s = PODIUM_SCALE;
  podiumGroup = new THREE.Group();
  podiumGroup.name = 'PodiumGroup';

  const baseSizeX = 2.2 * s;      // 台面寬（X）
  const baseSizeZ = 2.2 * s;      // 台面深（Z）

  // 🔧 將「x 軸的排列間距」改為變數 y（你要的命名）
  const y = podiumGap * s;        // ← 橫向（X）間距，變數名叫 y

  const mats = [
    new THREE.MeshStandardMaterial({ color: 0xf6d15a }),
    new THREE.MeshStandardMaterial({ color: 0xc0c0c0 }),
    new THREE.MeshStandardMaterial({ color: 0xcd7f32 }),
    new THREE.MeshStandardMaterial({ color: 0x8fa3b0 }),
    new THREE.MeshStandardMaterial({ color: 0x8fb08f }),
  ];

  for (let k = 0; k < 5; k++) {
    const h = podiumHeights[k] * s;
    const geo = new THREE.BoxGeometry(baseSizeX, h, baseSizeZ);
    const mesh = new THREE.Mesh(geo, mats[k % mats.length]);
    mesh.castShadow = true; mesh.receiveShadow = true;

    // 🔧 原本是 Z 軸展開；改成 X 軸展開，Z 固定在賽道中線 0
    //    中心往左右排開：..., -2y, -1y, 0, +1y, +2y
    mesh.position.set(podiumMidX + (k - 2) * y, h * 0.5, 0);
    mesh.name = `Podium_${k + 1}`;
    podiumGroup.add(mesh);
  }

  scene.add(podiumGroup);
  return podiumGroup;
}


// ★★★ 移除頒獎台（新局前清理）
function destroyPodium() {
  if (!podiumGroup) return;
  podiumGroup.traverse(n => {
    if (n.isMesh) {
      n.geometry?.dispose?.();
      if (Array.isArray(n.material)) n.material.forEach(m => m.dispose?.());
      else n.material?.dispose?.();
    }
  });
  podiumGroup.parent?.remove(podiumGroup);
  podiumGroup = null;
}

// ★★★ 僅保留前五名可見，其餘隱藏
function setOnlyTop5Visible(top5Numbers) {
  const keepIdx = new Set(top5Numbers.map(n => clamp((n | 0) - 1, 0, laneCount - 1)));
  for (let i = 0; i < horses.length; i++) {
    const hObj = horses[i];
    if (!hObj?.player) continue;
    hObj.player.group.visible = keepIdx.has(i);
  }
}

// ★★★ 顯示全部馬（新局前恢復）
function showAllHorses() {
  for (let i = 0; i < horses.length; i++) {
    const hObj = horses[i];
    if (!hObj?.player) continue;
    hObj.player.group.visible = true;
  }
}

// ★★★ 讓馬站上頒獎台頂部（原點排列 + 高度落差）
function placeTop5OnPodium() {
  const s = PODIUM_SCALE;

  // 🔧 用同樣命名：以 y 作為橫向（X）間距
  const y = podiumGap * s;

  const top5Numbers = (race?.getFinalRank?.() ?? []).slice(0, 5);
  if (top5Numbers.length === 0) return;

  ensurePodium();

  for (let k = 0; k < top5Numbers.length; k++) {
    const num = top5Numbers[k];
    const idx = clamp((num | 0) - 1, 0, laneCount - 1);
    const hObj = horses[idx];
    if (!hObj?.player) continue;

    const p = hObj.player;

    // 對應台階頂面高度
    const podiumTopY = (podiumHeights[k] * s);

    // 🔧 橫向（X）展開；Z 固定在 0（賽道中線）
    const targetX = podiumMidX + (k - 2) * y;
    const targetY = podiumTopY;
    const targetZ = 0;

    p.group.position.set(targetX, targetY, targetZ);

    // 面向鏡頭或右方皆可；保留向右
    p.group.rotation.set(0, Math.PI / 2, 0);

    // 🔧 Idle01 隨機起始幀（利用 speed=1, offset=Math.random()）
    p.playIdle01(true, 0.15, 1, Math.random());
  }

  // 隱藏其餘馬匹
  setOnlyTop5Visible(top5Numbers);
}

// ★★★ 讓頒獎台上的馬面向鏡頭（或側面）
function orientTop5ToCamera() {
  const top5 = (race?.getFinalRank?.() ?? []).slice(0, 5);
  for (let k = 0; k < top5.length; k++) {
    const idx = (top5[k] | 0) - 1;
    const hObj = horses[idx];
    if (!hObj?.player) continue;
    const g = hObj.player.group;
    const dx = camera.position.x - g.position.x;
    const dz = camera.position.z - g.position.z;
    g.rotation.y = Math.atan2(dx, dz);
  }
}

// ★★★ 馬資源位置（依專案調整）
const HORSE_ROOT = '../public/horse/';
const HORSE_GLTF = 'result.gltf';
const HORSE_TEX = '../public/horse/tex/';

// ★ 引擎實例（移動/名次/完賽判定）
let race = null;

// ====== 相機建立與尺寸調整（透視） ======
function distanceForViewHeight(viewHeight, fovDeg, minAhead = 0) {
  const fov = THREE.MathUtils.degToRad(fovDeg);
  const d = viewHeight / (2 * Math.tan(fov * 0.5));
  return Math.max(d, minAhead || 0);
}
function applyVerticalFraming(pos, look) {
  const offsetY = (CAM.VIEW_HEIGHT * 0.5) * CAM.FRAMING_BIAS_Y;
  pos.y += offsetY; look.y += offsetY;
}
function placeWithFixedDir(lookX, eyeH, eyeZ) {
  const d = distanceForViewHeight(CAM.VIEW_HEIGHT, CAM.FOV_DEG, CAM.LOOK_AHEAD_MIN);
  const pos = new THREE.Vector3(lookX, eyeH, eyeZ);
  const dir = FIXED_DIR.clone().normalize();
  const look = pos.clone().add(dir.multiplyScalar(d));
  applyVerticalFraming(pos, look);
  return { pos, look };
}
function createCamera() {
  const aspect = canvas.clientWidth / canvas.clientHeight || 16 / 9;
  camera = new THREE.PerspectiveCamera(CAM.FOV_DEG, aspect, 0.1, 2000);
  const initX = CAM.SIDE_READY.x;
  const { pos, look } = placeWithFixedDir(initX, CAM.SIDE_READY.h, CAM.SIDE_READY.z);
  gameCam = new GameCamera(camera, {
    initialPos: [pos.x, pos.y, pos.z],
    initialLookAt: [look.x, look.y, look.z],
    followDistance: 0, height: 0, lerp: 0.12,
  });
}
function applyCameraResize() {
  const w = Math.min(window.innerWidth * 0.96, 1200);
  const h = Math.min(window.innerHeight * 0.9, 1200 / (16 / 9));
  renderer?.setSize(w, h, false);
  if (!camera) return;
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
function resize() { applyCameraResize(); }
window.addEventListener('resize', resize);

// ===== 初始化場景 =====
function initThree() {
  // 1) Renderer：交給 SceneSetup 建立
  renderer = createRenderer(canvas, { antialias: true, alpha: true, pixelRatioCap: 2 });

  // 2) Scene：預設黑色；setupLights 會載入 skybox 覆蓋 scene.background
  scene = createScene({ background: 0x000000 });

  // 3) Camera：維持你的透視相機配置
  createCamera();
  applyCameraResize();

  // 4) Lights + Skybox
  setupLights(scene, {
    ambientIntensity: 3.0,
    hemiIntensity: 0.65,
    hemiSky: 0xeaf2ff,
    hemiGround: 0x1f262d,
  });

  // 5) 場景地形/賽道
  buildField(scene, { trackLength, laneCount, startLineX, finishLineX, laneGap: 22 });

  // 6) Audio + UI
  audioSystem = new AudioSystem();
  ui = new UIController({
    providers: {
      getGameId: () => currentGameId,
      getRanking: () => getRankingLabels(),
      getTop5: () => getTop5Labels(),
    },
  });
  ui.register('ready', GameReadyView);
  ui.register('game', GameView);
  ui.register('finished', FinishedView);
  ui.show('ready');

  // 7) 時鐘與主迴圈
  clock = new THREE.Clock();
  animate();
}

// ★ 建立 11 匹馬（用 HorsePlayer）
async function loadHorses() {
  const result = await loadHorsesAsync(scene, {
    laneCount, startLineX, HORSE_ROOT, HORSE_GLTF, HORSE_TEX,
    onProgress: reportProgress
  });
  horses = result.horses;
  minLaneZ = result.minLaneZ;
  maxLaneZ = result.maxLaneZ;
  log(`[Ready] laneZ range: min=${minLaneZ}, max=${maxLaneZ}`);

  // 初始化 RaceEngine（把工具函式與邊界傳給它）
  race = new RaceEngine({
    laneCount, startLineX, finishLineX, finishDetectX,
    noise, randFloat, clamp, lerp,
    log,
  });
  race.initWithHorses(horses);
}

// ===== 工具：讀/寫馬的位置 =====
const getHorse = (i) => horses[i]?.player;
const getHorseX = (iOrHorse) => {
  const p = typeof iOrHorse === 'number' ? getHorse(iOrHorse) : iOrHorse?.player || iOrHorse;
  return p?.group?.position?.x ?? 0;
};
const setHorseRot = (i, faceRight = true) => {
  const p = getHorse(i);
  if (!p) return;
  p.group.rotation.set(0, faceRight ? Math.PI / 2 : -Math.PI / 2, 0);
};

// 排名 / 領先（僅給相機/備援用；真實名次由 RaceEngine 管）
function computeLeader() {
  let maxX = -Infinity, bestIndex = -1;
  for (let i = 0; i < horses.length; i++) {
    const x = getHorseX(i);
    if (x > maxX) { maxX = x; bestIndex = i; }
  }
  return bestIndex >= 0 ? horses[bestIndex] : null;
}

// —— UI 標籤工具（以 RaceEngine.finalRank 為主）
const labelOfNumber = (n) => `${n}`;

// UI：先 finalRank，再補未完賽者（依 x 即時排序）
function getRankingLabels() {
  const finalRank = race?.getFinalRank?.() ?? [];
  const fixedLabels = finalRank.map(labelOfNumber);
  const fixedSet = new Set(finalRank);
  const remainIdx = [];
  for (let i = 0; i < laneCount; i++) {
    const num = i + 1;
    if (!fixedSet.has(num)) remainIdx.push(i);
  }
  remainIdx.sort((a, b) => getHorseX(b) - getHorseX(a));
  const dynamicLabels = remainIdx.map(i => `${i + 1}`);
  return fixedLabels.concat(dynamicLabels);
}

// Top5：只讀 finalRank 前五（不足就顯示目前已完賽數量）
function getTop5Labels() {
  const finalRank = race?.getFinalRank?.() ?? [];
  return finalRank.slice(0, 5).map(labelOfNumber);
}

function getTop5FromFinalRank() {
  return this.forcedTop5Rank;
}

// ===== 相機控制（固定視角；Pause 保持當前畫面） =====
function updateCamera() {
  if (gameState === STATE.Paused) return;

  // 在 animate() 或 updateCamera() 每幀更新距離浮層
  const dNow = distanceForViewHeight(CAM.VIEW_HEIGHT, CAM.FOV_DEG, CAM.LOOK_AHEAD_MIN);
  editTool?.update(dNow, gameState);

  const gotoPose = (lookX, h, z, lerp) => {
    const { pos, look } = placeWithFixedDir(lookX, h, z);
    camera.position.lerp(pos, lerp);
    camera.lookAt(look);
  };

  if (gameState === STATE.Ready) {
    gotoPose(startLineX, CAM.SIDE_READY.h, CAM.SIDE_READY.z, CAM.SIDE_READY.lerp);
    return;
  }

  if (gameState === STATE.Running) {
    const target = race?.getLeader?.() || computeLeader();
    if (target) {
      const x = getHorseX(target);
      gotoPose(x, CAM.SIDE_RUN.h, CAM.SIDE_RUN.z, 1);
    }
    return;
  }

  if (gameState === STATE.Finished) {
    if (race?.isEveryoneFinished?.()) {
      if (!allArrivedShown) {
        // ★★★ 完賽 → 進頒獎：建台 → 佈馬 → 隱藏其他 → 鏡頭拉近
        const top5Numbers = (race?.getFinalRank?.() ?? []).slice(0, 5);
        ensurePodium();
        placeTop5OnPodium();
        setOnlyTop5Visible(top5Numbers);
        moveCameraToAward();
        orientTop5ToCamera();

        ui?.show?.('finished');
        allArrivedShown = true;
        parent?.postMessage?.({
          type: 'game:finished',
          gameId: currentGameId,
          results: getRankingLabels(), // 等於 finalRank + 動態（若有）
          top5: getTop5Labels(),
        }, '*');
      }
    } else {
      gotoPose(finishLineX, CAM.SIDE_FIN.h, CAM.SIDE_FIN.z, CAM.SIDE_FIN.lerp);
    }
  }
}

let allArrivedShown = false;

// ===== 頒獎鏡頭（透視模式拉近） =====
function moveCameraToAward() {
  const s = PODIUM_SCALE;

  // 看向頒獎台中心（賽道中段 X、Z=0），你前面已把頒獎台移到 podiumMidX
  const look = new THREE.Vector3(podiumMidX, CAM.AWARD.LOOK.y * s, 0);

  // 基準距離（視野幾何）× 縮放（ZOOM）× 自訂距離倍率（DIST_SCALE）
  const baseD = distanceForViewHeight(CAM.VIEW_HEIGHT, CAM.FOV_DEG, CAM.LOOK_AHEAD_MIN);
  const r = (baseD / CAM.AWARD.ZOOM) * (CAM.AWARD.DIST_SCALE ?? 1);

  // ★ 用方位角（水平角）決定「繞著 look 的水平位置」
  // 0度 = 從 -X 看向 look（正面）；90度 = 從 +Z 側面；-90度 = 從 -Z 側面
  const az = THREE.MathUtils.degToRad(CAM.AWARD.AZIMUTH_DEG ?? 0);
  const offsetX = -r * Math.cos(az);
  const offsetZ = r * Math.sin(az);

  camera.position.set(look.x + offsetX, CAM.AWARD.POS.y * s, look.z + offsetZ);
  camera.lookAt(look);
}

// ===== 主迴圈 =====
function animate() {
  if (disposed) return;
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.elapsedTime;

  if (gameState === STATE.Running || (gameState === STATE.Finished && !(race?.isEveryoneFinished?.()))) {
    // ★ 核心：把移動/名次/完賽判定交給 RaceEngine
    const res = race.tick(dt, t);

    // 第一名剛抵達 → 轉入 Finished（等待全員到線）
    if (gameState !== STATE.Finished && res.firstHorseJustFinished) {
      gameState = STATE.Finished;
      log('[State] Finished (waiting all horses reach the line)');
    }
  } else if (gameState === STATE.Ready) {
    // 倒數期間：執行就位補間
    if (standbyPlan && !standbyPlan.done) {
      const now = clock.elapsedTime;
      let allDone = true;
      for (const it of standbyPlan.items) {
        const p = getHorse(it.i); if (!p) continue;
        const a = THREE.MathUtils.clamp((now - it.t0) / it.dur, 0, 1);
        p.group.position.lerpVectors(it.from, it.to, a);
        const dirRight = (it.to.x - it.from.x) >= 0;
        setHorseRot(it.i, dirRight);
        p.update(dt);
        if (a < 1) allDone = false;
        else { p.playIdle01(true, 0.15); setHorseRot(it.i, true); }
      }
      standbyPlan.done = allDone;
    } else {
      for (let i = 0; i < laneCount; i++) getHorse(i)?.update(dt);
    }
  }

  updateCamera();
  ui?.tick?.();
  renderer.render(scene, camera);
  canvas.classList.toggle('paused', gameState === STATE.Paused);
}

// ===== 事件 & Lifecycle =====
function doStartRace() {
  // ★★★ 新局前清理：移除頒獎台＋顯示全部馬
  destroyPodium();
  showAllHorses();

  // 回到起跑點＋面向右
  for (let i = 0; i < laneCount; i++) {
    const hObj = horses[i];
    if (!hObj?.player) continue;
    hObj.player.group.position.copy(hObj.startPos);
    setHorseRot(i, true);
  }
  // 播放跑步
  for (let i = 0; i < laneCount; i++) {
    const h = getHorse(i);
    if (h?.isLoaded) {
      h.playRun(true, 0.2, 7);
      h.playRun(true, 0.2, 7);
    }
  }

  // 顯示狀態重置
  allArrivedShown = false;
  leader = null;

  // 交由 RaceEngine 管理整局參數（包含 SlowMo/Lock/Sprint/Rhythm/完賽表）
  race.startRace(clock.elapsedTime, forcedTop5Rank, RACE.durationSec);

  gameState = STATE.Running;
  ui?.show?.('game');
  log('[State] Running | target duration =', RACE.durationSec ? `${RACE.durationSec.toFixed(2)}s` : '(auto)');
}

// 整局時長控制（持續沿用你的設定）
const RACE = {
  durationMinSec: 22,
  durationMaxSec: 28,
  durationSec: null,  // Running → 第一名過線的時間
};

// 訊息 API：host 可帶入 payload { gameid, rank, countdown, durationMinSec, durationMaxSec }
function onGameStart(gameid, rank, countdown, durationMinSec, durationMaxSec) {
  if (gameState === STATE.Finished && allArrivedShown) return;
  if (!(gameState === STATE.Ready || gameState === STATE.Paused)) return;

  if (typeof gameid === 'string' && gameid.trim()) {
    currentGameId = gameid.trim();
    log(`[Start] use external gameId=${currentGameId}`);
  }

  // 驗證/修正 forcedTop5Rank（1..11，不重複，取前 5）
  if (Array.isArray(rank) && rank.length >= 5) {
    const cleaned = [];
    for (const n of rank) {
      const v = clamp(n | 0, 1, laneCount);
      if (!cleaned.includes(v)) cleaned.push(v);
      if (cleaned.length >= 5) break;
    }
    forcedTop5Rank = (cleaned.length === 5) ? cleaned : null;
    log('[Start] forcedTop5Rank=', forcedTop5Rank ? forcedTop5Rank.join(',') : '(natural)');
  } else {
    forcedTop5Rank = null;
  }

  // 整局時長（可覆寫預設）
  if (Number.isFinite(durationMinSec)) RACE.durationMinSec = Math.max(10, durationMinSec);
  if (Number.isFinite(durationMaxSec)) RACE.durationMaxSec = Math.max(RACE.durationMinSec + 1, durationMaxSec);
  RACE.durationSec = randFloat(RACE.durationMinSec, RACE.durationMaxSec);

  // Ready 畫面與倒數（關閉等待面板 → 倒數 → 開始）
  ui?.show?.('ready');
  window.GameReadyViewAPI?.hideWaitingPanel?.();

  const secs = Math.max(0, Math.floor(countdown || 0));
  if (secs > 0) {
    playerStandby(secs);
    window.GameReadyViewAPI?.startCountdown?.(secs, () => doStartRace());
  } else {
    doStartRace();
  }
}

// 倒數期間：所有馬 Walk 回到起跑點，剩 1 秒就位
function playerStandby(secs) {
  const total = Math.max(0, Math.floor(secs || 0));
  const dur = Math.max(0, total - 1);
  if (dur === 0) {
    for (let i = 0; i < laneCount; i++) {
      const hObj = horses[i]; if (!hObj?.player) continue;
      hObj.player.group.position.copy(hObj.startPos);
      setHorseRot(i, true);
      hObj.player.playIdle01(true, 0.15);
    }
    standbyPlan = { items: [], done: true };
    return;
  }
  const t0 = clock.elapsedTime;
  const items = [];
  for (let i = 0; i < laneCount; i++) {
    const hObj = horses[i]; if (!hObj?.player) continue;
    const from = hObj.player.group.position.clone();
    const to = hObj.startPos.clone();
    const faceRight = (to.x - from.x) >= 0;
    setHorseRot(i, faceRight);
    hObj.player.playWalk(true, 0.15, 2, Math.random());
    items.push({ i, from, to, t0, dur });
  }
  standbyPlan = { items, done: false };
}

function onGamePause() {
  if (gameState === STATE.Running) {
    gameState = STATE.Paused;
    log('[State] Paused');
  }
}

let countdownOverlay; // 若你的其他模組會塞此節點，保留避免報錯

function onGameEnd() {
  log('[Game] End & dispose]');

  // 顯示狀態重置
  leader = null;
  allArrivedShown = false;

  // ★ 清理頒獎台，避免殘留
  destroyPodium();

  disposed = true;
  window.removeEventListener('message', onMsg);
  window.removeEventListener('resize', resize);
  countdownOverlay?.remove();
  editTool?.destroy?.();
  ui?.destroy?.();
  if (renderer) { renderer.dispose(); renderer.forceContextLoss?.(); }
}

// 訊息處理
function onMsg(ev) {
  const msg = ev.data; if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'host:start': {
      const p = msg.payload || {};
      onGameStart(p.gameid ?? p.gameId, p.rank, p.countdown, p.durationMinSec, p.durationMaxSec);
      break;
    }
    case 'host:pause': onGamePause(); break;
    case 'host:end': onGameEnd(); break;
    case 'camera:config': gameCam?.configure(msg.payload || {}); break;
  }
}
window.addEventListener('message', onMsg);

// ===== 啟動 =====
(async function boot() {
  try {
    reportProgress(5);
    initThree();
    reportProgress(20);

    await buildRoadBetween(scene, {
      startX: startLineX,
      endX: finishLineX,
      laneCount,
      segments: 3,
      extraSegments: 2,
      laneGap: 6,
      baseY: -20,
      addLaneLines: true,
      lineThickness: 0.3,
      lineLength: 100000,
      lineColor: 0xffffff,
      lineYOffset: 0.02,
    });

    reportProgress(40);

    await loadHorses();
    reportProgress(95);
    reportProgress(100);
    reportReady();
    banner('three.js + 馬匹載入完成', true);

    // 在 boot() 裡（initThree() 後）
    editTool = mountEditTool(false, { getCAM, getCamera, getDirVec, startLineX });

  } catch (e) {
    reportError(e); banner('初始化失敗', false); log('[Boot Error]', e);
    if (location.protocol === 'file:') { log('提示：請改用本機 HTTP 伺服器（例如 `npx http-server`）。'); }
  }
})();
