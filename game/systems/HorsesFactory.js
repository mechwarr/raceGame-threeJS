// systems/HorsesFactory.js
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';
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

  for (let i = 0; i < laneCount; i++) {
    const playerNo = i + 1;
    const laneZ = (i - (laneCount - 1) / 2) * laneGap;
    if (laneZ < minLaneZ) minLaneZ = laneZ;
    if (laneZ > maxLaneZ) maxLaneZ = laneZ;

    const startPos = new THREE.Vector3(startLineX, 0, laneZ);
    const randX = rand2(startLineX - 100, startLineX + 100);
    const faceRight = Math.random() < 0.5;

    const hp = new HorsePlayer(scene, HORSE_ROOT, HORSE_GLTF, playerNo, {
      textureFolder: HORSE_TEX,
      fps: 30, scale: 0.5, castShadow: true, receiveShadow: true,
      position: new THREE.Vector3(randX, 0, laneZ),
      rotation: new THREE.Euler(0, faceRight ? Math.PI / 2 : -Math.PI / 2, 0),
    });

    horses.push({ player: hp, startPos, laneZ, faceRight });
    tasks.push(hp.loadAsync());
  }

  let done = 0;
  tasks.forEach(p => p.then(() => { done++; onProgress(60 + Math.round((done / tasks.length) * 35)); }));
  await Promise.all(tasks);

  // 進場 Idle
  for (let i = 0; i < laneCount; i++) {
    horses[i]?.player?.playIdle01(true, 0, 1, Math.random());
  }

  return { horses, minLaneZ, maxLaneZ };
}
