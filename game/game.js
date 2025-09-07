// 主要遊戲腳本：11 匹馬、Pause 修復、Ready/Running/Finished 相機側視、全員到線後頒獎（場中央、拉近）
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';
import { GameCamera } from './systems/GameCamera.js';
import { AudioSystem } from './systems/AudioSystem.js';

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
const trackLength = 100;
const startLineX = -trackLength / 2;
const finishLineX = trackLength / 2;
const finishDetectX = finishLineX - 0.5;  // 衝線判定（略早一點）

let gameCam, audioSystem, ui;
let leader = null;
let disposed = false;

// 速度/動畫
const baseSpeeds = Array.from({ length: laneCount }, () => 6 + Math.random() * 2);
const noise = (t, i) => Math.sin(t * 5 + i * 1.3) * 0.3;

// 完賽記錄
const finishedTimes = Array(laneCount).fill(null); // 每匹第一次到線的時間
let finalOrder = null;                              // 依完成時間排序
let allArrivedShown = false;

// ======== 攝影機參數（分流：ortho / persp）========
// 說明：把原本 CAMERA / FRAMING / SIDE_* / AWARD_CAM 拆成兩份設定
// 之後要微調正交或透視的畫面，只改各自區塊即可，互不干擾。
const CAM_CFG = {
  /** 目前模式（可用 postMessage 'camera:mode' 在外部切換） */
  mode: /** @type {'ortho'|'persp'} */ ('ortho'),

  // === 正交攝影機參數 ===
  ortho: {
    VIEW_HEIGHT: 20,          // 正交可見高度（世界單位）
    FRAMING_BIAS_Y: 0.30,     // 垂直構圖偏移（以可見高度的一半為基準的比例）
    SIDE_READY: { x: startLineX, z: 35, h: 8, lerp: 0.18 },
    SIDE_RUN: { z: 35, h: 8, lerp: 0.18 },
    SIDE_FIN: { x: finishLineX, z: 35, h: 8, lerp: 0.15 },
    AWARD: {
      ZOOM: 2.0,
      POS: { x: 7, y: 5, z: 10 },
      LOOK: { x: 0, y: 2, z: 0 },
    },
  },

  // === 透視攝影機參數 ===
  persp: {
    VIEW_HEIGHT: 20,          // 用來反算距離，維持與正交相近構圖
    FRAMING_BIAS_Y: 0.30,
    FOV_DEG: 55,
    LOOK_AHEAD_MIN: 8,
    SIDE_READY: { x: startLineX, z: 35, h: 8, lerp: 0.18 },
    SIDE_RUN: { z: 35, h: 8, lerp: 0.18 },
    SIDE_FIN: { x: finishLineX, z: 35, h: 8, lerp: 0.15 },
    AWARD: {
      ZOOM: 2.0,               // 放大倍數（以縮短距離達成）
      POS: { x: 7, y: 5, z: 10 }, // 透視下主要參考 y / z；x 會依距離計算
      LOOK: { x: 0, y: 2, z: 0 },
    },
  },
};

// 分流參數便捷取用
const cfg = () => CAM_CFG[CAM_CFG.mode];

// ===== 頒獎台（在「賽場中間」且視角拉近）=====
const PODIUM_SCALE = 2;
const podiumX = 0, podiumZ = 0;
const podiumGap = 3.0;
const podiumHeights = [2.2, 1.7, 1.3, 1.0, 0.8];
let podiumGroup = null;

// ★★★ 你的馬資源位置（依專案調整）
const HORSE_ROOT = '../public/horse/';
const HORSE_GLTF = 'result.gltf';
const HORSE_TEX = '../public/horse/tex/';

// ===== 工具：讀/寫馬的位置 =====
const getHorse = (i) => horses[i]?.player;
const getHorseX = (iOrHorse) => {
  const p = typeof iOrHorse === 'number' ? getHorse(iOrHorse) : iOrHorse?.player || iOrHorse;
  return p?.group?.position?.x ?? 0;
};
const setHorsePos = (i, x, y, z) => { const p = getHorse(i); if (!p) return; p.group.position.set(x, y, z); };

// ===== 計算：離攝影機最近的賽道 z（賽道中心 z = (i - (laneCount-1)/2) * 6） =====
function nearestLaneZ(zCam) {
  const gap = 6;
  const half = (laneCount - 1) / 2;
  let idx = Math.round(zCam / gap + half);
  idx = Math.max(0, Math.min(laneCount - 1, idx));
  return (idx - half) * gap;
}

// ===== 計算：離攝影機最遠的賽道 z（備用：未使用於本構圖）=====
function farthestLaneZ(zCam) {
  const gap = 6;
  const half = (laneCount - 1) / 2;
  if (zCam >= 0) return (laneCount - 1 - half) * gap;
  return (0 - half) * gap;
}

// ====== 相機建立與尺寸調整（正交/透視通用） ======
// d = VIEW_HEIGHT / (2 * tan(FOV/2))，同時有 LOOK_AHEAD_MIN 保底
function distanceForViewHeight(viewHeight, fovDeg, minAhead = 0) {
  const fov = THREE.MathUtils.degToRad(fovDeg);
  const d = viewHeight / (2 * Math.tan(fov * 0.5));
  return Math.max(d, minAhead || 0);
}

// 構圖偏移：把相機位置與注視點一起做「垂直平移」
function applyVerticalFraming(pos /*THREE.Vector3*/, look /*THREE.Vector3*/) {
  const offsetY = (cfg().VIEW_HEIGHT * 0.5) * cfg().FRAMING_BIAS_Y;
  pos.y += offsetY;
  look.y += offsetY;
}

// ★ 依模式建立相機
function createCamera() {
  const aspect = canvas.clientWidth / canvas.clientHeight || 16 / 9;

  if (CAM_CFG.mode === 'ortho') {
    const vh = cfg().VIEW_HEIGHT;
    camera = new THREE.OrthographicCamera(
      -vh * aspect * 0.5, vh * aspect * 0.5,
      vh * 0.5, -vh * 0.5,
      0.1, 1000
    );
  } else {
    camera = new THREE.PerspectiveCamera(cfg().FOV_DEG, aspect, 0.1, 1000);
  }

  // 初始側視位置：正交用固定 -4；透視用視高反算距離（視覺匹配）
  const initLookX = startLineX;
  const initX =
    CAM_CFG.mode === 'ortho'
      ? cfg().SIDE_READY.x - 4
      : (initLookX - distanceForViewHeight(cfg().VIEW_HEIGHT, cfg().FOV_DEG, cfg().LOOK_AHEAD_MIN));

  gameCam = new GameCamera(camera, {
    initialPos: [initX, cfg().SIDE_READY.h, cfg().SIDE_READY.z],
    initialLookAt: [initLookX, 0.6, 0],
    followDistance: 0,
    height: 0,
    lerp: 0.12,
  });
}

// ★ 視窗縮放時同步更新相機參數
function applyCameraResize() {
  const w = Math.min(window.innerWidth * 0.96, 1000);
  const h = Math.min(window.innerHeight * 0.9, 1000 / (16 / 9));
  renderer?.setSize(w, h, false);

  if (!camera) return;
  const aspect = w / h;

  if (camera.isOrthographicCamera) {
    const vh = cfg().VIEW_HEIGHT;
    camera.left = -vh * aspect * 0.5;
    camera.right = vh * aspect * 0.5;
    camera.top = vh * 0.5;
    camera.bottom = -vh * 0.5;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}
function resize() { applyCameraResize(); }
window.addEventListener('resize', resize);

// ===== 初始化 three.js 與場景 =====
function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // ★ 先建立相機（依 mode）
  createCamera();
  applyCameraResize();

  const amb = new THREE.AmbientLight(0xffffff, 0.85); scene.add(amb);
  const hemi = new THREE.HemisphereLight(0xeaf2ff, 0x1f262d, 0.65); hemi.position.set(0, 1, 0); scene.add(hemi);

  const track = new THREE.Mesh(
    new THREE.PlaneGeometry(trackLength, laneCount * 6, 1, laneCount),
    new THREE.MeshPhongMaterial({ color: 0x0b7a3b })
  );
  track.rotation.x = -Math.PI / 2; scene.add(track);

  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
  for (let i = -laneCount / 2; i <= laneCount / 2; i++) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-trackLength / 2, 0.01, i * 6),
      new THREE.Vector3(trackLength / 2, 0.01, i * 6),
    ]);
    scene.add(new THREE.Line(geo, lineMat));
  }

  const makeGate = (x, color) => { const g = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4, laneCount * 6), new THREE.MeshBasicMaterial({ color })); g.position.set(x, 2, 0); scene.add(g); };
  makeGate(startLineX, 0x3ab0ff);
  makeGate(finishLineX, 0xff4081);

  audioSystem = new AudioSystem();
  ui = new UIController({});
  ui.register('ready', GameReadyView);
  ui.register('game', GameView);
  ui.register('finished', FinishedView);
  ui.show('ready');

  clock = new THREE.Clock();
  animate();
}

// ★ 建立 11 匹馬（用 HorsePlayer）
async function loadHorses() {
  horses = [];
  const tasks = [];

  for (let i = 0; i < laneCount; i++) {
    const playerNo = i + 1;
    const hp = new HorsePlayer(scene, HORSE_ROOT, HORSE_GLTF, playerNo, {
      textureFolder: HORSE_TEX,
      fps: 30,
      scale: 0.05,
      castShadow: true,
      receiveShadow: true,
      position: new THREE.Vector3(startLineX + 2, 0, (i - (laneCount - 1) / 2) * 6),
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

// ===== 排名 / 完賽處理 =====
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
function labelOf(h) { const idx = horses.indexOf(h); return `#${idx + 1}`; }
function getRankingLabels() {
  if (gameState === STATE.Finished && finalOrder) return finalOrder.map(labelOf);
  const idx = [...Array(laneCount).keys()].sort((a, b) => getHorseX(b) - getHorseX(a));
  return idx.map(i => `#${i + 1}`);
}
function getTop5Labels() {
  if (finalOrder) return finalOrder.slice(0, 5).map(labelOf);
  const idx = [...Array(laneCount).keys()].sort((a, b) => getHorseX(b) - getHorseX(a)).slice(0, 5);
  return idx.map(i => `#${i + 1}`);
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

// ===== 相機控制（側視；Pause 保持當前畫面） =====
function updateCamera() {
  if (gameState === STATE.Paused) return;

  // 聚焦在跑道中線（固定 0）
  const focusZ = 0;

  // 小工具：設定相機到「以 X 軸對齊的側視」位置（整合 framing 偏移）
  const setSideView = (lookX, lookY, lookZ, lerp) => {
    if (CAM_CFG.mode === 'ortho') {
      const desired = new THREE.Vector3(lookX, cfg().SIDE_RUN.h, cfg().SIDE_RUN.z);
      const look = new THREE.Vector3(lookX, lookY, lookZ);
      applyVerticalFraming(desired, look);        // ★ 套偏移（向上平移，使跑道落在下半部）
      camera.position.lerp(desired, lerp);
      camera.lookAt(look);
    } else {
      const d = distanceForViewHeight(cfg().VIEW_HEIGHT, cfg().FOV_DEG, cfg().LOOK_AHEAD_MIN);
      const desired = new THREE.Vector3(lookX - d, cfg().SIDE_RUN.h, cfg().SIDE_RUN.z);
      const look = new THREE.Vector3(lookX, lookY, lookZ);
      applyVerticalFraming(desired, look);        // ★ 套偏移
      camera.position.lerp(desired, lerp);
      camera.lookAt(look);
    }
  };

  if (gameState === STATE.Ready) {
    // 起點
    const lookX = startLineX;
    const lookY = 0.6;
    const lookZ = focusZ;
    const lerp = cfg().SIDE_READY.lerp;

    if (CAM_CFG.mode === 'ortho') {
      const desired = new THREE.Vector3(cfg().SIDE_READY.x, cfg().SIDE_READY.h, cfg().SIDE_READY.z);
      const look = new THREE.Vector3(lookX, lookY, lookZ);
      applyVerticalFraming(desired, look);
      camera.position.lerp(desired, lerp);
      camera.lookAt(look);
    } else {
      const d = distanceForViewHeight(cfg().VIEW_HEIGHT, cfg().FOV_DEG, cfg().LOOK_AHEAD_MIN);
      const desired = new THREE.Vector3(lookX - d, cfg().SIDE_READY.h, cfg().SIDE_READY.z);
      const look = new THREE.Vector3(lookX, lookY, lookZ);
      applyVerticalFraming(desired, look);
      camera.position.lerp(desired, lerp);
      camera.lookAt(look);
    }
    return;
  }

  if (gameState === STATE.Running) {
    const target = leader || computeLeader();
    if (target) {
      const x = getHorseX(target);
      const lookX = x;
      const lookY = 0.6;
      const lookZ = focusZ;
      setSideView(lookX, lookY, lookZ, cfg().SIDE_RUN.lerp);
    }
    return;
  }

  if (gameState === STATE.Finished) {
    if (everyoneFinished()) {
      if (!allArrivedShown) {
        buildFinalOrder();
        placeTop5OnPodium();
        moveCameraToAward(); // 依模式做拉近（頒獎鏡頭不套 framing，呈現舞台置中）
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
      // 未全部到線：固定看終點
      const lookX = finishLineX;
      const lookY = 0.6;
      const lookZ = focusZ;
      if (CAM_CFG.mode === 'ortho') {
        const desired = new THREE.Vector3(cfg().SIDE_FIN.x, cfg().SIDE_FIN.h, cfg().SIDE_FIN.z);
        const look = new THREE.Vector3(lookX, lookY, lookZ);
        applyVerticalFraming(desired, look);
        camera.position.lerp(desired, cfg().SIDE_FIN.lerp);
        camera.lookAt(look);
      } else {
        const d = distanceForViewHeight(cfg().VIEW_HEIGHT, cfg().FOV_DEG, cfg().LOOK_AHEAD_MIN);
        const desired = new THREE.Vector3(lookX - d, cfg().SIDE_FIN.h, cfg().SIDE_FIN.z);
        const look = new THREE.Vector3(lookX, lookY, lookZ);
        applyVerticalFraming(desired, look);
        camera.position.lerp(desired, cfg().SIDE_FIN.lerp);
        camera.lookAt(look);
      }
    }
  }
}

// ===== 頒獎鏡頭（兩種模式都會「拉近」） =====
function moveCameraToAward() {
  const s = PODIUM_SCALE;

  if (CAM_CFG.mode === 'ortho') {
    camera.position.set(cfg().AWARD.POS.x * s, cfg().AWARD.POS.y * s, cfg().AWARD.POS.z * s);
    camera.lookAt(cfg().AWARD.LOOK.x * s, cfg().AWARD.LOOK.y * s, cfg().AWARD.LOOK.z * s);
    // Ortho：用 zoom 放大
    camera.zoom = cfg().AWARD.ZOOM;
    camera.updateProjectionMatrix();
  } else {
    // Persp：把距離縮短（= 視覺放大），維持同一個注視點
    const look = new THREE.Vector3(cfg().AWARD.LOOK.x * s, cfg().AWARD.LOOK.y * s, cfg().AWARD.LOOK.z * s);
    const baseD = distanceForViewHeight(cfg().VIEW_HEIGHT, cfg().FOV_DEG, cfg().LOOK_AHEAD_MIN);
    const d = baseD / cfg().AWARD.ZOOM; // 縮短距離即放大
    camera.position.set(look.x - d, cfg().AWARD.POS.y * s, cfg().AWARD.POS.z * s);
    camera.lookAt(look);
  }
}

// ===== 主迴圈 =====
function animate() {
  if (disposed) return;
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.elapsedTime;

  if (gameState === STATE.Running || (gameState === STATE.Finished && !everyoneFinished())) {
    for (let i = 0; i < horses.length; i++) {
      const p = getHorse(i);
      if (!p) continue;
      p.group.position.x += baseSpeeds[i] * dt;
      p.group.position.y = Math.max(0, Math.abs(noise(t, i)) * 0.2);
      p.update(dt);
      if (finishedTimes[i] == null && p.group.position.x >= finishDetectX) stampFinish(i, t);
    }

    if (!everyoneFinished()) {
      const newLeader = computeLeader();
      if (newLeader && newLeader !== leader) leader = newLeader;
    }

    if (gameState !== STATE.Finished && finishedTimes.some(v => v !== null)) {
      gameState = STATE.Finished;
      log('[State] Finished (waiting all horses reach the line)');
    }
  } else if (gameState === STATE.Ready) {
    for (let i = 0; i < laneCount; i++) getHorse(i)?.update(dt);
  }

  updateCamera();
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
        h.playRun(true, 0.2, 3);
        h.playRun(true, 0.2, 3);
      }
    }
    // 若之前頒獎放大過，重置 zoom（ortho 才有）
    if (camera?.isOrthographicCamera) { camera.zoom = 1; camera.updateProjectionMatrix(); }
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

// ★ 相機模式切換（熱切換）
function switchCameraMode(mode /** 'ortho'|'persp' */) {
  if (mode !== 'ortho' && mode !== 'persp') return;
  if (CAM_CFG.mode === mode) return;
  CAM_CFG.mode = mode;

  // 記下目前注視（盡量維持使用者感知）
  const prevLook = new THREE.Vector3();
  camera.getWorldDirection(prevLook); // 單位向量
  const curPos = camera.position.clone();
  const approxLookAt = curPos.clone().add(prevLook.multiplyScalar(10)); // 估個前方點

  createCamera();           // 依新模式建立相機
  applyCameraResize();      // 重新套 resize 參數
  camera.position.copy(curPos);
  camera.lookAt(approxLookAt);
  log(`[Camera] switched to ${mode}`);
}

function onMsg(ev) {
  const msg = ev.data; if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'host:start': onGameStart(); break;
    case 'host:pause': onGamePause(); break;
    case 'host:end': onGameEnd(); break;
    case 'camera:config': gameCam?.configure(msg.payload || {}); break;
    // 外部切換 'ortho' / 'persp'
    case 'camera:mode': switchCameraMode(msg.payload); break;
  }
}
window.addEventListener('message', onMsg);

// ===== 啟動 =====
(async function boot() {
  try {
    reportProgress(5);
    initThree();
    reportProgress(20);
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
