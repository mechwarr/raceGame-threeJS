// sprint-effect-three.js
// 以「scene + target(Object3D)」為核心的衝刺特效：粒子、顏色變換；
// 若需要 Bloom/Outline，請再呼叫 attachPostProcessing(renderer, camera)。
// 備註：偏好以傳統中文註解。

import * as THREE from "three";
// 後處理（可選）
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutlinePass } from "three/addons/postprocessing/OutlinePass.js";

export class SprintEffectThree {
  /**
   * @param {THREE.Scene} scene - 外部場景
   * @param {THREE.Object3D} target - 綁定的目標（馬模型的 Group 或 Mesh）
   * @param {object} [opts]
   * @param {number} [opts.particleCount=100]
   * @param {number} [opts.particleSize=1]
   * @param {number} [opts.particleSpeed=1]
   * @param {number} [opts.particleLifetime=0.999]
   * @param {number} [opts.particleOpacity=0.8]
   * @param {number} [opts.particleSpreadRadius=0.2]
   * @param {'forward'|'backward'|'left'|'right'} [opts.particleDirection='forward']
   * @param {boolean} [opts.isParticleActive=false]
   * @param {boolean} [opts.colorChanging=true]
   * @param {number} [opts.colorChangeSpeed=1]
   * @param {number} [opts.colorChangeInterval=0.1]
   * @param {string} [opts.particleTextureUrl='/public/particle/light.png']
   */
  constructor(scene, target, opts = {}) {
    if (!scene) throw new Error("[SprintEffectThree] 需要 scene");
    if (!target) throw new Error("[SprintEffectThree] 需要 target Object3D");

    this.scene = scene;
    this.target = target;

    // === 參數 ===
    this.particleCount = opts.particleCount ?? 100;
    this.particleSize = opts.particleSize ?? 1;
    this.particleSpeed = opts.particleSpeed ?? 1;
    this.particleLifetime = opts.particleLifetime ?? 0.999;
    this.particleOpacity = opts.particleOpacity ?? 0.8;
    this.particleSpreadRadius = opts.particleSpreadRadius ?? 0.2;
    this.isParticleActive = opts.isParticleActive ?? false;

    this.particleDirection = opts.particleDirection ?? "forward";
    this.particleDirectionVectors = {
      forward: new THREE.Vector3(0, 0, -1),
      backward: new THREE.Vector3(0, 0, 1),
      left: new THREE.Vector3(-1, 0, 0),
      right: new THREE.Vector3(1, 0, 0),
    };

    this.isColorChanging = opts.colorChanging ?? true;
    this.colorChangeSpeed = opts.colorChangeSpeed ?? 1; // 0~100 都可以，會被 lerp 當係數
    this.colorChangeInterval = opts.colorChangeInterval ?? 0.1;
    this._lastColorChangeTime = 0;

    this._clock = new THREE.Clock(); // 給顏色變化用（若你外層已有 clock，也可提供 tick 時間進來）
    this.currentOutlineColor = new THREE.Color("#ffffff");
    this.targetOutlineColor = new THREE.Color("#ffffff");

    // FOV 動畫（可由外部讀寫）
    this.camera = null;
    this._fovTarget = null; // 若有設定 attachCameraFov(camera, targetFov)，則會自動內插
    this._fovLerp = 0.05;

    // 後處理
    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;
    this.outlinePass = null;

    // === 粒子系統建置 ===
    this._particleIndex = 0;
    this._initParticleSystem(opts.particleTextureUrl ?? "/public/particle/light.png");

    // 啟用旗標
    this.enabled = true;
  }

  // ------------------------------------------------------------
  // 公開 API
  // ------------------------------------------------------------

  /** 開/關整個特效 */
  setEnabled(v) {
    this.enabled = !!v;
    this.points.visible = this.enabled;
    if (this.outlinePass) this.outlinePass.enabled = this.enabled;
    if (this.bloomPass) this.bloomPass.enabled = this.enabled;
  }

  /** 開/關粒子 */
  setParticleActive(v) {
    this.isParticleActive = !!v;
    if (!this.isParticleActive) {
      const sizes = this.particles.getAttribute("size").array;
      for (let i = 0; i < sizes.length; i++) sizes[i] = 0;
      this.particles.getAttribute("size").needsUpdate = true;
    }
  }

  /** 設定粒子方向：'forward' | 'backward' | 'left' | 'right' */
  setParticleDirection(dir) {
    if (this.particleDirectionVectors[dir]) this.particleDirection = dir;
  }

  /** 改變顏色變化行為 */
  setColorChanging(on, speed, interval) {
    if (typeof on === "boolean") this.isColorChanging = on;
    if (typeof speed === "number") this.colorChangeSpeed = speed;
    if (typeof interval === "number") this.colorChangeInterval = interval;
  }

  /** 若要後處理，請傳入 renderer 與 camera；此方法可重複呼叫以更新尺寸 */
  attachPostProcessing(renderer, camera) {
    if (!renderer || !camera) {
      console.warn("[SprintEffectThree] attachPostProcessing 需要 renderer + camera");
      return;
    }
    this.camera = camera;

    const size = new THREE.Vector2();
    renderer.getSize(size);

    if (!this.composer) {
      this.composer = new EffectComposer(renderer);
      this.renderPass = new RenderPass(this.scene, camera);
      this.composer.addPass(this.renderPass);

      this.bloomPass = new UnrealBloomPass(size, 0.5, 0.0, 1.0);
      this.composer.addPass(this.bloomPass);

      this.outlinePass = new OutlinePass(size, this.scene, camera);
      this.outlinePass.edgeGlow = 1.0;
      this.outlinePass.edgeThickness = 1.5;
      this.outlinePass.edgeStrength = 7.0;
      this.outlinePass.visibleEdgeColor.set("#ffffff");
      this.outlinePass.hiddenEdgeColor.set("#190a05");
      this.outlinePass.selectedObjects = [this.target];
      this.composer.addPass(this.outlinePass);
    } else {
      this.renderPass.camera = camera;
      this.outlinePass.renderScene = this.scene;
      this.outlinePass.renderCamera = camera;
      this.composer.setSize(size.x, size.y);
    }
  }

  /** 可選：讓特效幫你做 FOV 內插（例如衝刺 FOV=90） */
  attachCameraFov(camera, targetFov = 90, lerp = 0.05) {
    this.camera = camera;
    this._fovTarget = Number(targetFov);
    this._fovLerp = lerp ?? 0.05;
  }

  /** 畫面尺寸改變時呼叫（若你有 attachPostProcessing） */
  setSize(w, h) {
    if (this.composer) this.composer.setSize(w, h);
  }

  /** 每幀更新（deltaSeconds 請傳入外部 clock.getDelta()） */
  update(deltaSeconds) {
    if (!this.enabled) return;

    // 1) 顏色變化（影響 outline 與粒子）
    this._updateColor();

    // 2) 粒子更新
    this._updateParticles();

    // 3) FOV 內插（可選）
    if (this.camera && this._fovTarget != null) {
      this.camera.fov += (this._fovTarget - this.camera.fov) * this._fovLerp;
      this.camera.updateProjectionMatrix();
    }

    // 4) 後處理（可選）
    if (this.composer) {
      this.composer.render();
    }
  }

  /** 釋放資源 */
  dispose() {
    if (this.points) this.scene.remove(this.points);
    this.particles?.dispose();
    this.particleMaterial?.map?.dispose?.();
    this.particleMaterial?.dispose?.();

    if (this.composer) {
      // EffectComposer 自行由外層處理 renderer；這裡只清理 pass 參考
      this.composer = null;
    }
  }

  // ------------------------------------------------------------
  // 內部：粒子
  // ------------------------------------------------------------
  _initParticleSystem(particleTextureUrl) {
    this.particles = new THREE.BufferGeometry();
    const positions = new Float32Array(this.particleCount * 3);
    const velocities = new Float32Array(this.particleCount * 3);
    const sizes = new Float32Array(this.particleCount);

    for (let i = 0; i < this.particleCount; i++) {
      const i3 = i * 3;
      positions[i3 + 0] = 0;
      positions[i3 + 1] = 0;
      positions[i3 + 2] = 0;
      velocities[i3 + 0] = 0;
      velocities[i3 + 1] = 0;
      velocities[i3 + 2] = 0;
      sizes[i] = 0;
    }

    this.particles.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.particles.setAttribute("velocity", new THREE.BufferAttribute(velocities, 3));
    this.particles.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

    const tex = new THREE.TextureLoader().load(particleTextureUrl);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;

    this.particleMaterial = new THREE.PointsMaterial({
      color: new THREE.Color("#ffffff"),
      size: this.particleSize,
      sizeAttenuation: true,
      transparent: true,
      opacity: this.particleOpacity,
      map: tex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.particles, this.particleMaterial);
    this.scene.add(this.points);
  }

  _updateParticles() {
    if (!this.target) return;

    const positions = this.particles.getAttribute("position").array;
    const velocities = this.particles.getAttribute("velocity").array;
    const sizes = this.particles.getAttribute("size").array;

    // 粒子位移 & 衰減
    for (let i = 0; i < this.particleCount; i++) {
      const i3 = i * 3;
      positions[i3 + 0] += velocities[i3 + 0];
      positions[i3 + 1] += velocities[i3 + 1];
      positions[i3 + 2] += velocities[i3 + 2];
      sizes[i] *= this.particleLifetime;
    }

    // 重新噴發新粒子
    if (this.isParticleActive && sizes[this._particleIndex] < 0.01) {
      const i3 = this._particleIndex * 3;

      // 從目標邊界盒內隨機取點
      const box = new THREE.Box3().setFromObject(this.target);
      const randomPoint = new THREE.Vector3(
        THREE.MathUtils.randFloat(box.min.x, box.max.x),
        THREE.MathUtils.randFloat(box.min.y, box.max.y),
        THREE.MathUtils.randFloat(box.min.z, box.max.z)
      );

      positions[i3 + 0] = randomPoint.x;
      positions[i3 + 1] = randomPoint.y;
      positions[i3 + 2] = randomPoint.z;

      const dir = this.particleDirectionVectors[this.particleDirection];
      velocities[i3 + 0] = dir.x * this.particleSpeed + (Math.random() - 0.5) * this.particleSpreadRadius;
      velocities[i3 + 1] = dir.y * this.particleSpeed + (Math.random() - 0.5) * this.particleSpreadRadius;
      velocities[i3 + 2] = dir.z * this.particleSpeed + (Math.random() - 0.5) * this.particleSpreadRadius;

      sizes[this._particleIndex] = Math.random() * this.particleSize + this.particleSize / 2;

      this._particleIndex = (this._particleIndex + 1) % this.particleCount;
    }

    // 粒子關閉時，將尺寸清零
    if (!this.isParticleActive) {
      for (let i = 0; i < this.particleCount; i++) sizes[i] = 0;
    }

    this.particles.getAttribute("position").needsUpdate = true;
    this.particles.getAttribute("size").needsUpdate = true;
  }

  // ------------------------------------------------------------
  // 內部：顏色 & Outline
  // ------------------------------------------------------------
  _updateColor() {
    const t = this._clock.getElapsedTime();

    if (this.isColorChanging) {
      // 將目前顏色往目標顏色內插
      this.currentOutlineColor.lerp(this.targetOutlineColor, this.colorChangeSpeed * 0.016); // 以每幀約 60fps 換算
      this.particleMaterial.color.copy(this.currentOutlineColor);
      if (this.outlinePass) {
        this.outlinePass.visibleEdgeColor.copy(this.currentOutlineColor);
      }

      if (t - this._lastColorChangeTime > this.colorChangeInterval) {
        this.targetOutlineColor.setHSL(Math.random(), 1, 0.5);
        this._lastColorChangeTime = t;
      }
    }
  }
}
