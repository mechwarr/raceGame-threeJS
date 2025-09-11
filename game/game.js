// 主要遊戲腳本：11 匹馬、Pause 修復、Ready/Running/Finished 相機側視、全員到線後頒獎（場中央、拉近）
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';
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

// 產生 8 碼 GameID（簡易，作為預設）
const gameIdDefault = (() => {
    if (crypto?.getRandomValues) {
        const a = new Uint8Array(4); crypto.getRandomValues(a);
        return Array.from(a).map(x => x.toString(16).padStart(2, '0')).join('');
    }
    return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
})();
let currentGameId = gameIdDefault;

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

let minLaneZ = +Infinity;
let maxLaneZ = -Infinity;
// 取得 a~b 的浮點亂數
const randFloat = (a, b) => a + Math.random() * (b - a);
// 兩位小數（如果你想要更整齊的散點）
const rand2 = (a, b) => Math.round(randFloat(a, b) * 100) / 100;
// ----- Ready 倒數期間：就位計畫 -----
let standbyPlan = null; // { items: Array<{i, from:THREE.Vector3, to:THREE.Vector3, t0:number, dur:number}>, done:boolean }


// 速度/動畫
const baseSpeeds = Array.from({ length: laneCount }, () => 100 + Math.random() * 20);
const noise = (t, i) => Math.sin(t * 5 + i * 1.3) * 0.3;

// 完賽記錄
const finishedTimes = Array(laneCount).fill(null); // 每匹第一次到線的時間
let finalOrder = null;                              // 依完成時間排序
let allArrivedShown = false;

// ======== 透視攝影機參數（唯一模式） ========
const CAM = {
    VIEW_HEIGHT: 20,      // 用來反算距離，維持與正交相近構圖的可見高度
    FRAMING_BIAS_Y: 0.30, // 垂直構圖偏移（以可見高度的一半為基準的比例）
    FOV_DEG: 55,
    LOOK_AHEAD_MIN: 8,
    SIDE_READY: { x: startLineX, z: 90, h: 70, lerp: 0.18 },
    SIDE_RUN: { z: 90, h: 70, lerp: 0.18 },
    SIDE_FIN: { x: finishLineX, z: 90, h: 70, lerp: 0.15 },
    AWARD: {
        ZOOM: 2.0,               // 放大倍數（以縮短距離達成）
        POS: { x: 7, y: 5, z: 10 }, // 透視下主要參考 y / z；x 會依距離計算
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

// ★★★ 你的馬資源位置（依專案調整）
const HORSE_ROOT = '../public/horse/';
const HORSE_GLTF = 'result.gltf';
const HORSE_TEX = '../public/horse/tex/';

// ===== SlowMotion 參數（既有） =====
const SLOWMO = {
    enabled: true,
    triggerPct: 0.9,     // 90% 時觸發
    rate: 0.3,           // 速度縮放
    active: false,
    triggeredAt: null,
};

// ===== onGameStart 參數（新） =====
let forcedTop5Rank = null;         // ex: [3,5,1,7,2]（1~11 的馬號，0~4 代表名次）
let pendingCountdownTimer = null;  // setInterval handle
let countdownOverlay = null;       // DOM 元素

// ===== 工具：讀/寫馬的位置 =====
const getHorse = (i) => horses[i]?.player;
const getHorseX = (iOrHorse) => {
    const p = typeof iOrHorse === 'number' ? getHorse(iOrHorse) : iOrHorse?.player || iOrHorse;
    return p?.group?.position?.x ?? 0;
};
const setHorsePos = (i, x, y, z) => { const p = getHorse(i); if (!p) return; p.group.position.set(x, y, z); };

const setHorseRot = (i, faceRight = true) => {
    const p = getHorse(i);
    if (!p) return;
    // faceRight = true → 朝右 (y=+90°)，false → 朝左 (y=-90°)
    p.group.rotation.set(0, faceRight ? Math.PI / 2 : -Math.PI / 2, 0);
};


// 計算領先者「賽程百分比」（0~1 之間，超出會被夾住）
function getLeaderProgress() {
    const leadObj = leader || computeLeader();
    if (!leadObj) return 0;
    const x = getHorseX(leadObj);
    const pct = (x - startLineX) / (finishLineX - startLineX);
    return THREE.MathUtils.clamp(pct, 0, 1.5);
}

// ===== 計算：離攝影機最近/最遠的賽道 z（保留原函式） =====
function nearestLaneZ(zCam) {
    const gap = 6;
    const half = (laneCount - 1) / 2;
    let idx = Math.round(zCam / gap + half);
    idx = Math.max(0, Math.min(laneCount - 1, idx));
    return (idx - half) * gap;
}
function farthestLaneZ(zCam) {
    const gap = 6;
    const half = (laneCount - 1) / 2;
    if (zCam >= 0) return (laneCount - 1 - half) * gap;
    return (0 - half) * gap;
}

// ====== 相機建立與尺寸調整（透視） ======
// d = VIEW_HEIGHT / (2 * tan(FOV/2))，同時有 LOOK_AHEAD_MIN 保底
function distanceForViewHeight(viewHeight, fovDeg, minAhead = 0) {
    const fov = THREE.MathUtils.degToRad(fovDeg);
    const d = viewHeight / (2 * Math.tan(fov * 0.5));
    return Math.max(d, minAhead || 0);
}

// 構圖偏移：把相機位置與注視點一起做「垂直平移」
function applyVerticalFraming(pos /*THREE.Vector3*/, look /*THREE.Vector3*/) {
    const offsetY = (CAM.VIEW_HEIGHT * 0.5) * CAM.FRAMING_BIAS_Y;
    pos.y += offsetY;
    look.y += offsetY;
}

// === 依固定方向建立「相機位姿」的工具 ===
function placeWithFixedDir(lookX, eyeH, eyeZ) {
    const d = distanceForViewHeight(CAM.VIEW_HEIGHT, CAM.FOV_DEG, CAM.LOOK_AHEAD_MIN);
    const pos = new THREE.Vector3(lookX, eyeH, eyeZ);
    const look = pos.clone().add(FIXED_DIR.clone().multiplyScalar(d));
    applyVerticalFraming(pos, look);
    return { pos, look };
}

// ★ 建立「透視」相機（固定視角）
function createCamera() {
    const aspect = canvas.clientWidth / canvas.clientHeight || 16 / 9;
    camera = new THREE.PerspectiveCamera(CAM.FOV_DEG, aspect, 0.1, 2000);

    const initX = CAM.SIDE_READY.x;     // 跟起跑線 x
    const { pos, look } = placeWithFixedDir(initX, CAM.SIDE_READY.h, CAM.SIDE_READY.z);

    gameCam = new GameCamera(camera, {
        initialPos: [pos.x, pos.y, pos.z],
        initialLookAt: [look.x, look.y, look.z],
        followDistance: 0,
        height: 0,
        lerp: 0.12,
    });
}

// ★ 視窗縮放時同步更新相機參數
function applyCameraResize() {
    const w = Math.min(window.innerWidth * 0.96, 1200);
    const h = Math.min(window.innerHeight * 0.9, 1200 / (16 / 9));
    renderer?.setSize(w, h, false);

    if (!camera) return;
    camera.aspect = w / h;
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

    // ★ 先建立相機（唯一模式：persp）
    createCamera();
    applyCameraResize();

    const amb = new THREE.AmbientLight(0xffffff, 3.0); scene.add(amb);
    const hemi = new THREE.HemisphereLight(0xeaf2ff, 0x1f262d, 0.65); hemi.position.set(0, 1, 0); scene.add(hemi);

    // 場地、起點/終點（抽出到新檔）
    buildField(scene, {
        trackLength,
        laneCount,
        startLineX,
        finishLineX,
        laneGap: 6,
    });

    audioSystem = new AudioSystem();

    // ★★★★★ 只與 UI 有關：提供 GameID 與排名給 UI（不改遊戲邏輯）
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

    clock = new THREE.Clock();
    animate();
}

// ★ 建立 11 匹馬（用 HorsePlayer）
async function loadHorses() {
    horses = [];
    const tasks = [];

    minLaneZ = +Infinity;
    maxLaneZ = -Infinity;

    for (let i = 0; i < laneCount; i++) {
        const playerNo = i + 1;
        const laneZ = (i - (laneCount - 1) / 2) * 6;

        // 更新全域 z 範圍
        if (laneZ < minLaneZ) minLaneZ = laneZ;
        if (laneZ > maxLaneZ) maxLaneZ = laneZ;

        // ★ 固定“起跑點”：之後開跑會重置到這裡
        const startPos = new THREE.Vector3(startLineX, 0, laneZ);

        // ★ Ready 狀態的隨機散點
        const randX = rand2(startLineX - 80, startLineX + 80);
        const randY = 0;
        const randZ = laneZ;
        const faceRight = Math.random() < 0.5; // true=右, false=左

        const hp = new HorsePlayer(scene, HORSE_ROOT, HORSE_GLTF, playerNo, {
            textureFolder: HORSE_TEX,
            fps: 30,
            scale: 0.5,
            castShadow: true,
            receiveShadow: true,
            position: new THREE.Vector3(randX, randY, randZ),
            rotation: new THREE.Euler(0, faceRight ? Math.PI / 2 : -Math.PI / 2, 0),
        });

        // ★ 把每匹馬的“起跑點 / 賽道 z / Ready 狀態朝向”記起來
        horses.push({ player: hp, startPos, laneZ, faceRight });

        tasks.push(hp.loadAsync());
    }

    let done = 0;
    tasks.forEach(p =>
        p.then(() => {
            done++;
            reportProgress(60 + Math.round((done / tasks.length) * 35));
        })
    );
    await Promise.all(tasks);

    // ★ Idle 動畫：可加隨機起始位相
    for (let i = 0; i < laneCount; i++) {
        const hObj = horses[i];
        hObj.player?.playIdle01(true, 0, 1, rand2(0, 1));
    }

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

// ===== 相機控制（固定視角；Pause 保持當前畫面） =====
function updateCamera() {
    if (gameState === STATE.Paused) return;

    // 固定視角 helper：以固定方向算出位姿
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
                buildFinalOrder();
                placeTop5OnPodium();
                moveCameraToAward(); // 頒獎鏡頭可另行控制，不受固定視角限制
                ui?.show?.('finished');
                allArrivedShown = true;

                parent?.postMessage?.({
                    type: 'game:finished',
                    gameId: currentGameId,
                    results: getRankingLabels(),
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
    const d = baseD / CAM.AWARD.ZOOM; // 縮短距離即放大
    camera.position.set(look.x - d, CAM.AWARD.POS.y * s, CAM.AWARD.POS.z * s);
    camera.lookAt(look);
}

// ===== 主迴圈 =====
function animate() {
    if (disposed) return;
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    const t = clock.elapsedTime;

    // --- SlowMotion 觸發與關閉（既有） ---
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
        for (let i = 0; i < laneCount; i++) {
            const p = getHorse(i);
            if (!p) continue;
            p.group.position.x += baseSpeeds[i] * dt * dtScale;
            p.group.position.y = Math.max(0, Math.abs(noise(t, i)) * 0.2);
            p.update(dt * dtScale);

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
        // 倒數期間：執行就位補間
        if (standbyPlan && !standbyPlan.done) {
            const now = clock.elapsedTime;
            let allDone = true;

            for (const it of standbyPlan.items) {
                const p = getHorse(it.i); if (!p) continue;
                const a = THREE.MathUtils.clamp((now - it.t0) / it.dur, 0, 1);

                // 線性內插到起跑點
                p.group.position.lerpVectors(it.from, it.to, a);

                // 朝向就位方向（以 X 方向為準）
                const dirRight = (it.to.x - it.from.x) >= 0;
                setHorseRot(it.i, dirRight);

                // 動畫更新
                p.update(dt);

                if (a < 1) allDone = false;
                else {
                    // 到點：切回 Idle（淡入短）
                    p.playIdle01(true, 0.1);
                    // 最終面向右（開賽時也會再強制一次）
                    setHorseRot(it.i, true);
                }
            }

            standbyPlan.done = allDone;
        } else {
            // 一般 Ready：仍需推進動畫時間
            for (let i = 0; i < laneCount; i++) getHorse(i)?.update(dt);
        }
    }

    updateCamera();

    // ★★★★★ 只與 UI 有關：推進 UI（讓 GameView.onTick 得以定期更新排名）
    ui?.tick?.();

    renderer.render(scene, camera);
    canvas.classList.toggle('paused', gameState === STATE.Paused);
}

// ===== 事件 & Lifecycle =====

// ★ 將實際「開跑」的動作封裝（原本 onGameStart 內文）——供倒數結束時呼叫
function doStartRace() {
    // ★★ 先把所有馬傳送回“起跑點”，確保從同一起點出發
    for (let i = 0; i < laneCount; i++) {
        const hObj = horses[i];
        if (!hObj?.player) continue;
        hObj.player.group.position.copy(hObj.startPos);

        // ★ 開跑時全部改回面向右
        setHorseRot(i, true);
    }

    for (let i = 0; i < laneCount; i++) {
        const h = getHorse(i);
        if (h?.isLoaded) {
            // 你原本重複呼叫了兩次 playRun，這裡保留你的行為
            h.playRun(true, 0.2, 7);
            h.playRun(true, 0.2, 7);
        }
    }


    // 開賽時重置慢動作
    SLOWMO.active = false;
    SLOWMO.triggeredAt = null;

    gameState = STATE.Running;
    ui?.show?.('game');
    log('[State] Running');
}

/**
 * ★★★ onGameStart 參數化（新）
 * @param {string} gameid  - 遊戲 ID（會覆寫 UI 顯示的 GameID）
 * @param {number[]} rank - 預定前 5 名馬號陣列（1~11），例如 [3,5,1,7,2]
 * @param {number} countdown - 開始倒數秒數（整數秒）。倒數結束才開始跑。
 */
function onGameStart(gameid, rank, countdown) {
    if (gameState === STATE.Finished && allArrivedShown) return;
    if (!(gameState === STATE.Ready || gameState === STATE.Paused)) return;

    // 套用來自主辦端的參數
    if (typeof gameid === 'string' && gameid.trim()) {
        currentGameId = gameid.trim();
        log(`[Start] use external gameId=${currentGameId}`);
    }
    if (Array.isArray(rank) && rank.length) {
        forcedTop5Rank = rank.slice(0, 5).map(x => Math.max(1, Math.min(11, x | 0)));
        log('[Start] received rank(top5)=', forcedTop5Rank.join(','));
    }

    // 倒數 → 正式開跑
    ui?.show?.('ready'); // 先掛上 Ready 畫面（裡面會把 API 掛到 window.GameReadyViewAPI）

    // 先把「等待開始遊戲…」的面板關閉
    window.GameReadyViewAPI?.hideWaitingPanel?.();

    const secs = Math.max(0, Math.floor(countdown || 0));
    if (secs > 0) {
        // ★ 倒數期間：用 Walk 走回起跑點，預留最後 1 秒就位
        playerStandby(secs);
        // 交給 GameReadyView 做倒數，倒數結束立刻開跑
        window.GameReadyViewAPI?.startCountdown?.(secs, () => doStartRace());
    } else {
        doStartRace();
    }
}
// ★ 在倒數期間，所有馬從當前位置以 Walk「回到起跑點」，在剩 1 秒時就位完成
function playerStandby(secs) {
    const total = Math.max(0, Math.floor(secs || 0));
    const dur = Math.max(0, total - 1); // 倒數剩 1 秒時完成

    // 沒時間就位 → 直接瞬移
    if (dur === 0) {
        for (let i = 0; i < laneCount; i++) {
            const hObj = horses[i]; if (!hObj?.player) continue;
            hObj.player.group.position.copy(hObj.startPos);
            setHorseRot(i, true); // 就位統一朝右
            hObj.player.playIdle01(true, 0.15);
        }
        standbyPlan = { items: [], done: true };
        return;
    }

    // 建立就位計畫
    const t0 = clock.elapsedTime;
    const items = [];
    for (let i = 0; i < laneCount; i++) {
        const hObj = horses[i]; if (!hObj?.player) continue;
        const from = hObj.player.group.position.clone();
        const to = hObj.startPos.clone();

        // 看向就位方向（根據 X 方向）
        const faceRight = (to.x - from.x) >= 0;
        setHorseRot(i, faceRight);

        // 播 Walk（可加隨機起始相位，保持自然）
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
    log('[Game] End & dispose');
    disposed = true;
    window.removeEventListener('message', onMsg);
    window.removeEventListener('resize', resize);
    if (pendingCountdownTimer) clearInterval(pendingCountdownTimer);
    countdownOverlay?.remove();
    ui?.destroy?.();
    if (renderer) { renderer.dispose(); renderer.forceContextLoss?.(); }
}

// ★ 訊息處理（host:start 可帶 payload { gameid, rank, countdown }）
function onMsg(ev) {
    const msg = ev.data; if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
        case 'host:start': {
            const p = msg.payload || {};
            onGameStart(p.gameid ?? p.gameId, p.rank, p.countdown);
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
