// 主要遊戲腳本：11 匹馬、Lock/SlowMo 解耦、強制前五名次、UI 以 finalRank 為主
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';
import { GameCamera } from './systems/GameCamera.js';
import { AudioSystem } from './systems/AudioSystem.js';
import { buildField } from './FieldBuilder.js';
import { buildRoadBetween } from './TrackBuilder.js';

import { UIController } from './systems/ui/UIController.js';
import { GameReadyView } from './systems/ui/views/GameReadyView.js';
import { GameView } from './systems/ui/views/GameView.js';
import { FinishedView } from './systems/ui/views/FinishedView.js';

// ★ HorsePlayer
import { createRenderer, createScene, setupLights } from './SceneSetup.js';
import { loadHorsesAsync } from './systems/HorsesFactory.js';

// ===== 小工具 =====
const $log = document.getElementById('log');
const canvas = document.getElementById('three-canvas');
const log = (...a) => { if ($log) $log.textContent += a.join(' ') + '\n'; console.log(...a); };
const reportProgress = (v) => parent?.postMessage({ type: 'game:progress', value: v }, '*');
const reportReady = () => parent?.postMessage({ type: 'game:ready' }, '*');
const reportError = (e) => parent?.postMessage({ type: 'game:error', error: String(e) }, '*');
const banner = (msg, ok = true) => { const d = document.createElement('div'); d.className = 'banner ' + (ok ? 'ok' : 'err'); d.textContent = msg; document.documentElement.appendChild(d); setTimeout(() => d.remove(), 3600); };

let currentGameId = '';

// ===== 狀態機 =====
const STATE = { Ready: 'Ready', Running: 'Running', Paused: 'Paused', Finished: 'Finished' };
let gameState = STATE.Ready;

// ===== 場景物件 / 遊戲資料 =====
let renderer, scene, camera, clock;
let horses = []; // { player: HorsePlayer, startPos: THREE.Vector3, laneZ:number, faceRight:boolean }
const laneCount = 11;
const trackLength = 1000;
const startLineX = -trackLength / 2;
const finishLineX = trackLength / 2;
const finishDetectX = finishLineX - 0.5; // 衝線判定（略早一點）

let gameCam, audioSystem, ui;
let leader = null;
let disposed = false;

let minLaneZ = +Infinity;
let maxLaneZ = -Infinity;

let forcedTop5Rank;

// ====== 固定名次（抵達瞬間就寫入，存「馬號」1..11） ======
let finalRank = [];                 // e.g. [3,5,1,...]；只要越線就 push，一次性
const finishedTimes = Array(laneCount).fill(null); // 紀錄每匹完成時間（仍保留供驗證/頒獎）
let finalOrder = null;              // 全部到線後可由 finishedTimes 產出，但 UI 不再依賴它
let allArrivedShown = false;

// 數學小工具
const randFloat = (a, b) => a + Math.random() * (b - a);
const rand2 = (a, b) => Math.round(randFloat(a, b) * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOutCubic = (x) => (x < 0.5) ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

// ----- Ready 倒數期間：就位計畫 -----
let standbyPlan = null; // { items:[{i,from,to,t0,dur}], done }

// 速度/動畫（作為初始偏好速度）
const baseSpeeds = Array.from({ length: laneCount }, () => 100 + Math.random() * 20);
const noise = (t, i) => Math.sin(t * 5 + i * 1.3) * 0.3;

// ======== 透視攝影機參數（唯一模式） ========
const CAM = {
  VIEW_HEIGHT: 20,
  FRAMING_BIAS_Y: 0.30,
  FOV_DEG: 55,
  LOOK_AHEAD_MIN: 8,
  SIDE_READY: { x: startLineX, z: 90, h: 70, lerp: 0.18 },
  SIDE_RUN: { z: 90, h: 70, lerp: 0.18 },
  SIDE_FIN: { x: finishLineX, z: 90, h: 70, lerp: 0.15 },
  AWARD: {
    ZOOM: 2.0,
    POS: { x: 7, y: 5, z: 10 },
    LOOK: { x: 0, y: 2, z: 0 },
  },
};

// ===== 固定相機視角方向：正規化 (0, -0.5, -1) =====
const FIXED_DIR = new THREE.Vector3(0, -0.5, -1).normalize();

// ===== 頒獎台（在「賽場中間」且視角拉近）=====
const PODIUM_SCALE = 2;
const podiumX = 0, podiumZ = 0;
const podiumGap = 3.0;
const podiumHeights = [2.2, 1.7, 1.3, 1.0, 0.8];
let podiumGroup = null;

// ★★★ 馬資源位置（依專案調整）
const HORSE_ROOT = '../public/horse/';
const HORSE_GLTF = 'result.gltf';
const HORSE_TEX = '../public/horse/tex/';

// ===== SlowMotion（演出，與 Lock 解耦） =====
const SLOWMO = {
  enabled: true,
  triggerPct: 0.90, // 領先者 ≥90% 觸發
  rate: 0.3,
  active: false,
  triggeredAt: null,
};

// ===== Lock 名次校正（邏輯控制） =====
const LOCK_STAGE = { None: 'None', PreLock: 'PreLock', LockStrong: 'LockStrong', FinishGuard: 'FinishGuard' };
const LOCK = {
  preTriggerPct: 0.70,   // 弱校正開始（可略過）
  triggerPct: 0.75,   // ★ 主要觸發點（你指定）
  releasePct: 0.72,   // 遲滯（理論上不會回退）
  minGapBase: 0.60,   // 名次間最小車距（Lock 期間軟保護）
  minGapMax: 1.20,
  gapWidenFrom: 0.90,   // 進入末段時逐步放大最小車距，畫面更穩
  gapWidenTo: 1.00,
  // 名次回授增益（PreLock / LockStrong / FinishGuard）
  gain: {
    Pre: { boost: 0.20, brake: 0.15, pos: 0.020, forcedBoost: 0.60, forcedBrake: 0.80 },
    Strong: { boost: 0.90, brake: 0.70, pos: 0.050, forcedBoost: 1.20, forcedBrake: 1.20 },
    Guard: { boost: 0.30, brake: 0.25, pos: 0.030, forcedBoost: 0.80, forcedBrake: 0.90 },
  },
  // LockStrong 取消速度上限；其他階段保留
  noSpeedLimitInStrong: true,
};

let lockStage = LOCK_STAGE.None;

// ===== 競速引擎（一般參數） =====
const SPEED_CONF = {
  vMin: 60,
  vMax: 180,
  blend: 0.10,          // 靠攏 v* 的平滑係數
  noiseScaleStart: 1.0, // Start/Mid 視覺起伏
  noiseScaleSetup: 0.4, // Setup 降低起伏，便於對齊
  noiseScaleLock: 0.2,  // 任何 Lock 階段更穩
};

// —— 階段切分（只用於 start/mid/setup；Lock 改用獨立判定）
const PHASE_SPLITS = { start: 0.60, setup: 0.85, lock: 0.97 };

// —— 節奏調制：忽快忽慢（Lock 期間權重趨近 0，避免破壞名次收斂）
const RHYTHM_CONF = {
  segment: { durMin: 0.9, durMax: 1.4, multMin: 0.20, multMax: 3.0, easeSec: 0.25 },
  burst: { probPerSec: 0.45, ampMin: 0.06, ampMax: 0.10, durSec: 0.8, cooldownSec: 0.6 },
  weightByPhase: { start: 1.00, mid: 1.00, setup: 0.30, lock: 0.12 },
  bounds: { min: 0.75, max: 1.35 },
};

// 每匹馬各自的節奏狀態
const rhythmState = {
  segFrom: Array(laneCount).fill(1.0),
  segTo: Array(laneCount).fill(1.0),
  segT0: Array(laneCount).fill(0),
  segT1: Array(laneCount).fill(0),
  burstAmp: Array(laneCount).fill(0),
  burstT0: Array(laneCount).fill(-999),
  burstUntil: Array(laneCount).fill(-999),
  lastBurstEnd: Array(laneCount).fill(-999),
};

// 整局時長控制
const RACE = {
  durationMinSec: 22,
  durationMaxSec: 28,
  durationSec: null,  // Running → 第一名過線的時間
  startTime: null,    // 進入 Running 的時間（clock.elapsedTime）
  setupDone: false,
};

// 完賽時程表（Setup 段生成）
let finishSchedule = { T: Array(laneCount).fill(null) }; // 每匹馬預定完賽「絕對時間戳」
let speedState = { v: Array(laneCount).fill(0) };

// 衝刺狀態（在 mid/setup 才會生效；任何 Lock 階段不生效）
const SPRINT = {
  cooldownSec: 3.0,
  durMin: 0.8,
  durMax: 1.6,
  multMin: 1.15,
  multMax: 1.25,
  maxTimesPerHorse: 1,
  gapMin: 2.0,
  gapMax: 10.0,
  active: Array(laneCount).fill(false),
  until: Array(laneCount).fill(0),
  lastEndAt: Array(laneCount).fill(-999),
  usedTimes: Array(laneCount).fill(0),
};

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
const horseIndexFromNumber = (num) => clamp((num | 0) - 1, 0, laneCount - 1);

// 計算領先者賽程百分比（0..1+）
function getLeaderProgress() {
  const leadObj = leader || computeLeader();
  if (!leadObj) return 0;
  const x = getHorseX(leadObj);
  const pct = (x - startLineX) / (finishLineX - startLineX);
  return THREE.MathUtils.clamp(pct, 0, 1.5);
}

// ===== Lock 判定（與 SlowMo 解耦） =====
function updateLockStage() {
  const pct = getLeaderProgress();
  if (lockStage === LOCK_STAGE.None) {
    if (pct >= LOCK.preTriggerPct && pct < LOCK.triggerPct) {
      lockStage = LOCK_STAGE.PreLock;
    }
    if (pct >= LOCK.triggerPct) {
      lockStage = LOCK_STAGE.LockStrong;
    }
  } else if (lockStage === LOCK_STAGE.PreLock) {
    if (pct >= LOCK.triggerPct) {
      lockStage = LOCK_STAGE.LockStrong;
    } else if (pct < LOCK.releasePct) {
      lockStage = LOCK_STAGE.None;
    }
  }
  // LockStrong → FinishGuard 的切換在第一名過線時處理
}
function inAnyLock() { return lockStage !== LOCK_STAGE.None; }
function inStrongLock() { return lockStage === LOCK_STAGE.LockStrong; }

// ===== 最小車距（Lock 期間的軟保護，避免黏碰與抖動） =====
function dynamicMinGap() {
  const prog = clamp(getLeaderProgress(), 0, 1);
  const a = clamp((prog - LOCK.gapWidenFrom) / Math.max(1e-3, LOCK.gapWidenTo - LOCK.gapWidenFrom), 0, 1);
  return lerp(LOCK.minGapBase, LOCK.minGapMax, a);
}

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
  const look = pos.clone().add(FIXED_DIR.clone().multiplyScalar(d));
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
  // 1) Renderer：交給 SceneSetup 建立（維持 antialias/alpha 與 toneMapping 設定）
  renderer = createRenderer(canvas, {
    antialias: true,
    alpha: true,
    pixelRatioCap: 2,     // 與原本一致
  });

  // 2) Scene：預設黑色；注意：setupLights 內會載入 skybox 並覆蓋 scene.background
  //    如果你想要透明背景，可改成 createScene({ background: null })
  scene = createScene({ background: 0x000000 });

  // 3) Camera：維持你的透視相機配置
  createCamera();
  applyCameraResize();

  // 4) Lights + Skybox：與你現在邏輯一致（Ambient + Hemisphere）
  //    setupLights 會另外載入 'public/skybox/*.jpg' 作為 CubeTexture 背景
  setupLights(scene, {
    ambientIntensity: 3.0,
    hemiIntensity: 0.65,
    hemiSky: 0xeaf2ff,
    hemiGround: 0x1f262d,
  });

  // 5) 場景地形/賽道維持不變
  buildField(scene, { trackLength, laneCount, startLineX, finishLineX, laneGap: 6 });

  // 6) Audio + UI 維持不變
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
  horses   = result.horses;
  minLaneZ = result.minLaneZ;
  maxLaneZ = result.maxLaneZ;
  log(`[Ready] laneZ range: min=${minLaneZ}, max=${maxLaneZ}`);
}

// ===== 排名 / 完賽處理 =====
function computeLeader() {
  let maxX = -Infinity, bestIndex = -1;
  for (let i = 0; i < horses.length; i++) {
    const x = getHorseX(i);
    if (x > maxX) { maxX = x; bestIndex = i; }
  }
  return bestIndex >= 0 ? horses[bestIndex] : null;
}
function computeCurrentOrderIdx() {
  const idx = [...Array(laneCount).keys()];
  idx.sort((a, b) => getHorseX(b) - getHorseX(a));
  return idx;
}
function everyoneFinished() { return finishedTimes.every(t => t !== null); }

// ★ 越線瞬間：寫 finishedTimes + 鎖定 finalRank（馬號）
function stampFinish(i, t) {
  if (finishedTimes[i] != null) return;
  finishedTimes[i] = t;
  const horseNo = i + 1;
  log(`[Finish] ${horseNo} @ ${(t - RACE.startTime).toFixed(2)} sec`);
  finalRank.push(horseNo); // 固定名次立即確定 → UI 前段穩定
}

function buildFinalOrder() {
  const idx = [...Array(laneCount).keys()];
  idx.sort((a, b) => finishedTimes[a] - finishedTimes[b]);
  finalOrder = idx.map(i => horses[i]);
}

// —— UI 標籤工具
const labelOfNumber = (n) => `${n}`;

// UI：先 finalRank，再補未完賽者（依 x 即時排序）
function getRankingLabels() {
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
  return finalRank.slice(0, 5).map(labelOfNumber);
}

// ===== 頒獎台 =====
function ensurePodium() {
  if (podiumGroup) return;
  podiumGroup = new THREE.Group();
  scene.add(podiumGroup);
  for (let k = 0; k < 5; k++) {
    const height = podiumHeights[k] * PODIUM_SCALE;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(2.4 * PODIUM_SCALE, height, 2.4 * PODIUM_SCALE),
      new THREE.MeshPhongMaterial({ color: k === 0 ? 0xffd700 : (k === 1 ? 0xc0c0c0 : 0xcd7f32) })
    );
    const z = podiumZ + (k - 2) * podiumGap * PODIUM_SCALE;
    box.position.set(podiumX, height / 2, z);
    podiumGroup.add(box);
  }
}

// 頒獎採用 finalRank 前五（與 UI 一致）
function placeTop5OnPodium() {
  ensurePodium();
  const top5Numbers = finalRank.slice(0, 5);
  for (let k = 0; k < top5Numbers.length; k++) {
    const num = top5Numbers[k];
    const idx = horseIndexFromNumber(num);
    const hObj = horses[idx];
    if (!hObj) continue;
    const p = hObj.player;
    const height = podiumHeights[k] * PODIUM_SCALE;
    const z = podiumZ + (k - 2) * podiumGap * PODIUM_SCALE;
    p.group.position.set(podiumX, height, z);
    p.playIdle01(true, 0.15);
  }
}

// ===== 相機控制（固定視角；Pause 保持當前畫面） =====
function updateCamera() {
  if (gameState === STATE.Paused) return;

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
    const target = leader || computeLeader();
    if (target) {
      const x = getHorseX(target);
      gotoPose(x, CAM.SIDE_RUN.h, CAM.SIDE_RUN.z, 1);
    }
    return;
  }

  if (gameState === STATE.Finished) {
    if (everyoneFinished()) {
      if (!allArrivedShown) {
        buildFinalOrder();   // 保留：供其他流程參考
        placeTop5OnPodium();
        moveCameraToAward();
        ui?.show?.('finished');
        allArrivedShown = true;
        parent?.postMessage?.({
          type: 'game:finished',
          gameId: currentGameId,
          results: getRankingLabels(), // 等於 finalRank +（空）
          top5: getTop5Labels(),
        }, '*');
      }
    } else {
      gotoPose(finishLineX, CAM.SIDE_FIN.h, CAM.SIDE_FIN.z, CAM.SIDE_FIN.lerp);
    }
  }
}

// ===== 頒獎鏡頭（透視模式拉近） =====
function moveCameraToAward() {
  const s = PODIUM_SCALE;
  const look = new THREE.Vector3(CAM.AWARD.LOOK.x * s, CAM.AWARD.LOOK.y * s, CAM.AWARD.LOOK.z * s);
  const baseD = distanceForViewHeight(CAM.VIEW_HEIGHT, CAM.FOV_DEG, CAM.LOOK_AHEAD_MIN);
  const d = baseD / CAM.AWARD.ZOOM;
  camera.position.set(look.x - d, CAM.AWARD.POS.y * s, CAM.AWARD.POS.z * s);
  camera.lookAt(look);
}

// ====== 時間工具 ======
function nowSinceStart() {
  if (RACE.startTime == null) return 0;
  return Math.max(0, clock.elapsedTime - RACE.startTime);
}
function timePct() {
  if (!RACE.durationSec) return 0;
  return clamp(nowSinceStart() / RACE.durationSec, 0, 2);
}
function inPhase(name) {
  const t = timePct();
  if (name === 'start') return t < PHASE_SPLITS.start;
  if (name === 'mid') return t >= PHASE_SPLITS.start && t < PHASE_SPLITS.setup;
  if (name === 'setup') return t >= PHASE_SPLITS.setup && t < PHASE_SPLITS.lock;
  if (name === 'lock') return t >= PHASE_SPLITS.lock; // 僅作參考；實際 Lock 用獨立機制
  return false;
}

// ====== Setup：建立完賽時程表（前五時間依 forcedTop5Rank） ======
function buildFinishScheduleIfNeeded() {
  if (RACE.setupDone || !forcedTop5Rank || !RACE.durationSec || RACE.startTime == null) return;

  const jitter = randFloat(-0.15, 0.15);
  const T1 = RACE.startTime + RACE.durationSec + jitter;

  // 前五（依 forcedTop5Rank 順序）
  const top5Idx = forcedTop5Rank.map(horseIndexFromNumber);
  const gaps = [
    0.00,
    randFloat(0.25, 0.45),
    randFloat(0.45, 0.75),
    randFloat(0.75, 1.10),
    randFloat(1.10, 1.60),
  ];
  for (let k = 0; k < 5; k++) {
    const i = top5Idx[k];
    finishSchedule.T[i] = T1 + gaps[k];
  }

  // 其餘：落在 T5 之後 0.5~4.0 秒
  const T5 = T1 + gaps[4];
  for (let i = 0; i < laneCount; i++) {
    if (finishSchedule.T[i] != null) continue;
    finishSchedule.T[i] = T5 + randFloat(0.5, 4.0);
  }

  // 可行性微調（初步，避免早期就不可能追上；LockStrong 無上限速度，不再延後）
  for (let i = 0; i < laneCount; i++) {
    const p = getHorse(i); if (!p) continue;
    const x = p.group.position.x;
    const d = Math.max(0, finishLineX - x);
    const tLeft = Math.max(0.01, finishSchedule.T[i] - clock.elapsedTime);
    const vNeed = d / tLeft;
    if (vNeed > SPEED_CONF.vMax) {
      const extra = (vNeed - SPEED_CONF.vMax) / SPEED_CONF.vMax;
      finishSchedule.T[i] += Math.min(2.0, 0.5 + extra);
    }
  }

  RACE.setupDone = true;
  log('[Setup] Finish schedule generated. T1=', (T1 - RACE.startTime).toFixed(2), 'sec');
}

// ====== 名次目標與回授（Lock 期間核心） ======
function computeDesiredOrder() {
  // 期望順序：forcedTop5 在前，其餘按照「預定完賽時間」或「目前位置」排序
  const top5Idx = forcedTop5Rank ? forcedTop5Rank.map(horseIndexFromNumber) : [];
  const set = new Set(top5Idx);
  const others = [];
  for (let i = 0; i < laneCount; i++) if (!set.has(i)) others.push(i);

  // 其餘：優先用 finishSchedule.T（越早越前），若沒有就用當下位置
  others.sort((a, b) => {
    const Ta = finishSchedule.T[a] ?? Infinity;
    const Tb = finishSchedule.T[b] ?? Infinity;
    if (Ta !== Tb) return Ta - Tb;
    return getHorseX(b) - getHorseX(a);
  });

  return top5Idx.concat(others);
}

// 產生每個「期望名次 k=1..N」的目標位置 xTarget[k]（靠近終點並保持間距）
function computeShadowTargets(desiredOrder) {
  const delta = dynamicMinGap();
  const anchor = finishLineX - 0.25; // 目標隊列最前緣（稍微留一點距離，不直接貼線）
  const xTarget = Array(desiredOrder.length + 1).fill(anchor); // 1-based for readability
  for (let k = 2; k <= desiredOrder.length; k++) {
    xTarget[k] = xTarget[k - 1] - delta;
  }
  return xTarget;
}

// ★★★ A 修正點：名次誤差正負號與回授方向修正
// 回傳 Lock 期間對單匹的「速度倍率」(>1 加速、<1 減速)，融合名次誤差與位置誤差
function lockSpeedFactorFor(i, stageGain, desiredRankMap, currentRankMap, xTarget) {
  const currRank = currentRankMap[i]; // 1..N（數字越小越靠前）
  const wantRank = desiredRankMap[i]; // 1..N（數字越小越靠前）
  const eRank = currRank - wantRank;  // >0：目前在想要名次之後（落後），應加速；<0：目前超前，應減速

  // 名次回授：boost / brake（方向依據 eRank 修正後正確）
  let rankFactor;
  if (eRank > 0) {
    // 落後 → 加速
    rankFactor = 1 + stageGain.boost * eRank;
  } else if (eRank < 0) {
    // 超前 → 讓位（減速）
    rankFactor = 1 / (1 + stageGain.brake * Math.abs(eRank));
  } else {
    rankFactor = 1;
  }

  // 位置回授：依「目標站位」與當前位置差距微調，避免上下位重疊
  const x = getHorseX(i);
  const xt = xTarget[wantRank];
  const ePos = xt - x; // 正值：該更靠前；負值：該稍微後退
  const posFactor = clamp(1 + stageGain.pos * ePos, 0.4, 2.5);

  // 強化規則：非前五混入前五 → 強剎；在前五卻掉出前五 → 強推
  const inTop5 = forcedTop5Rank ? forcedTop5Rank.map(horseIndexFromNumber).includes(i) : false;
  const currTop5 = currRank <= 5;
  let forcedFactor = 1;
  if (!inTop5 && currTop5) {
    // 不在前五名單卻跑在前五 → 強制讓位
    const severity = (6 - currRank); // 越靠前越重
    forcedFactor = 1 / (1 + stageGain.forcedBrake * Math.max(0, severity));
  } else if (inTop5 && currRank > 5) {
    // 在前五名單卻不在前五 → 強制補位
    const severity = (currRank - 5);
    forcedFactor = 1 + stageGain.forcedBoost * Math.max(0, severity);
  }

  return clamp(rankFactor * posFactor * forcedFactor, 0.25, 3.5);
}

// ★★★ B 修正點：最小車距保護不阻擋「應該超車」的對子
// Lock 期間：柔性的最小車距保護（針對「當前排序」），若期望排序要求後車應超車，則不壓後車、改微降前車
function applySoftSeparation(currentOrderIdx, velocities, desiredRankMap) {
  const delta = dynamicMinGap();
  for (let r = 1; r < currentOrderIdx.length; r++) {
    const iFollower = currentOrderIdx[r];
    const iLeader = currentOrderIdx[r - 1];
    const xF = getHorseX(iFollower);
    const xL = getHorseX(iLeader);
    if (xF > xL - delta) {
      const shouldOvertake =
        desiredRankMap &&
        desiredRankMap[iFollower] != null &&
        desiredRankMap[iLeader] != null &&
        desiredRankMap[iFollower] < desiredRankMap[iLeader]; // 期望排序：後車應在前

      if (shouldOvertake) {
        // 給通道：不壓後車，微降前車避免擋路（穩健係數 0.96）
        velocities[iLeader] = Math.max(0, velocities[iLeader] * 0.96);
      } else {
        // 正常情況：維持最小距離，壓後車（跟車速度略低於前車）
        velocities[iFollower] = Math.min(velocities[iFollower], Math.max(0, velocities[iLeader] * 0.92));
      }
    }
  }
}

// ====== Sprint：mid/setup；任何 Lock 階段不生效 ======
function tryTriggerSprint(nowSec) {
  if (inAnyLock()) return; // Lock 期間關閉
  if (!(inPhase('mid') || inPhase('setup'))) return;

  const order = computeCurrentOrderIdx();
  for (let rank = 1; rank < order.length; rank++) {
    const i = order[rank];
    const j = order[rank - 1];
    const myX = getHorseX(i);
    const tgtX = getHorseX(j);
    const gap = tgtX - myX;
    if (SPRINT.active[i]) continue;
    if (SPRINT.usedTimes[i] >= SPRINT.maxTimesPerHorse) continue;
    if (nowSec - SPRINT.lastEndAt[i] < SPRINT.cooldownSec) continue;
    if (gap < SPRINT.gapMin || gap > SPRINT.gapMax) continue;
    const myV = speedState.v[i] || baseSpeeds[i];
    const tgtV = speedState.v[j] || baseSpeeds[j];
    const want = (myV <= tgtV) || (Math.random() < 0.35);
    if (!want) continue;
    const dur = randFloat(SPRINT.durMin, SPRINT.durMax);
    SPRINT.active[i] = true;
    SPRINT.until[i] = nowSec + dur;
    SPRINT.usedTimes[i] += 1;
    log(`[Sprint] ${i + 1} start (dur=${dur.toFixed(2)}s, gap=${gap.toFixed(2)})`);
  }
}
function updateSprintLifecycle(nowSec) {
  for (let i = 0; i < laneCount; i++) {
    if (SPRINT.active[i] && nowSec >= SPRINT.until[i]) {
      SPRINT.active[i] = false;
      SPRINT.lastEndAt[i] = nowSec;
      log(`[Sprint] ${i + 1} end`);
    }
  }
}

// ====== Rhythm：忽快忽慢（Lock 期間權重→極低） ======
function ensureNextSegment(i, nowSec) {
  if (nowSec < rhythmState.segT1[i]) return;
  const from = rhythmState.segTo[i];
  const to = randFloat(RHYTHM_CONF.segment.multMin, RHYTHM_CONF.segment.multMax);
  const dur = randFloat(RHYTHM_CONF.segment.durMin, RHYTHM_CONF.segment.durMax);
  rhythmState.segFrom[i] = from;
  rhythmState.segTo[i] = to;
  rhythmState.segT0[i] = nowSec;
  rhythmState.segT1[i] = nowSec + dur;
}
function evalSegmentMultiplier(i, nowSec) {
  const t0 = rhythmState.segT0[i], t1 = rhythmState.segT1[i];
  const from = rhythmState.segFrom[i], to = rhythmState.segTo[i];
  const dur = Math.max(0.001, t1 - t0);
  const x = clamp((nowSec - t0) / dur, 0, 1);
  const e = easeInOutCubic(x < RHYTHM_CONF.segment.easeSec / dur ? (x * dur / RHYTHM_CONF.segment.easeSec) : x);
  return lerp(from, to, e);
}
function maybeTriggerBurst(i, nowSec) {
  if (nowSec - rhythmState.lastBurstEnd[i] < RHYTHM_CONF.burst.cooldownSec) return;
  if (inAnyLock()) return; // Lock 期間不再觸發脈衝，避免干擾
  const probThisFrame = RHYTHM_CONF.burst.probPerSec * (1 / 60);
  if (Math.random() < probThisFrame) {
    rhythmState.burstAmp[i] = randFloat(RHYTHM_CONF.burst.ampMin, RHYTHM_CONF.burst.ampMax);
    rhythmState.burstT0[i] = nowSec;
    rhythmState.burstUntil[i] = nowSec + RHYTHM_CONF.burst.durSec;
    rhythmState.lastBurstEnd[i] = rhythmState.burstUntil[i];
  }
}
function evalBurstMultiplier(i, nowSec) {
  const t0 = rhythmState.burstT0[i];
  const t1 = rhythmState.burstUntil[i];
  if (nowSec > t1) return 0;
  const a = rhythmState.burstAmp[i];
  const x = clamp((nowSec - t0) / Math.max(0.001, t1 - t0), 0, 1);
  if (x < 0.2) return a * (x / 0.2);
  const y = (x - 0.2) / 0.8;
  const easeOut = 1 - Math.pow(1 - y, 3);
  return a * (1 - easeOut);
}
function rhythmWeightNow() {
  if (inAnyLock()) return 0.05; // 極低權重
  if (inPhase('setup')) return RHYTHM_CONF.weightByPhase.setup;
  if (inPhase('mid')) return RHYTHM_CONF.weightByPhase.mid;
  return RHYTHM_CONF.weightByPhase.start;
}
function updateRhythm(i, nowSec) {
  ensureNextSegment(i, nowSec);
  maybeTriggerBurst(i, nowSec);
  const segMul = evalSegmentMultiplier(i, nowSec);
  const burst = evalBurstMultiplier(i, nowSec);
  let m = segMul * (1 + burst);
  m = clamp(m, RHYTHM_CONF.bounds.min, RHYTHM_CONF.bounds.max);
  const w = rhythmWeightNow();
  return lerp(1.0, m, w);
}

// ===== 主迴圈 =====
function animate() {
  if (disposed) return;
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.elapsedTime;

  // SlowMo（視覺演出）：與 Lock 解耦
  if (gameState === STATE.Running && SLOWMO.enabled && !SLOWMO.active) {
    const pct = getLeaderProgress();
    if (pct >= SLOWMO.triggerPct) {
      SLOWMO.active = true;
      SLOWMO.triggeredAt = t;
      log(`[SlowMo] triggered at ${Math.round(pct * 100)}% (rate=${SLOWMO.rate})`);
    }
  }
  const dtScale = (SLOWMO.active ? SLOWMO.rate : 1);

  if (gameState === STATE.Running || (gameState === STATE.Finished && !everyoneFinished())) {
    // Lock 觸發更新
    updateLockStage();

    const elapsed = nowSinceStart();
    tryTriggerSprint(elapsed);
    updateSprintLifecycle(elapsed);

    // Setup：生成前五目標時間
    if (inPhase('setup')) buildFinishScheduleIfNeeded();

    // —— Lock 期間需要的中間資料
    const isLocking = inAnyLock();
    const stageGain = (lockStage === LOCK_STAGE.PreLock) ? LOCK.gain.Pre
      : (lockStage === LOCK_STAGE.LockStrong) ? LOCK.gain.Strong
        : (lockStage === LOCK_STAGE.FinishGuard) ? LOCK.gain.Guard
          : null;

    const currOrder = computeCurrentOrderIdx();
    const currRankMap = {}; // index → rank(1..N)
    for (let r = 0; r < currOrder.length; r++) currRankMap[currOrder[r]] = r + 1;

    const desiredOrder = (forcedTop5Rank && isLocking) ? computeDesiredOrder() : currOrder.slice();
    const desiredRankMap = {}; // index → desired rank
    for (let r = 0; r < desiredOrder.length; r++) desiredRankMap[desiredOrder[r]] = r + 1;
    const xTarget = (isLocking) ? computeShadowTargets(desiredOrder) : null;

    // —— 每匹馬速度計算
    const nextVelocity = Array(laneCount).fill(0);

    for (let i = 0; i < laneCount; i++) {
      const p = getHorse(i); if (!p) continue;

      // 視覺噪聲：Lock 期間最穩
      const noiseScale = isLocking ? SPEED_CONF.noiseScaleLock
        : inPhase('setup') ? SPEED_CONF.noiseScaleSetup
          : SPEED_CONF.noiseScaleStart;

      // 基礎 v*：Setup 後用剩距/剩時；Setup 前用 baseline
      let vStar;
      if (RACE.setupDone && finishSchedule.T[i] != null) {
        const x = p.group.position.x;
        const d = Math.max(0, finishLineX - x);
        const tau = Math.max(0.01, finishSchedule.T[i] - t);
        vStar = d / tau; // 「剩距/剩時」的時間一致性控制
      } else {
        vStar = baseSpeeds[i];
      }

      // 節奏倍率（Lock 期間權重趨近 0，避免破壞對齊）
      const m = updateRhythm(i, nowSinceStart());
      vStar *= m;

      // Lock 名次回授（融合名次/位置），強制把前五修回指定順序
      if (forcedTop5Rank && isLocking && stageGain) {
        const factor = lockSpeedFactorFor(i, stageGain, desiredRankMap, currRankMap, xTarget);
        vStar *= factor;
      } else {
        // 非 Lock 期間，mid/setup 若觸發 Sprint 才加成
        if (SPRINT.active[i] && (inPhase('mid') || inPhase('setup'))) {
          const mult = randFloat(SPRINT.multMin, SPRINT.multMax);
          vStar *= mult;
        }
      }

      // 速度夾限：LockStrong 取消上限
      if (inStrongLock() && LOCK.noSpeedLimitInStrong) {
        vStar = Math.max(SPEED_CONF.vMin, vStar);
      } else {
        vStar = clamp(vStar, SPEED_CONF.vMin, SPEED_CONF.vMax);
      }

      // 平滑靠攏
      const vPrev = speedState.v[i] || baseSpeeds[i];
      const vNow = vPrev + (vStar - vPrev) * SPEED_CONF.blend;
      nextVelocity[i] = vNow;

      // 先暫存位置噪聲更新，實際位置於分離保護後統一更新
      p.group.position.y = Math.max(0, Math.abs(noise(t, i)) * 0.2 * noiseScale);
    }

    // Lock 期間的柔性最小車距保護（A/B 修正後會參照 desiredRankMap）
    if (isLocking) applySoftSeparation(currOrder, nextVelocity, desiredRankMap);

    // 套用速度 & 動畫更新
    for (let i = 0; i < laneCount; i++) {
      const p = getHorse(i); if (!p) continue;
      speedState.v[i] = nextVelocity[i];
      p.group.position.x += nextVelocity[i] * dt * dtScale;
      p.update(dt * dtScale);

      // 完賽判定（首次越線 → finalRank）
      if (finishedTimes[i] == null && p.group.position.x >= finishDetectX) {
        stampFinish(i, t);
      }
    }

    // 領先者更新
    if (!everyoneFinished()) {
      const newLeader = computeLeader();
      if (newLeader && newLeader !== leader) leader = newLeader;
    }

    // 第一名抵達 → 轉入 FinishedGuard（若當前在 Lock 中），並關閉慢動作
    if (gameState !== STATE.Finished && finishedTimes.some(v => v !== null)) {
      gameState = STATE.Finished;
      if (SLOWMO.active) {
        SLOWMO.active = false;
        log('[SlowMo] deactivated (first horse finished)');
      }
      if (lockStage === LOCK_STAGE.PreLock || lockStage === LOCK_STAGE.LockStrong) {
        lockStage = LOCK_STAGE.FinishGuard;
        log('[Lock] FinishGuard (maintain order until all finished)');
      }
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
        else { p.playIdle01(true, 0.1); setHorseRot(it.i, true); }
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
  // 回到起跑點＋面向右
  for (let i = 0; i < laneCount; i++) {
    const hObj = horses[i];
    if (!hObj?.player) continue;
    hObj.player.group.position.copy(hObj.startPos);
    setHorseRot(i, true);
  }
  for (let i = 0; i < laneCount; i++) {
    const h = getHorse(i);
    if (h?.isLoaded) {
      h.playRun(true, 0.2, 7);
      h.playRun(true, 0.2, 7);
    }
  }

  // 狀態與計時初始化
  SLOWMO.active = false; SLOWMO.triggeredAt = null;
  lockStage = LOCK_STAGE.None;

  speedState.v = baseSpeeds.slice();

  // Rhythm 初始化
  const nowSec = 0;
  for (let i = 0; i < laneCount; i++) {
    rhythmState.segFrom[i] = 1.0;
    rhythmState.segTo[i] = randFloat(RHYTHM_CONF.segment.multMin, RHYTHM_CONF.segment.multMax);
    rhythmState.segT0[i] = nowSec;
    rhythmState.segT1[i] = nowSec + randFloat(RHYTHM_CONF.segment.durMin, RHYTHM_CONF.segment.durMax);
    rhythmState.burstAmp[i] = 0;
    rhythmState.burstT0[i] = -999;
    rhythmState.burstUntil[i] = -999;
    rhythmState.lastBurstEnd[i] = -999;
  }

  // Sprint 初始化
  SPRINT.active.fill(false); SPRINT.until.fill(0); SPRINT.lastEndAt.fill(-999); SPRINT.usedTimes.fill(0);

  // Finish schedule 初始化
  finishSchedule.T.fill(null);
  RACE.setupDone = false;
  RACE.startTime = clock.elapsedTime;

  gameState = STATE.Running;
  ui?.show?.('game');
  log('[State] Running | target duration =', RACE.durationSec ? `${RACE.durationSec.toFixed(2)}s` : '(auto)');
}

/**
 * onGameStart：可帶入 forcedTop5Rank、倒數、時長上下限
 * @param {string} gameid
 * @param {number[]} rank - 長度=5（1..11 不重複），最終前五名順序
 * @param {number} countdown
 * @param {number} durationMinSec
 * @param {number} durationMaxSec
 */
function onGameStart(gameid, rank, countdown, durationMinSec, durationMaxSec) {
  if (gameState === STATE.Finished && allArrivedShown) return;
  if (!(gameState === STATE.Ready || gameState === STATE.Paused)) return;

  if (typeof gameid === 'string' && gameid.trim()) {
    currentGameId = gameid.trim();
    log(`[Start] use external gameId=${currentGameId}`);
  }

  // 驗證/修正 forcedTop5Rank
  if (Array.isArray(rank) && rank.length >= 5) {
    const cleaned = [];
    for (const n of rank) {
      const v = clamp(n | 0, 1, laneCount);
      if (!cleaned.includes(v)) cleaned.push(v);
      if (cleaned.length >= 5) break;
    }
    if (cleaned.length === 5) {
      forcedTop5Rank = cleaned;
      log('[Start] forcedTop5Rank=', forcedTop5Rank.join(','));
    } else {
      forcedTop5Rank = null;
      log('[Start] invalid forcedTop5Rank; fallback to natural race');
    }
  } else {
    forcedTop5Rank = null;
  }

  // 整局時長（可覆寫預設）
  if (Number.isFinite(durationMinSec)) RACE.durationMinSec = Math.max(10, durationMinSec);
  if (Number.isFinite(durationMaxSec)) RACE.durationMaxSec = Math.max(RACE.durationMinSec + 1, durationMaxSec);
  RACE.durationSec = randFloat(RACE.durationMinSec, RACE.durationMaxSec);

  // 重置固定名次與相關狀態（避免跨局殘留）
  finalRank.length = 0;
  for (let i = 0; i < laneCount; i++) finishedTimes[i] = null;
  finalOrder = null;
  allArrivedShown = false;
  leader = null;

  // Ready 畫面與倒數
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
    hObj.player.playWalk(true, 0.15, 1, Math.random());
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
function onGameEnd() {
  log('[Game] End & dispose]');

  // 清空固定名次與狀態
  finalRank.length = 0;
  for (let i = 0; i < laneCount; i++) finishedTimes[i] = null;
  finalOrder = null;
  allArrivedShown = false;
  leader = null;
  lockStage = LOCK_STAGE.None;

  disposed = true;
  window.removeEventListener('message', onMsg);
  window.removeEventListener('resize', resize);
  countdownOverlay?.remove();
  ui?.destroy?.();
  if (renderer) { renderer.dispose(); renderer.forceContextLoss?.(); }
}

// 訊息處理（host:start 可帶 payload { gameid, rank, countdown, durationMinSec, durationMaxSec }）
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
      startX: startLineX, endX: finishLineX,
      laneCount, segments: 3, extraSegments: 2, laneGap: 6, baseY: -20,
    });
    reportProgress(40);

    await loadHorses();
    reportProgress(95);
    reportProgress(100);
    reportReady();
    banner('three.js + 馬匹載入完成', true);
  } catch (e) {
    reportError(e); banner('初始化失敗', false); log('[Boot Error]', e);
    if (location.protocol === 'file:') { log('提示：請改用本機 HTTP 伺服器（例如 `npx http-server`）。'); }
  }
})();
