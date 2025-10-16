// horse-player-three.js
// Three.js 版本「賽馬玩家模型」：
// - 建構時指定玩家號碼（1~11），自動套用 horse_001.png ~ horse_011.png 貼圖
// - 動畫來源同時支援：
//   A) glTF 內已分段（如 Horse_Walk / Horse_Run / Horse_SpeedRun / Horse_Idle01 / Horse_Idle02）→ 直接用
//   B) 只有一條長 clip → 依 frame 區間用 subclip 切段
//
// 需求：three@0.165.0、GLTFLoader（同版號）
// 使用（public 路徑）：new HorsePlayer(scene, "/horse/", "result.gltf", 7, { fps: 30 })
// 若貼圖改放 /horse/tex/ 請改：new HorsePlayer(scene, "/horse/", "result.gltf", 7, { textureFolder: "/horse/tex/", fps: 30 })
import * as THREE from "https://unpkg.com/three@0.165.0/build/three.module.js";
import { GLTFLoader } from "https://unpkg.com/three@0.165.0/examples/jsm/loaders/GLTFLoader.js";
import { BillboardSequenceEffect } from './BillboardSequenceEffect.js'; // ★ 確保已匯入

// === 動畫分段（幀） ===
const HORSE_RANGES = {
  Walk: { from: 0, to: 159 },
  Run: { from: 241, to: 302 },
  SpeedRun: { from: 304, to: 362 },
  Idle01: { from: 365, to: 409 },
  Idle02: { from: 410, to: 440 },
};

// === 已分段 clips 的常見命名 ===
const CLIP_ALIASES = {
  Walk: ["Horse_Walk", "Walk", "walk"],
  Run: ["Horse_Run", "Run", "run", "Gallop"],
  SpeedRun: ["Horse_SpeedRun", "SpeedRun", "speedrun", "Sprint", "SprintRun"],
  Idle01: ["Horse_Idle01", "Idle01", "idle01", "Idle", "idle"],
  Idle02: ["Horse_Idle02", "Idle02", "idle02", "Idle_2", "idle_2"],
};

// 預設 fps
const DEFAULT_FPS = 30;
// 預設縮放
const DEFAULT_SCALE = 0.1;

// 編號 → 貼圖檔名
function playerNoToFile(n) {
  const c = Math.min(11, Math.max(1, (n | 0)));
  return `horse_${String(c).padStart(3, "0")}.png`;
}

export class HorsePlayer {
  /**
   * @param {THREE.Scene} scene
   * @param {string} rootUrl - glTF 所在資料夾（public 路徑），預設 "/horse/"
   * @param {string} gltfFilename - 例如 "result.gltf"
   * @param {number} playerNo - 1~11
   * @param {object} [options]
   * @param {string} [options.textureFolder] - 貼圖資料夾（預設 rootUrl）
   * @param {number} [options.fps=30] - 以幀定義子動畫時使用的 fps
   * @param {THREE.Vector3} [options.position]
   * @param {THREE.Euler} [options.rotation]
   * @param {number} [options.scale=0.1]
   * @param {boolean} [options.castShadow=false]
   * @param {boolean} [options.receiveShadow=false]
   */
  constructor(scene, rootUrl, gltfFilename, playerNo, options = {}) {
    if (!scene) throw new Error("HorsePlayer 需要 THREE.Scene");
    this.scene = scene;

    this.rootUrl = rootUrl ?? "/horse/";
    this.gltfFilename = gltfFilename ?? "result.gltf";
    this.textureFolder = options.textureFolder ?? this.rootUrl;

    this.fps = options.fps ?? DEFAULT_FPS;

    this.group = new THREE.Group();
    this.group.name = `HorsePlayer_${playerNo}`;
    this.scene.add(this.group);

    const scale = options.scale ?? DEFAULT_SCALE;
    this.group.scale.setScalar(scale);
    if (options.position) this.group.position.copy(options.position);
    if (options.rotation) this.group.rotation.copy(options.rotation);

    this._castShadow = !!options.castShadow;
    this._receiveShadow = !!options.receiveShadow;

    // 狀態
    this.playerNo = this._clampPlayerNo(playerNo);
    this.mixer = null;
    this.model = null;
    this._baseClip = null;
    this._actions = {}; // name -> AnimationAction
    this._current = null;
    this._timeScale = 1;

    this._isLoaded = false;
    // ★ 新增：windFx 屬性，預設為 null
    this._windFx = null;
    this._windFxLoop = false;
  }

  get isLoaded() { return this._isLoaded; }

  async loadAsync() {
    const loader = new GLTFLoader().setPath(this.rootUrl);
    const gltf = await loader.loadAsync(this.gltfFilename);

    this.model = gltf.scene || gltf.scenes?.[0];
    this.group.add(this.model);

    // 陰影與材質設定
    this.model.traverse(obj => {
      if (obj.isMesh) {
        obj.castShadow = this._castShadow;
        obj.receiveShadow = this._receiveShadow;
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
            m.needsUpdate = true;
          }
        }
      }
    });

    await this._applyPlayerTexture(this.playerNo);

    // Animation
    const clips = gltf.animations || [];
    this.mixer = new THREE.AnimationMixer(this.model);

    const didBindNamedClips = this._bindActionsFromNamedClips(clips);

    if (!didBindNamedClips) {
      this._baseClip = this._pickBaseClip(clips);
      if (!this._baseClip) {
        console.warn("[HorsePlayer] 找不到可用的動畫 clip。");
      } else {
        this._makeSubclipsFromBase();
      }
    }

    this.setSpeed(1);
    this._isLoaded = true;
    return this;
  }

  // === 封裝好的播放方法（均新增 speed 參數，預設 1） ===
  /** @param {boolean} [loop=true] @param {number} [fade=0.2] @param {number} [speed=1] */
  playWalk(loop = true, fade = 0.2, speed = 1) { return this._play("Walk", loop, fade, speed, this.randomStartAt()); }
  /** @param {boolean} [loop=true] @param {number} [fade=0.2] @param {number} [speed=1] */
  playRun(loop = true, fade = 0.2, speed = 1) { return this._play("Run", loop, fade, speed, this.randomStartAt()); }
  /** @param {boolean} [loop=true] @param {number} [fade=0.2] @param {number} [speed=1] */
  playSpeedRun(loop = true, fade = 0.2, speed = 1) { return this._play("SpeedRun", loop, fade, speed, this.randomStartAt()); }
  /** @param {boolean} [loop=true] @param {number} [fade=0.2] @param {number} [speed=1] */
  playIdle01(loop = true, fade = 0.2, speed = 1) { return this._play("Idle01", loop, fade, speed, this.randomStartAt()); }
  /** @param {boolean} [loop=true] @param {number} [fade=0.2] @param {number} [speed=1] */
  playIdle02(loop = true, fade = 0.2, speed = 1) { return this._play("Idle02", loop, fade, speed, this.randomStartAt()); }

  randomStartAt() { return Math.round(Math.random() * 100) / 100; }

  stop() {
    if (this._current) {
      this._current.stop();
      this._current = null;
    }
  }

  /**
   * 每幀更新動畫和特效
   * @param {number} deltaSeconds
   * @param {THREE.Camera} camera - 必須傳入 camera 才能正確計算 billboard 效果
   */
  update(deltaSeconds, camera) { 
    if (this.mixer) this.mixer.update(deltaSeconds);
    
    // ★ 處理 BillboardSequenceEffect 更新
    if (this._windFx) {
      this._windFx.update(deltaSeconds, camera);
    }
  }

  /**
   * 設定「全域播放速度」（會套在整個 mixer 上）
   * - 單次播放速度請用各 play* 的第三個參數 speed
   * - 實際速度 = 全域倍率 × 單次倍率
   */
  setSpeed(timeScale = 1) {
    this._timeScale = Math.max(0.01, Number(timeScale));
    if (this.mixer) this.mixer.timeScale = this._timeScale;
    if (this._current) {
      const user = this._current.userSpeed ?? 1;
      this._current.timeScale = user;
    }
  }

  // 切換玩家號碼 → 換貼圖
  async setPlayerNo(n) {
    this.playerNo = this._clampPlayerNo(n);
    await this._applyPlayerTexture(this.playerNo);
  }

  // ============== 特效開關方法 ==============

  /**
   * 啟動圖片序列特效 (BillboardSequenceEffect)
   * @param {boolean} [loop=false] - 是否循環播放
   */
  runSpeedVFX(loop = false) {
    if (!this._isLoaded) {
      console.warn("[HorsePlayer] 模型尚未載入完成，無法啟動特效。");
      return;
    }
    // 每次執行前都先停止舊的特效
    this.stopSpeedVFX();
    
    // 建立新的特效，傳入 this (HorsePlayer 實例)
    this._windFx = new BillboardSequenceEffect(this); 
    
    // 假定 BillboardSequenceEffect 有 start/stop 方法來控制動畫播放
    if (this._windFx.start) {
        this._windFx.start(loop);
    } else {
        // 如果沒有 start，則假設它在建構後預設已啟動，或使用 setVisible 
        this._windFx.setVisible?.(true); 
    }
    
    this._windFxLoop = loop;
  }

  /**
   * 停止並清理圖片序列特效
   */
  stopSpeedVFX() {
    if (this._windFx) {
      // 假定 BillboardSequenceEffect 有 stop 方法
      if (this._windFx.stop) {
        this._windFx.stop();
      } else {
        this._windFx.setVisible?.(false);
      }
      
      // 等待特效結束後再清理，避免立即釋放資源導致顯示錯誤
      setTimeout(() => {
        if (this._windFx) {
          // 清理資源並設為 null
          this._windFx.dispose();
          this._windFx = null;
        }
      }, 500); // 這裡的延遲時間可以根據特效持續時間微調
    }
  }

  // ======================================

  dispose() {
    if (this._current) this._current.stop();

    if (this.mixer) {
      for (const action of Object.values(this._actions)) {
        const clip = action?.getClip?.();
        if (clip) this.mixer.uncacheAction(clip, this.model);
      }
      this.mixer.uncacheRoot(this.model);
    }

    this._actions = {};
    this._current = null;
    this._baseClip = null;

    // ★ 調整：在 dispose 時也停止並清理風特效
    this.stopSpeedVFX();

    if (this.group) {
      this.scene.remove(this.group);
      this.group.traverse(obj => {
        if (obj.isMesh) {
          obj.geometry?.dispose?.();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) this._disposeMaterial(m);
        }
      });
      this.group.clear();
    }

    this.mixer = null;
    this.model = null;
  }

  // === 內部 ===
  _disposeMaterial(mat) {
    if (!mat) return;
    for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap"]) {
      if (mat[key]?.dispose) mat[key].dispose();
    }
    mat.dispose?.();
  }

  _clampPlayerNo(n) {
    n = Number(n | 0);
    if (n < 1) n = 1;
    if (n > 11) n = 11;
    return n;
  }

  async _applyPlayerTexture(playerNo) {
    const file = playerNoToFile(playerNo);
    const url = this._join(this.textureFolder, file);

    console.log(`[HorsePlayer] 載入貼圖：${url}`);

    const tex = await new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        url,
        t => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.flipY = false;
          resolve(t);
        },
        undefined,
        reject
      );
    });

    this.model.traverse(obj => {
      if (!obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) this._applyMapToMaterial(m, tex);
    });
  }

 _applyMapToMaterial(mat, tex, opts = {}) {
  if (!mat) return;

  mat.map = tex || null;

  if (mat.map) {
    mat.map.flipY = false;
    mat.map.colorSpace = THREE.SRGBColorSpace;
    const useTransparent = opts.transparent !== undefined ? opts.transparent : true;
    mat.transparent = useTransparent;
  }

  mat.needsUpdate = true;
}

  _join(folder, file) {
    return folder.endsWith("/") ? folder + file : folder + "/" + file;
  }

  _pickBaseClip(clips) {
    if (!clips || clips.length === 0) return null;
    const c1 = clips.find(c => (c.name || "").toLowerCase().includes("horse"));
    if (c1) return c1;
    let best = clips[0];
    let bestDur = best.duration;
    for (let i = 1; i < clips.length; i++) {
      if (clips[i].duration > bestDur) {
        best = clips[i]; bestDur = clips[i].duration;
      }
    }
    return best;
  }

  _bindActionsFromNamedClips(clips) {
    if (!clips || clips.length === 0) return false;

    let bound = 0;
    this._actions = {};

    const byName = new Map();
    for (const c of clips) byName.set(c.name, c);

    const tryFind = (candidates) => {
      for (const n of candidates) {
        if (byName.has(n)) return byName.get(n);
      }
      for (const [k, v] of byName) {
        if (candidates.some(w => w.toLowerCase() === (k || "").toLowerCase())) return v;
      }
      return null;
    };

    for (const [logicalName, aliases] of Object.entries(CLIP_ALIASES)) {
      const clip = tryFind(aliases);
      if (clip) {
        const action = this.mixer.clipAction(clip);
        action.enabled = true;
        action.clampWhenFinished = true;
        action.loop = THREE.LoopRepeat;
        action.userSpeed = 1;
        this._actions[logicalName] = action;
        bound++;
      }
    }

    const hasIdle = !!this._actions.Idle01 || !!this._actions.Idle02;
    return bound >= 3 && hasIdle;
  }

  _makeSubclipsFromBase() {
    if (!this._baseClip) return;
    this._actions = {};

    for (const [name, range] of Object.entries(HORSE_RANGES)) {
      const sub = THREE.AnimationUtils.subclip(this._baseClip, name, range.from, range.to, this.fps);
      const action = selfOr(this.mixer.clipAction(sub));
      function selfOr(a) { a.userSpeed = 1; return a; }
      action.enabled = true;
      action.clampWhenFinished = true;
      action.loop = THREE.LoopRepeat;
      this._actions[name] = action;
    }
  }

  _play(name, loop = true, fadeSeconds = 0.2, speed = 1, startAt = 0) {
    const next = this._actions[name];
    if (!next) {
      console.warn(`[HorsePlayer] 播放失敗：沒有名為 ${name} 的動作。`);
      return;
    }

    const userSpeed = Math.max(0.01, Number(speed) || 1);
    next.enabled = true;
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !loop;
    next.userSpeed = userSpeed;
    next.timeScale = userSpeed;

    const clip = next.getClip?.() || next._clip;
    const dur = Math.max(0, clip?.duration ?? 0);
    const p = Math.min(1, Math.max(0, Number(startAt) || 0));
    const startTime = dur > 0 ? (p >= 1 ? (loop ? 0 : dur) : (dur * p)) : 0;

    next.reset();
    if (dur > 0) {
      next.time = loop ? (startTime % dur) : Math.min(startTime, dur);
    }

    if (this._current && this._current !== next) {
      next.play();
      this._current.crossFadeTo(next, Math.max(0, fadeSeconds), false);
    } else {
      next.play();
    }

    this._current = next;
    return next;
  }

  /**
   * 設定目前播放中動畫的「單次播放速度」
   * @param {number} speed - 播放速度倍率，預設為 1
   */
  setAnimationSpeed(speed = 1) {
    if (!this._current) {
      console.warn("[HorsePlayer] 沒有正在播放的動畫。");
      return;
    }
    const userSpeed = Math.max(0.01, Number(speed) || 1);
    this._current.userSpeed = userSpeed;
    this._current.timeScale = this.mixer.timeScale * userSpeed;
  }
}