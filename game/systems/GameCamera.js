// GameCamera：可設定初始視角，自動追蹤第一名；支援距離/高度/平滑係數調整。
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';

/**
 * @typedef {Object} GameCameraOptions
 * @property {THREE.Vector3|number[]} [initialPos]
 * @property {THREE.Vector3|number[]} [initialLookAt]
 * @property {number} [followDistance]
 * @property {number} [height]
 * @property {number} [lerp]
 */

export class GameCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {GameCameraOptions} [opt]
   */
  constructor(camera, opt = {}) {
    this.cam = camera;
    this.followTarget = null;
    this.followDistance = opt.followDistance ?? 10;      // 與目標水平距離
    this.height = opt.height ?? 3;                        // 相機高度
    this.lerp = THREE.MathUtils.clamp(opt.lerp ?? 0.12, 0, 1); // 追蹤平滑

    const initPos = toVec3(opt.initialPos ?? [0, 8, 16]);
    const initLook = toVec3(opt.initialLookAt ?? [0, 0, 0]);
    this.setInitialPose(initPos, initLook);
  }

  /** 設定初始位置與看點 */
  setInitialPose(pos, lookAt){
    this.cam.position.copy(toVec3(pos));
    this.cam.lookAt(toVec3(lookAt));
  }

  /** 調整參數 */
  configure({ followDistance, height, lerp } = {}){
    if (followDistance != null) this.followDistance = followDistance;
    if (height != null) this.height = height;
    if (lerp != null) this.lerp = THREE.MathUtils.clamp(lerp, 0, 1);
  }

  /** 設定追蹤目標（第一名） */
  follow(target){ this.followTarget = target || null; }

  /** 每幀更新：放在目標後方固定距離（賽道 +X 奔跑 → 後方為 -X） */
  update(){
    const t = this.followTarget; if (!t) return;
    const desired = new THREE.Vector3(
      t.position.x - this.followDistance,
      this.height,
      t.position.z
    );
    this.cam.position.lerp(desired, this.lerp);
    this.cam.lookAt(t.position.x, t.position.y, t.position.z);
  }
}

function toVec3(v){
  if (v instanceof THREE.Vector3) return v.clone();
  if (Array.isArray(v)) return new THREE.Vector3(v[0]||0, v[1]||0, v[2]||0);
  return new THREE.Vector3();
}
