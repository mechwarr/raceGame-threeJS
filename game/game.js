// 主要遊戲腳本：11 匹馬、Pause 修復、Ready/Running/Finished 相機側視、全員到線後頒獎（場中央、拉近）
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';
import { GameCamera }   from './systems/GameCamera.js';
import { AudioSystem }  from './systems/AudioSystem.js';

import { UIController }  from './systems/ui/UIController.js';
import { GameReadyView } from './systems/ui/views/GameReadyView.js';
import { GameView }      from './systems/ui/views/GameView.js';
import { FinishedView }  from './systems/ui/views/FinishedView.js';

// ===== 小工具 =====
const $log = document.getElementById('log');
const canvas = document.getElementById('three-canvas');
const log = (...a)=>{ if ($log) $log.textContent += a.join(' ') + '\n'; console.log(...a); };
const reportProgress = (v)=> parent?.postMessage({ type:'game:progress', value:v }, '*');
const reportReady    = ()=> parent?.postMessage({ type:'game:ready' }, '*');
const reportError    = (e)=> parent?.postMessage({ type:'game:error', error: String(e) }, '*');
const banner = (msg, ok=true)=>{ const d=document.createElement('div'); d.className='banner '+(ok?'ok':'err'); d.textContent=msg; document.documentElement.appendChild(d); setTimeout(()=>d.remove(), 3600); };

// 產生 8 碼 GameID（簡易）
const gameId = (()=> {
  if (crypto?.getRandomValues){ const a = new Uint8Array(4); crypto.getRandomValues(a);
    return Array.from(a).map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  return Math.floor(Math.random()*0xffffffff).toString(16).padStart(8,'0');
})();

// ===== 狀態機 =====
const STATE = { Ready:'Ready', Running:'Running', Paused:'Paused', Finished:'Finished' };
let gameState = STATE.Ready;

// ===== 場景物件 / 遊戲資料 =====
let renderer, scene, camera, clock;
let horses = [];
const laneCount = 11;                     // ★ 11 匹
const trackLength = 100;
const startLineX  = -trackLength/2;
const finishLineX =  trackLength/2;
const finishDetectX = finishLineX - 0.5;  // 衝線判定

let gameCam, audioSystem, ui;
let leader = null;
let disposed = false;

// 速度/動畫
const baseSpeeds = Array.from({length: laneCount}, ()=> 6 + Math.random()*2);
const noise = (t, i)=> Math.sin(t*5 + i*1.3) * 0.3;

// 完賽記錄
const finishedTimes = Array(laneCount).fill(null); // 每匹第一次到線的時間
let finalOrder = null;                              // 依完成時間排序
let allArrivedShown = false;

// 相機參數（側視）
const SIDE_READY = { x: startLineX,  z: 12, h: 4,  lerp: 0.18 }; // Ready：起點側視
const SIDE_RUN   = {            z: 12, h: 4,  lerp: 0.18 };      // Running：追第一名
const SIDE_FIN   = { x: finishLineX, z: 12, h: 4,  lerp: 0.15 }; // Finished(未全到)：終點側視

// 頒獎台（在「賽場中間」且視角拉近）
const podiumX   = 0;            // ★ 場中央
const podiumZ   = 0;
const podiumGap = 3.0;          // 橫向間距（沿 z 排）
const podiumHeights = [2.2, 1.7, 1.3, 1.0, 0.8]; // 1~5 名台高
const AWARD_CAM  = { x: 7, y: 5, z: 10, lookX: 0, lookY: 2, lookZ: 0 }; // ★ 近一點的頒獎視角
let podiumGroup = null;

// ===== 初始化 three.js 與場景 =====
function initThree(){
  renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  resize();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.PerspectiveCamera(55, canvas.clientWidth / canvas.clientHeight, 0.1, 500);
  gameCam = new GameCamera(camera, {
    initialPos: [SIDE_READY.x - 4, SIDE_READY.h, SIDE_READY.z], // Ready 側視起點
    initialLookAt: [startLineX, 0.6, 0],
    followDistance: 8,
    height: 3.2,
    lerp: 0.12,
  });

  // 光
  const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 0.8); scene.add(hemi);
  const dir  = new THREE.DirectionalLight(0xffffff, 0.8); dir.position.set(30, 50, 10); scene.add(dir);

  // 跑道
  const track = new THREE.Mesh(
    new THREE.PlaneGeometry(trackLength, laneCount * 6, 1, laneCount),
    new THREE.MeshPhongMaterial({ color: 0x0b7a3b })
  );
  track.rotation.x = -Math.PI/2; scene.add(track);

  // 跑道白線
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent:true, opacity:0.5 });
  for (let i = -laneCount/2; i <= laneCount/2; i++){
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-trackLength/2, 0.01, i*6),
      new THREE.Vector3( trackLength/2, 0.01, i*6),
    ]);
    scene.add(new THREE.Line(geo, lineMat));
  }

  // 馬（方塊）
  const colors = [0xff5555, 0xffaa00, 0x00c8ff, 0xff66cc, 0xdddd33, 0x99ff99, 0x9966ff, 0xffcc66, 0x66ffee, 0xff99aa, 0xcccccc];
  for (let i=0; i<laneCount; i++){
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1.2, 1.2),
      new THREE.MeshStandardMaterial({ color: colors[i % colors.length] })
    );
    body.position.set(startLineX + 2, 0.6, (i - (laneCount-1)/2) * 6);
    scene.add(body);
    horses.push(body);
  }

  // 起跑 / 終點門
  const makeGate = (x, color)=>{ const g=new THREE.Mesh(new THREE.BoxGeometry(0.4,4,laneCount*6), new THREE.MeshBasicMaterial({ color })); g.position.set(x,2,0); scene.add(g); };
  makeGate(startLineX,  0x3ab0ff);
  makeGate(finishLineX, 0xff4081);

  // 音訊與 UI
  audioSystem = new AudioSystem();
  ui = new UIController({
    hooks: {
      onStart: ()=> onGameStart(),
      onPause: ()=> onGamePause(),
      onMute:  (m)=> audioSystem.setMuted(m),
      onVolume:(v)=> audioSystem.setVolume(v),
    },
    providers: {
      getGameId: ()=> gameId,
      getRanking: ()=> getRankingLabels(), // Running: 即時；Finished: 最終
      getTop5: ()=> getTop5Labels(),       // 提供 FinishedView 前五名（#編號）
    },
    initialView: 'ready',
    tickIntervalMs: 300,
  });
  ui.register('ready',    GameReadyView);
  ui.register('game',     GameView);
  ui.register('finished', FinishedView);
  ui.show('ready');

  clock = new THREE.Clock();
  animate();
}

function resize(){
  const w = Math.min(window.innerWidth * 0.96, 1000);
  const h = Math.min(window.innerHeight * 0.9, 1000 / (16/9));
  renderer?.setSize(w, h, false);
  if (camera){ camera.aspect = w/h; camera.updateProjectionMatrix(); }
}
window.addEventListener('resize', resize);

// ===== 排名 / 完賽處理 =====
function computeLeader(){
  let maxX = -Infinity, best = null;
  for (const h of horses){ if (h.position.x > maxX){ maxX = h.position.x; best = h; } }
  return best;
}
function everyoneFinished(){ return finishedTimes.every(t => t !== null); }
function stampFinish(i, t){ if (finishedTimes[i] == null) finishedTimes[i] = t; }
function buildFinalOrder(){
  finalOrder = [...horses].sort((a,b)=>{
    const ia = horses.indexOf(a), ib = horses.indexOf(b);
    return finishedTimes[ia] - finishedTimes[ib];
  });
}
function labelOf(h){ return `#${horses.indexOf(h)+1}`; }
function getRankingLabels(){
  if (gameState === STATE.Finished && finalOrder){
    return finalOrder.map(labelOf);       // 最終次序
  }
  const ordered = [...horses].sort((a,b)=> b.position.x - a.position.x);
  return ordered.map(labelOf);            // 即時
}
function getTop5Labels(){
  const list = (finalOrder ? finalOrder : [...horses].sort((a,b)=> b.position.x - a.position.x))
               .slice(0,5).map(labelOf);
  return list;
}

// ===== 頒獎台（場中央 & 鏡頭靠近） =====
function ensurePodium(){
  if (podiumGroup) return;
  podiumGroup = new THREE.Group();
  scene.add(podiumGroup);

  for (let k=0; k<5; k++){
    const height = podiumHeights[k];
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, height, 2.4),
      new THREE.MeshPhongMaterial({ color: k===0 ? 0xffd700 : (k===1 ? 0xc0c0c0 : 0xcd7f32) })
    );
    const z = podiumZ + (k-2) * podiumGap; // 中央沿 z 排列
    box.position.set(podiumX, height/2, z);
    podiumGroup.add(box);
  }
}
function placeTop5OnPodium(){
  ensurePodium();
  const list = finalOrder.slice(0,5);
  for (let k=0; k<list.length; k++){
    const h = list[k];
    const height = podiumHeights[k];
    const z = podiumZ + (k-2) * podiumGap;
    h.position.set(podiumX, height + 0.6, z); // 放到台上（馬身半高 0.6）
  }
}
function moveCameraToAward(){
  camera.position.set(AWARD_CAM.x, AWARD_CAM.y, AWARD_CAM.z);
  camera.lookAt(AWARD_CAM.lookX, AWARD_CAM.lookY, AWARD_CAM.lookZ);
}

// ===== 相機控制（全部側視；Pause 保持當前畫面） =====
function updateCamera(){
  if (gameState === STATE.Paused) return; // 暫停：維持當前鏡頭

  if (gameState === STATE.Ready){
    const desired = new THREE.Vector3(SIDE_READY.x, SIDE_READY.h, SIDE_READY.z);
    camera.position.lerp(desired, SIDE_READY.lerp);
    camera.lookAt(startLineX, 0.6, 0);
    return;
  }
  if (gameState === STATE.Running){
    const target = leader || computeLeader();
    if (target){
      const desired = new THREE.Vector3(target.position.x, SIDE_RUN.h, SIDE_RUN.z);
      camera.position.lerp(desired, SIDE_RUN.lerp);
      camera.lookAt(target.position.x, 0.6, 0);
    }
    return;
  }
  if (gameState === STATE.Finished){
    if (everyoneFinished()){
      if (!allArrivedShown){
        buildFinalOrder();
        placeTop5OnPodium();
        moveCameraToAward();
        ui?.show?.('finished');
        allArrivedShown = true;

        parent?.postMessage?.({
          type: 'game:finished',
          gameId,
          results: getRankingLabels(),
          top5: getTop5Labels(),
        }, '*');
      }
    }else{
      // 未全部到線：固定看終點
      const desired = new THREE.Vector3(SIDE_FIN.x, SIDE_FIN.h, SIDE_FIN.z);
      camera.position.lerp(desired, SIDE_FIN.lerp);
      camera.lookAt(finishLineX, 0.6, 0);
    }
  }
}

// ===== 主迴圈 =====
function animate(){
  if (disposed) return;
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t  = clock.elapsedTime;

  // 推進條件：Running，或 Finished 但未全到線（Pause 不推進）
  if (gameState === STATE.Running || (gameState === STATE.Finished && !everyoneFinished())){
    for (let i=0; i<horses.length; i++){
      const h = horses[i];
      // ★ 衝線後繼續跑，不鎖住位置
      h.position.x += baseSpeeds[i] * dt;
      h.position.y  = 0.6 + Math.abs(noise(t, i))*0.2;

      // 第一次到線 → 記錄完成時間（不改變移動）
      if (finishedTimes[i] == null && h.position.x >= finishDetectX){
        stampFinish(i, t);
      }
    }

    // 更新第一名（僅在未全到線時）
    if (!everyoneFinished()){
      const newLeader = computeLeader();
      if (newLeader && newLeader !== leader){ leader = newLeader; }
    }

    // 第一匹到線 → 轉入 Finished（但繼續推進到全到線）
    if (gameState !== STATE.Finished && finishedTimes.some(v=> v !== null)){
      gameState = STATE.Finished;
      log('[State] Finished (waiting all horses reach the line)');
    }
  }

  updateCamera();
  renderer.render(scene, camera);

  // 暫停時才灰階
  canvas.classList.toggle('paused', gameState === STATE.Paused);
}

// ===== 事件 & Lifecycle =====
function onGameStart(){
  if (gameState === STATE.Finished && allArrivedShown){
    // 如需「重開一局」，可實作 reset() 邏輯；此處先阻止
    return;
  }
  // Ready 或 Paused → Running
  if (gameState === STATE.Ready || gameState === STATE.Paused){
    gameState = STATE.Running;
    ui?.show?.('game');
    log('[State] Running');
  }
}
function onGamePause(){
  // 只有 Running 才能暫停
  if (gameState === STATE.Running){
    gameState = STATE.Paused;
    log('[State] Paused');
  }
}
function onGameEnd(){
  log('[Game] End & dispose');
  disposed = true;
  window.removeEventListener('message', onMsg);
  window.removeEventListener('resize', resize);
  ui?.destroy?.();
  if (renderer){ renderer.dispose(); renderer.forceContextLoss?.(); }
}

function onMsg(ev){
  const msg = ev.data; if (!msg || typeof msg !== 'object') return;
  switch (msg.type){
    case 'host:start': onGameStart(); break;
    case 'host:pause': onGamePause(); break;
    case 'host:end':   onGameEnd();   break;
    case 'camera:config': gameCam?.configure(msg.payload || {}); break;
  }
}
window.addEventListener('message', onMsg);

// ===== 啟動 =====
(async function boot(){
  try{
    reportProgress(5);
    initThree();
    reportProgress(60);
    reportProgress(100);
    reportReady();
    banner('three.js CDN 初始化完成', true);
    log('[Boot] three.js ready');
  }catch(e){
    reportError(e); banner('初始化失敗', false); log('[Boot Error]', e);
    if (location.protocol === 'file:'){ log('提示：請改用本機 HTTP 伺服器（例如 `npx http-server`）。'); }
  }
})();
