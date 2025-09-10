// systems/CameraSetup.js
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';

/** 固定視角方向：正規化 (0, -0.5, -1) */
const FIXED_DIR = new THREE.Vector3(0, -0.5, -1).normalize();

/** 由可見高度反算相機到注視點的水平距離（保留 LOOK_AHEAD_MIN 下限） */
function distanceForViewHeight(viewHeight, fovDeg, minAhead = 0) {
  const fov = THREE.MathUtils.degToRad(fovDeg);
  const d = viewHeight / (2 * Math.tan(fov * 0.5));
  return Math.max(d, minAhead || 0);
}

/** 垂直構圖偏移：同時位移相機與注視點，不改變視線方向 */
function applyVerticalFraming(pos, look, CAM) {
  const offsetY = (CAM.VIEW_HEIGHT * 0.5) * (CAM.FRAMING_BIAS_Y ?? 0);
  pos.y += offsetY;
  look.y += offsetY;
}

/**
 * 建立透視相機（依畫布長寬比與 CAM 參數）
 * @param {HTMLCanvasElement} canvas
 * @param {object} CAM 需含 FOV_DEG
 */
export function createPerspectiveCamera(canvas, CAM) {
  const aspect = (canvas.clientWidth / canvas.clientHeight) || (16 / 9);
  return new THREE.PerspectiveCamera(CAM.FOV_DEG, aspect, 0.1, 2000);
}

/**
 * 將 renderer 與 camera 依視窗調整尺寸（與原 game.js 一致的限制）
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.PerspectiveCamera} camera
 */
export function applyCameraResize(renderer, camera) {
  const w = Math.min(window.innerWidth * 0.96, 1200);
  const h = Math.min(window.innerHeight * 0.9, 1200 / (16 / 9));
  renderer?.setSize(w, h, false);

  if (!camera) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/**
 * 依固定視角方向產生位姿
 * @param {object} CAM 需含 VIEW_HEIGHT/FOV_DEG/LOOK_AHEAD_MIN/FRAMING_BIAS_Y
 * @param {number} lookX 目標 X（例如第一名的 x）
 * @param {number} eyeH  相機世界高度
 * @param {number} eyeZ  相機世界 Z（側向距離）
 * @param {THREE.Vector3} [dir=FIXED_DIR] 固定視角方向
 * @returns {{pos: THREE.Vector3, look: THREE.Vector3}}
 */
export function placeWithFixedDir(CAM, lookX, eyeH, eyeZ, dir = FIXED_DIR) {
  const d = distanceForViewHeight(CAM.VIEW_HEIGHT, CAM.FOV_DEG, CAM.LOOK_AHEAD_MIN);
  const pos = new THREE.Vector3(lookX, eyeH, eyeZ);
  const look = pos.clone().add(dir.clone().multiplyScalar(d));
  applyVerticalFraming(pos, look, CAM);
  return { pos, look };
}

/**
 * 以固定視角方向將相機帶到指定位姿（含 lerp）
 * @param {THREE.PerspectiveCamera} camera
 * @param {object} CAM
 * @param {number} lookX
 * @param {number} h
 * @param {number} z
 * @param {number} [lerp=1]
 */
export function gotoPose(camera, CAM, lookX, h, z, lerp = 1) {
  const { pos, look } = placeWithFixedDir(CAM, lookX, h, z);
  camera.position.lerp(pos, THREE.MathUtils.clamp(lerp, 0, 1));
  camera.lookAt(look);
}

/**
 * 頒獎鏡頭（透視模式拉近）
 * 以 AWARD.LOOK 當注視點，將相機 x 往後縮 baseD/ZOOM，y/z 來自 AWARD.POS
 * @param {THREE.PerspectiveCamera} camera
 * @param {object} CAM 需含 AWARD/VIEW_HEIGHT/FOV_DEG/LOOK_AHEAD_MIN
 */
export function moveCameraToAward(camera, CAM) {
  const look = new THREE.Vector3(CAM.AWARD.LOOK.x, CAM.AWARD.LOOK.y, CAM.AWARD.LOOK.z);
  const baseD = distanceForViewHeight(CAM.VIEW_HEIGHT, CAM.FOV_DEG, CAM.LOOK_AHEAD_MIN);
  const d = baseD / (CAM.AWARD.ZOOM || 1);
  camera.position.set(look.x - d, CAM.AWARD.POS.y, CAM.AWARD.POS.z);
  camera.lookAt(look);
}
