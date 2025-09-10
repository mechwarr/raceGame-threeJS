// game.js －－ 精簡版（已外掛 SceneSetup / CameraSetup）
// 主要遊戲腳本：11 匹馬、Pause 修復、Ready/Running/Finished 相機側視、全員到線後頒獎（場中央、拉近）
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';

// 🔌 新增：場景 / 燈光 / Renderer 由外部模組提供
import { createRenderer, createScene, setupLights } from './SceneSetup.js';

// 🔌 新增：攝影機參考與工具從外部模組取得（下一步我會提供 CameraSetup.js）
import {
  createPerspectiveCamera,
  placeWithFixedDir,
  gotoPose,
  moveCameraToAward as moveAwardShot, // 避免命名衝突
  applyCameraResize,
} from './CameraSetup.js';

import { GameCamera } from './systems/GameCamera.js';
import { AudioSystem } from './systems/AudioSystem.js';
import { buildField } from './FieldBuilder.js';
import { buildRoadBetween } from './TrackBuilder.js';

import { UIController } from './systems/ui/UIController.js';
import { GameReadyView } from './systems/ui/views/GameReadyView.js';
import { GameView } from './systems/ui/views/GameView.js';
import { FinishedView } from './systems/ui/views/FinishedView.js';

// ★ 使用你的 HorsePlayer 類別
import { HorsePlayer } from './horse-player-three.js';

// ===== 小工具 =====
const $log = document.getElementById('log');
const canvas = document.getElementById('three-canvas');
const log = (...a) => { if ($log) $log.textContent += a.join(' ') + '\n'; console.log(...a); };
const reportProgress = (v) => parent?.postMessage({ type: 'game:progress', value: v }, '*');
const reportReady = () => parent?.postMessage({ type: 'game:ready' }, '*');
const reportError = (e) => parent?.postMessage({ type: 'game:error', error: String(e) }, '*');
const banner = (msg, ok = true) => { const d = document.createElement('div'); d.className = 'banner ' + (ok ? 'ok' : 'err'); d.textContent = msg; document.documentElement.appendChild(d); setTimeout(() => d.remove(), 3600); };

// 產生 8 碼 GameID（簡易）
const gameId = (() => {
  if (crypto?.getRandomValues) {
    const a = new Uint8Array(4); crypto.getRandomValues(a);
    return Array.from(a).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
})();

// ===== 狀態機 =====
const STATE = { Ready: 'Ready', Running: 'Running', Paused: 'Paused', Finished: 'Finished' };
let gameState = STATE.Ready;

// ===== 場景物件 / 遊戲資料 =====
let renderer, scene, camera, clock;
let horses = []; // 內容為 { player: HorsePlayer }
const laneCount = 11;                     // ★ 11 匹
const trackLength = 1000;
const startLineX = -trackLength / 2;
const finishLineX = trackLength / 2;
const finishDetectX = finishLineX - 0.5;  // 衝線判定（略早一點）

let gameCam, audioSystem, ui;
let leader = null;
let disposed = false;

// 速度/動畫（維持你的原始參數）
const baseSpeeds = Array.from({ length: laneCount }, () => 100 + Math.random() * 20);
const noise = (t, i) => Math.sin(t * 5 + i * 1.3) * 0.3;

// 完賽記錄
const finishedTimes = Array(laneCount).fill(null); // 每匹第一次到線的時間
let finalOrder = null;                              // 依完成時間排序
let allArrivedShown = false;

// ======== 透視攝影機參數（仍保留在本檔，因為要吃 start/finish X） ========
const CAM = {
  VIEW_HEIGHT: 20,
  FRAMING_BIAS_Y: 0.30,
  FOV_DEG: 55,
  LOOK_AHEAD_MIN: 8,
  SIDE_READY: { x: startLineX,   z: 90, h: 70, lerp: 0.18 },
  SIDE_RUN:   {                 z: 90, h: 70, lerp: 0.18 },
  SIDE_FIN:   { x: finishLineX, z: 90, h: 70, lerp: 0.15 },
  AWARD: {
    ZOOM: 2.0,
    POS:  { x: 7, y: 5, z: 10 },
    LOOK: { x: 0, y: 2, z: 0 },
  },
};

// ===== SlowMotion 參數（沿用你先前版本） =====
const SLOWMO = {
  enabled: true,     // 啟用慢動作機制
  triggerPct: 0.9,   // 觸發百分比（0~1），預設 90%（你之前填 0.9）
  rate: 0.3,         // 時間縮放（0.3 ≈ 0.5x 的更慢效果）
  active: false,
  triggeredAt: null,
};

// ===== 工具：讀/寫馬的位置 =====
const getHorse = (i) => horses[i]?.player;
const getHorseX = (iOrHorse) => {
  const p = typeof iOrHorse === 'number' ? getHorse(iOrHorse) : iOrHorse?.player || iOrHorse;
  return p?.group?.position?.x ?? 0;
};

// 計算領先者「賽程百分比」（0~1 之間，超出會被夾住）
function getLeaderProgress() {
  const leadObj = leader || computeLeader();
  if (!leadObj) return 0;
  const x = getHorseX(leadObj);
  const pct = (x - startLineX) / (finishLineX - startLineX);
  return THREE.MathUtils.clamp(pct, 0, 1.5);
}

// ====== 相機建立（改用 CameraSetup 模組） ======
function createCamera() {
  camera = createPerspectiveCamera(canvas, CAM);

  // 初始側視位姿（沿固定視角工具計算）
  const { pos, look } = placeWithFixedDir(CAM, CAM.SIDE_READY.x, CAM.SIDE_READY.h, CAM.SIDE_READY.z);

  // 仍然保留 GameCamera：提供外部 message `camera:config` 的接口
  gameCam = new GameCamera(camera, {
    initialPos: [pos.x, pos.y, pos.z],
    initialLookAt: [look.x, look.y, look.z],
    followDistance: 0,
    height: 0,
    lerp: 0.12,
  });
}

// ===== 初始化 three.js 與場景（已抽出 renderer/scene/lights） =====
function initThree() {
  renderer = createRenderer(canvas, { antialias: true, alpha: true, pixelRatioCap: 2 });
  scene = createScene({ background: 0x000000 });
  setupLights(scene, {
    ambientIntensity: 3.0,
    hemiIntensity: 0.65,
    hemiSky: 0xeaf2ff,
    hemiGround: 0x1f262d,
  });

  // ★ 建立相機（唯一模式：persp）
  createCamera();
  applyCameraResize(renderer, camera);

  // 場地、起點/終點（抽出到新檔）
  buildField(scene, {
    trackLength,
    laneCount,
    startLineX,
    finishLineX,
    laneGap: 6,
  });

  audioSystem = new AudioSystem();

  // 提供 GameID 與排名給 UI（不改遊戲邏輯）
  ui = new UIController({
    providers: {
      getGameId: () => gameId,
      getRanking: () => getRankingLabels(),
      getTop5: () => getTop5Labels(),
    },
  });

  ui.register('ready', GameReadyView);
  ui.register('game', GameView);
  ui.register('finished', FinishedView);
  ui.show('ready');

  clock = new THREE.Clock();
  animate();
}

// ★ 視窗縮放
function resize() { applyCameraResize(renderer, camera); }
window.addEventListener('resize', resize);

// ★ 建立 11 匹馬（用 HorsePlayer）
async function loadHorses() {
  horses = [];
  const tasks = [];

  for (let i = 0; i < laneCount; i++) {
    const playerNo = i + 1;
    const hp = new HorsePlayer(scene, HORSE_ROOT, HORSE_GLTF, playerNo, {
      textureFolder: HORSE_TEX,
      fps: 30,
      scale: 0.5,
      castShadow: true,
      receiveShadow: true,
      position: new THREE.Vector3(startLineX - 30, 0, (i - (laneCount - 1) / 2) * 6),
      rotation: new THREE.Euler(0, Math.PI / 2, 0),
    });
    horses.push({ player: hp });
    tasks.push(hp.loadAsync());
  }

  let done = 0;
  tasks.forEach(p => p.then(() => { done++; reportProgress(60 + Math.round(done / tasks.length * 35)); }));
  await Promise.all(tasks);

  for (let i = 0; i < laneCount; i++) getHorse(i)?.playIdle01(true, 0);
}

// ===== 排名 / 完賽處理（原邏輯保留） =====
function computeLeader() {
  let maxX = -Infinity, bestIndex = -1;
  for (let i = 0; i < horses.length; i++) {
    const x = getHorseX(i);
    if (x > maxX) { maxX = x; bestIndex = i; }
  }
  return bestIndex >= 0 ? horses[bestIndex] : null;
}
function everyoneFinished() { return finishedTimes.every(t => t !== null); }
function stampFinish(i, t) { if (finishedTimes[i] == null) finishedTimes[i] = t; }
function buildFinalOrder() {
  const idx = [...Array(laneCount).keys()];
  idx.sort((a, b) => finishedTimes[a] - finishedTimes[b]);
  finalOrder = idx.map(i => horses[i]);
}
function labelOf(h) { const idx = horses.indexOf(h); return `${idx + 1}`; }
function getRankingLabels() {
  if (gameState === STATE.Finished && finalOrder) return finalOrder.map(labelOf);
  const idx = [...Array(laneCount).keys()].sort((a, b) => getHorseX(b) - getHorseX(a));
  return idx.map(i => `${i + 1}`);
}
function getTop5Labels() {
  if (finalOrder) return finalOrder.slice(0, 5).map(labelOf);
  const idx = [...Array(laneCount).keys()].sort((a, b) => getHorseX(b) - getHorseX(a)).slice(0, 5);
  return idx.map(i => `${i + 1}`);
}

// ===== 頒獎台（沿用原邏輯） =====
const PODIUM_SCALE = 2;
const podiumX = 0, podiumZ = 0;
const podiumGap = 3.0;
const podiumHeights = [2.2, 1.7, 1.3, 1.0, 0.8];
let podiumGroup = null;

const HORSE_ROOT = '../public/horse/';
const HORSE_GLTF = 'result.gltf';
const HORSE_TEX = '../public/horse/tex/';

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
function placeTop5OnPodium() {
  ensurePodium();
  const list = finalOrder.slice(0, 5);
  for (let k = 0; k < list.length; k++) {
    const hObj = list[k];
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

  if (gameState === STATE.Ready) {
    gotoPose(camera, CAM, startLineX, CAM.SIDE_READY.h, CAM.SIDE_READY.z, CAM.SIDE_READY.lerp);
    return;
  }

  if (gameState === STATE.Running) {
    const target = leader || computeLeader();
    if (target) {
      const x = getHorseX(target);
      gotoPose(camera, CAM, x, CAM.SIDE_RUN.h, CAM.SIDE_RUN.z, 1);
    }
    return;
  }

  if (gameState === STATE.Finished) {
    if (everyoneFinished()) {
      if (!allArrivedShown) {
        buildFinalOrder();
        placeTop5OnPodium();
        moveAwardShot(camera, CAM); // 頒獎鏡頭（拉近）
        ui?.show?.('finished');
        allArrivedShown = true;

        parent?.postMessage?.({
          type: 'game:finished',
          gameId,
          results: getRankingLabels(),
          top5: getTop5Labels(),
        }, '*');
      }
    } else {
      gotoPose(camera, CAM, finishLineX, CAM.SIDE_FIN.h, CAM.SIDE_FIN.z, CAM.SIDE_FIN.lerp);
    }
  }
}

// ===== 主迴圈（含 SlowMotion） =====
function animate() {
  if (disposed) return;
  requestAnimationFrame(animate);
  const dtRaw = clock.getDelta();
  const t = clock.elapsedTime;

  // SlowMotion 觸發與關閉
  if (gameState === STATE.Running && SLOWMO.enabled && !SLOWMO.active) {
    const pct = getLeaderProgress();
    if (pct >= SLOWMO.triggerPct) {
      SLOWMO.active = true;
      SLOWMO.triggeredAt = t;
      log(`[SlowMo] triggered at ${Math.round(pct * 100)}% (rate=${SLOWMO.rate})`);
    }
  }
  const dt = (SLOWMO.active ? SLOWMO.rate : 1) * dtRaw;

  if (gameState === STATE.Running || (gameState === STATE.Finished && !everyoneFinished())) {
    for (let i = 0; i < laneCount; i++) {
      const p = getHorse(i);
      if (!p) continue;
      p.group.position.x += baseSpeeds[i] * dt;
      p.group.position.y = Math.max(0, Math.abs(noise(t, i)) * 0.2);
      p.update(dt);

      if (finishedTimes[i] == null && p.group.position.x >= finishDetectX) {
        stampFinish(i, t);
      }
    }

    if (!everyoneFinished()) {
      const newLeader = computeLeader();
      if (newLeader && newLeader !== leader) leader = newLeader;
    }

    // 第一名抵達 → 進入 Finished 狀態，同時關閉慢動作
    if (gameState !== STATE.Finished && finishedTimes.some(v => v !== null)) {
      gameState = STATE.Finished;
      if (SLOWMO.active) {
        SLOWMO.active = false;
        log('[SlowMo] deactivated (first horse finished)');
      }
      log('[State] Finished (waiting all horses reach the line)');
    }
  } else if (gameState === STATE.Ready) {
    for (let i = 0; i < laneCount; i++) getHorse(i)?.update(dtRaw);
  }

  updateCamera();
  ui?.tick?.(); // 推進 UI（排名更新）
  renderer.render(scene, camera);
  canvas.classList.toggle('paused', gameState === STATE.Paused);
}

// ===== 事件 & Lifecycle =====
function onGameStart() {
  if (gameState === STATE.Finished && allArrivedShown) return;
  if (gameState === STATE.Ready || gameState === STATE.Paused) {
    for (let i = 0; i < laneCount; i++) {
      const h = getHorse(i);
      if (h?.isLoaded) {
        h.playRun(true, 0.2, 7);
        h.playRun(true, 0.2, 7);
      }
    }
    // 重置 SlowMo
    SLOWMO.active = false;
    SLOWMO.triggeredAt = null;

    gameState = STATE.Running;
    ui?.show?.('game');
    log('[State] Running');
  }
}

function onGamePause() {
  if (gameState === STATE.Running) {
    gameState = STATE.Paused;
    log('[State] Paused');
  }
}
function onGameEnd() {
  log('[Game] End & dispose');
  disposed = true;
  window.removeEventListener('message', onMsg);
  window.removeEventListener('resize', resize);
  ui?.destroy?.();
  if (renderer) { renderer.dispose(); renderer.forceContextLoss?.(); }
}

// ★ 訊息處理（保留 camera:config 功能）
function onMsg(ev) {
  const msg = ev.data; if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'host:start': onGameStart(); break;
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

    // 用 RoadModel 從起點到終點之間拼賽道（模組化）
    await buildRoadBetween(scene, {
      startX: startLineX,
      endX: finishLineX,
      laneCount,
      segments: 3,
      extraSegments: 2,
      laneGap: 6,
      baseY: -20,
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
