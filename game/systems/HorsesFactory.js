import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
import { HorsePlayer } from '../horse-player-three.js';

/**
 * 產生並載入 N 匹馬
 * @param {THREE.Scene} scene
 * @param {object} opts
 * @param {number} opts.laneCount
 * @param {number} opts.startLineX
 * @param {string} opts.HORSE_ROOT
 * @param {string} opts.HORSE_GLTF
 * @param {string} opts.HORSE_TEX
 * @param {(p:number)=>void} [opts.onProgress] // 0~100
 * @returns {Promise<{horses: Array, minLaneZ:number, maxLaneZ:number}>}
 */
export async function loadHorsesAsync(scene, opts) {
  const {
    laneCount, startLineX,
    HORSE_ROOT, HORSE_GLTF, HORSE_TEX,
    onProgress = () => {}
  } = opts;

  const horses = [];
  const tasks = [];
  let minLaneZ = +Infinity, maxLaneZ = -Infinity;
  const laneGap = 22; // 每條跑道的間距

  const randFloat = (a, b) => a + Math.random() * (b - a);
  const rand2 = (a, b) => Math.round(randFloat(a, b) * 100) / 100;

  // 定義隨機 X 座標的範圍
  const minRandX = startLineX - 100;
  const maxRandX = startLineX;

  for (let i = 0; i < laneCount; i++) {
    const playerNo = i + 1;
    const laneZ = (i - (laneCount - 1) / 2) * laneGap;
    if (laneZ < minLaneZ) minLaneZ = laneZ;
    if (laneZ > maxLaneZ) maxLaneZ = laneZ;

    // startPos 是 race start line 的位置
    const startPos = new THREE.Vector3(startLineX, 0, laneZ);
    // randX 是實際載入時，馬匹的初始隨機位置 (稍微退後)
    const randX = rand2(minRandX, maxRandX); 
    //const faceRight = Math.random() < 0.5;
    const faceRight = 1; // 統一向右

    const hp = new HorsePlayer(scene, HORSE_ROOT, HORSE_GLTF, playerNo, {
      textureFolder: HORSE_TEX,
      fps: 30, scale: 0.5, castShadow: true, receiveShadow: true,
      position: new THREE.Vector3(randX, 0, laneZ),
      rotation: new THREE.Euler(0, faceRight ? Math.PI / 2 : -Math.PI / 2, 0),
    });

    // horses 陣列中儲存了重置時需要的 startPos 和 faceRight 資訊
    // ★ 新增儲存 randX 的隨機範圍，以便未來隨機重置
    horses.push({ player: hp, startPos, laneZ, faceRight, minRandX, maxRandX }); 
    tasks.push(hp.loadAsync());
  }

  let done = 0;
  tasks.forEach(p => p.then(() => { done++; onProgress(60 + Math.round((done / tasks.length) * 35)); }));
  await Promise.all(tasks);

  // 進場 Idle
  for (let i = 0; i < laneCount; i++) {
    horses[i]?.player?.playIdle01(true, 0, 0.5, Math.random());
  }

  return { horses, minLaneZ, maxLaneZ };
}

/**
 * 重新設定所有馬匹的**隨機初始位置**、旋轉，並將動畫重置為 Idle。
 * 此函數將馬匹移動到 randX ~ startLineX 之間的隨機 X 座標。
 * @param {Array<{player: HorsePlayer, startPos: THREE.Vector3, laneZ: number, faceRight: boolean|number, minRandX: number, maxRandX: number}>} horses
 * @returns {void}
 */
export function resetHorsesPositionRandomly(horses) {
  const randFloat = (a, b) => a + Math.random() * (b - a);
  const rand2 = (a, b) => Math.round(randFloat(a, b) * 100) / 100;
  // 輔助函式，計算 Y 軸旋轉角度
  const rotationY = (faceRight) => faceRight ? Math.PI / 2 : -Math.PI / 2;

  horses.forEach(horse => {
    if (!horse.player) return; // 避免 player 載入失敗

    // 1. 重新隨機計算 X 座標
    const randX = rand2(horse.minRandX, horse.maxRandX);
    const newPos = new THREE.Vector3(randX, 0, horse.laneZ);

    console.log(`Resetting horse to X: ${randX}, Z: ${horse.laneZ}`);

    // 2. 重置位置 (使用新的隨機 X 座標和儲存的 laneZ)
    // 透過 HorsePlayer.group 來設置位置
    if (horse.player.group) {
        horse.player.group.position.copy(newPos);
    } else if (horse.player.position) {
        horse.player.position.copy(newPos);
    }
    
    // 3. 重置旋轉
    if (horse.player.group) {
        horse.player.group.rotation.set(0, rotationY(horse.faceRight), 0);
    } else if (horse.player.rotation) {
        horse.player.rotation.set(0, rotationY(horse.faceRight), 0);
    }


    // 4. 重置動畫為 Idle (使用隨機時間開始)
    horse.player.playIdle01(true, 0, 0.5, Math.random());
  });

  console.log(`Reset positions for ${horses.length} horses to random initial positions.`);
}