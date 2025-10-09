import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
// 假設 HorsePlayer 檔案路徑正確
import { HorsePlayer } from '../horse-player-three.js';

// --- 內部輔助函數 (Internal Helper Functions) ---

// 產生介於 a 和 b 之間的浮點數
const _randFloat = (a, b) => a + Math.random() * (b - a);

// 產生介於 a 和 b 之間，並四捨五入到小數點後兩位的數字
const _rand2 = (a, b) => Math.round(_randFloat(a, b) * 100) / 100;

/**
 * 內部輔助函數：根據給定的最小/最大範圍計算隨機 X 座標。
 * @param {number} minX 隨機範圍最小值
 * @param {number} maxX 隨機範圍最大值 (通常為起跑線 X)
 * @returns {number} 隨機 X 座標 (四捨五入到小數點後兩位)
 */
const _calculateRandomX = (minX, maxX) => {
  return _rand2(minX, maxX);
};

/**
 * 內部輔助函數：計算 Y 軸旋轉角度 (面向右或面向左)。
 * @param {boolean|number} faceRight true 或 1 表示面向右 (Y 軸 90 度), 否則面向左 (-90 度)
 * @returns {number} Y 軸旋轉弧度
 */
const _getRotationY = (faceRight) => faceRight ? Math.PI / 2 : -Math.PI / 2;

// --- 主要匯出函數 (Exported Functions) ---

/**
 * 產生並載入 N 匹馬。
 * @param {THREE.Scene} scene
 * @param {object} opts
 * @param {number} opts.laneCount 跑道數量
 * @param {number} opts.startLineX 起跑線 X 座標
 * @param {string} opts.HORSE_ROOT GLTF 模型的根路徑
 * @param {string} opts.HORSE_GLTF GLTF 模型檔案名
 * @param {string} opts.HORSE_TEX 紋理資料夾路徑
 * @param {(p:number)=>void} [opts.onProgress] 載入進度回呼 (0~100)
 * @returns {Promise<{horses: Array, minLaneZ:number, maxLaneZ:number}>}
 */
export async function loadHorsesAsync(scene, opts) {
  const {
    laneCount, startLineX,
    HORSE_ROOT, HORSE_GLTF, HORSE_TEX,
    onProgress = () => { }
  } = opts;

  const horses = [];
  const tasks = [];
  let minLaneZ = +Infinity, maxLaneZ = -Infinity;
  const laneGap = 22; // 每條跑道的間距

  // 馬匹初始隨機 X 座標的範圍：從起跑線往後延伸 100 單位
  const RANDOM_START_OFFSET = 100;
  const minRandX = startLineX - RANDOM_START_OFFSET;
  const maxRandX = startLineX; // 實際的起跑線

  for (let i = 0; i < laneCount; i++) {
    const playerNo = i + 1;
    const laneZ = (i - (laneCount - 1) / 2) * laneGap;

    // 記錄 Z 軸範圍
    if (laneZ < minLaneZ) minLaneZ = laneZ;
    if (laneZ > maxLaneZ) maxLaneZ = laneZ;

    // 1. 產生初始隨機 X 座標
    const randX = _calculateRandomX(minRandX, maxRandX);
    
    const startPos = new THREE.Vector3(startLineX, 0, laneZ);
    const faceRight = 1; // 統一向右

    const hp = new HorsePlayer(scene, HORSE_ROOT, HORSE_GLTF, playerNo, {
      textureFolder: HORSE_TEX,
      fps: 30, scale: 0.5, castShadow: true, receiveShadow: true,
      position: new THREE.Vector3(randX, 0, laneZ), // 使用隨機的 X
      rotation: new THREE.Euler(0, _getRotationY(faceRight), 0),
    });

    // 2. horses 陣列中儲存了重置時需要的資訊，現在包含 initialRandX (初始隨機座標)
    horses.push({ 
        player: hp, 
        startPos, 
        laneZ, 
        faceRight, 
        minRandX, 
        maxRandX,
        // *** 儲存最初的隨機 X 座標 ***
        initialRandX: randX 
    });
    tasks.push(hp.loadAsync());
  }

  let done = 0;
  // 載入進度回報：假設載入模型佔 60%~95%
  tasks.forEach(p => p.then(() => { done++; onProgress(60 + Math.round((done / tasks.length) * 35)); }));
  await Promise.all(tasks);
  onProgress(100); // 載入完成

  // 進場 Idle
  for (let i = 0; i < laneCount; i++) {
    horses[i]?.player?.playIdle01(true, 0, 0.5, Math.random());
  }

  return { horses, minLaneZ, maxLaneZ };
}

/**
 * 重新設定所有馬匹的**初始位置**、旋轉，並將動畫重置為 Idle。
 * **優先**使用載入時儲存的 `initialRandX` 進行重置，若無則重新隨機計算。
 * @param {Array<{player: HorsePlayer, startPos: THREE.Vector3, laneZ: number, faceRight: boolean|number, minRandX: number, maxRandX: number, initialRandX: number}>} horses
 * @returns {void}
 */
export async function resetHorsesPositionRandomly(horses) {
  horses.forEach(horse => {
    if (!horse.player) return; // 避免 player 載入失敗

    let randX;
    
    // 1. 優先讀取儲存的初始隨機 X 座標
    if (typeof horse.initialRandX === 'number') {
      randX = horse.initialRandX;
      // console.log(`Horse ${horse.player.playerNo} using stored X: ${randX}`);
    } else {
      // 2. 備援：如果沒有儲存，則重新隨機計算 X 座標
      randX = _calculateRandomX(horse.minRandX, horse.maxRandX);
      console.warn(`Stored initial X not found for Horse ${horse.player.playerNo}. Recalculating random X: ${randX}`);
    }

    const newPos = new THREE.Vector3(randX, 0, horse.laneZ);

    // 3. 重置位置 (使用確定的 X 座標和儲存的 laneZ)
    // 透過 HorsePlayer.group 來設置位置
    const targetObject = horse.player.group || horse.player.mesh;
    if (targetObject) {
      targetObject.position.copy(newPos);
      //console.log(`Horse ${horse.player.playerNo} reset to Pos:`, targetObject.position);
    }

    // 4. 重置旋轉
    if (targetObject) {
      targetObject.rotation.set(0, _getRotationY(horse.faceRight), 0);
    }

    // 5. 重置動畫為 Idle (使用隨機時間開始)
    horse.player.playIdle01(true, 0, 0.5, Math.random());
  });

  console.log(`Reset positions for ${horses.length} horses to initial random positions.`);
}
