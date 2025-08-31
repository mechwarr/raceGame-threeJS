// 主要遊戲腳本：整合三個系統類別 + three.js 場景
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';
import { GameCamera }   from './systems/GameCamera.js';
import { AudioSystem }  from './systems/AudioSystem.js';
import { UIController } from './systems/UIController.js';

// ===== 小工具 =====
const $log = document.getElementById('log');
const canvas = document.getElementById('three-canvas');
const log = (...a)=>{ if ($log) $log.textContent += a.join(' ') + '\n'; console.log(...a); };
const reportProgress = (v)=> parent?.postMessage({ type:'game:progress', value:v }, '*');
const reportReady    = ()=> parent?.postMessage({ type:'game:ready' }, '*');
const reportError    = (e)=> parent?.postMessage({ type:'game:error', error: String(e) }, '*');
const banner = (msg, ok=true)=>{ const d=document.createElement('div'); d.className='banner '+(ok?'ok':'err'); d.textContent=msg; document.documentElement.appendChild(d); setTimeout(()=>d.remove(), 3600); };

// ===== 狀態/物件 =====
let renderer, scene, camera, clock;
let running = false, disposed = false;
let horses = [];
const laneCount = 5, trackLength = 100;
let gameCam, audioSystem, ui, leader = null;

// ===== 初始化 three.js 與場景 =====
function initThree(){
  renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  resize();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.PerspectiveCamera(55, canvas.clientWidth / canvas.clientHeight, 0.1, 500);
  // 近距離看向中線（可改 initialPos / initialLookAt）
  gameCam = new GameCamera(camera, {
    initialPos: [-6, 3.2, 0],
    initialLookAt: [0, 0.6, 0],
    followDistance: 8,   // ← 可調距離
    height: 3.2,         // ← 可調高度
    lerp: 0.12,          // ← 可調平滑
  });

  const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 0.8); scene.add(hemi);
  const dir  = new THREE.DirectionalLight(0xffffff, 0.8); dir.position.set(30, 50, 10); scene.add(dir);

  const track = new THREE.Mesh(
    new THREE.PlaneGeometry(trackLength, laneCount * 6, 1, laneCount),
    new THREE.MeshPhongMaterial({ color: 0x0b7a3b })
  );
  track.rotation.x = -Math.PI/2; scene.add(track);

  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent:true, opacity:0.5 });
  for (let i = -laneCount/2; i <= laneCount/2; i++){
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-trackLength/2, 0.01, i*6),
      new THREE.Vector3( trackLength/2, 0.01, i*6),
    ]);
    scene.add(new THREE.Line(geo, lineMat));
  }

  const colors = [0xff5555, 0xffaa00, 0x00c8ff, 0xff66cc, 0xdddd33];
  for (let i=0; i<laneCount; i++){
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1.2, 1.2),
      new THREE.MeshStandardMaterial({ color: colors[i % colors.length] })
    );
    body.position.set(-trackLength/2 + 2, 0.6, (i - (laneCount-1)/2) * 6);
    scene.add(body);
    horses.push(body);
  }

  const makeGate = (x, color)=>{ const g=new THREE.Mesh(new THREE.BoxGeometry(0.4,4,laneCount*6), new THREE.MeshBasicMaterial({ color })); g.position.set(x,2,0); scene.add(g); };
  makeGate(-trackLength/2, 0x3ab0ff);
  makeGate( trackLength/2, 0xff4081);

  audioSystem = new AudioSystem();
  // audioSystem.addSFX('tick', '/sfx/tick.mp3'); // 可自行加入

  ui = new UIController({
    onStart: ()=> onGameStart(),
    onPause: ()=> onGamePause(),
    onLoadBGM: (url)=> audioSystem.loadBGM(url),
    onVolume: (v)=> audioSystem.setVolume(v),
    onMute: (m)=> audioSystem.setMuted(m),
    onSFX: ()=> audioSystem.playSFX('tick', 1),
    leaderProvider: ()=> leader ? `Lane#${horses.indexOf(leader)+1}` : '-',
  });

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

// ===== 比賽邏輯 =====
const baseSpeeds = Array.from({length: laneCount}, ()=> 6 + Math.random()*2);
const noise = (t, i)=> Math.sin(t*5 + i*1.3) * 0.3;

function computeLeader(){
  let maxX = -Infinity, best = null;
  for (const h of horses){ if (h.position.x > maxX){ maxX = h.position.x; best = h; } }
  return best;
}

function animate(){
  if (disposed) return;
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t  = clock.elapsedTime;

  if (running){
    for (let i=0; i<horses.length; i++){
      const h = horses[i];
      h.position.x += baseSpeeds[i] * dt;             // 往 +x 跑
      h.position.y = 0.6 + Math.abs(noise(t, i))*0.2; // 上下起伏
      if (h.position.x > trackLength/2 - 2) h.position.x = -trackLength/2 + 2; // 循環
    }

    const newLeader = computeLeader();
    if (newLeader && newLeader !== leader){
      leader = newLeader;
      gameCam.follow(leader);
      // banner(`切換追蹤：Lane#${horses.indexOf(leader)+1}`, true);
    }
  }

  gameCam.update(); // 相機追蹤
  renderer.render(scene, camera);
  canvas.classList.toggle('paused', !running);
}

// ===== postMessage 溝通 =====
function onGameStart(){ running = true;  log('[Game] Start'); }
function onGamePause(){ running = false; log('[Game] Pause'); }
function onGameEnd(){
  log('[Game] End & dispose');
  running = false; disposed = true;
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
    case 'camera:config': gameCam?.configure(msg.payload || {}); break; // 宿主可動態調相機
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
