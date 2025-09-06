// horse-player-three.js
// Three.js 版本「賽馬玩家模型」：
// - 建構時指定玩家號碼（1~11），自動套用 horse_001.png ~ horse_011.png 貼圖
// - 動畫來源同時支援：
//   A) glTF 內已分段（如 Horse_Walk / Horse_Run / Horse_SpeedRun / Horse_Idle01 / Horse_Idle02）→ 直接用
//   B) 只有一條長 clip → 依 frame 區間用 subclip 切段
//
// 需求：three@0.160.0、GLTFLoader（同版號）
// 使用（public 路徑）：new HorsePlayer(scene, "/horse/", "result.gltf", 7, { fps: 30 })
// 若貼圖改放 /horse/tex/ 請改：new HorsePlayer(scene, "/horse/", "result.gltf", 7, { textureFolder: "/horse/tex/", fps: 30 })
import * as THREE from "https://unpkg.com/three@0.165.0/build/three.module.js";
import { GLTFLoader } from "https://unpkg.com/three@0.165.0/examples/jsm/loaders/GLTFLoader.js";

// === 動畫分段（幀） ===
const HORSE_RANGES = {
  Walk: { from: 0, to: 159 },
  Run: { from: 241, to: 302 },
  SpeedRun: { from: 304, to: 362 },
  Idle01: { from: 365, to: 409 },
  Idle02: { from: 410, to: 440 }, // ← 修正名稱
};

// === 已分段 clips 的常見命名 ===
const CLIP_ALIASES = {
  Walk: ["Horse_Walk", "Walk", "walk"],
  Run: ["Horse_Run", "Run", "run", "Gallop"],
  SpeedRun: ["Horse_SpeedRun", "SpeedRun", "speedrun", "Sprint", "SprintRun"],
  Idle01: ["Horse_Idle01", "Idle01", "idle01", "Idle", "idle"],
  Idle02: ["Horse_Idle02", "Idle02", "idle02", "Idle_2", "idle_2"],
};

// 預設 fps（如你的 glTF 是以 30fps 出，維持 30）
const DEFAULT_FPS = 30;
// ★ 預設縮放（依你的要求設為 0.1）
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

    // ★ 公開目錄 public/horse/ → 對外路徑為 /horse/
    this.rootUrl = rootUrl ?? "/horse/";
    this.gltfFilename = gltfFilename ?? "result.gltf";
    // 預設貼圖與 glTF 同資料夾（若你放 /horse/tex/，改成 options.textureFolder 或直接把預設寫成 "/horse/tex/"）
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
  }

  get isLoaded() { return this._isLoaded; }

  async loadAsync(renderer) {
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

    // 套用玩家貼圖
    await this._applyPlayerTexture(this.playerNo);

    // Animation
    const clips = gltf.animations || [];
    this.mixer = new THREE.AnimationMixer(this.model);

    // 先嘗試「直接用已分段 clip」，若不齊再 fallback 用 subclip
    const didBindNamedClips = this._bindActionsFromNamedClips(clips);

    if (!didBindNamedClips) {
      // 選一條 base clip 來切段
      this._baseClip = this._pickBaseClip(clips);
      if (!this._baseClip) {
        console.warn("[HorsePlayer] 找不到可用的動畫 clip。");
      } else {
        this._makeSubclipsFromBase();
      }
    }

    // 設定 timeScale
    this.setSpeed(1);

    this._isLoaded = true;
    return this;
  }

  // === 封裝好的播放方法 ===
  playWalk(loop = true, fade = 0.2) { return this._play("Walk", loop, fade); }
  playRun(loop = true, fade = 0.2) { return this._play("Run", loop, fade); }
  playSpeedRun(loop = true, fade = 0.2) { return this._play("SpeedRun", loop, fade); }
  playIdle01(loop = true, fade = 0.2) { return this._play("Idle01", loop, fade); }
  playIdle02(loop = true, fade = 0.2) { return this._play("Idle02", loop, fade); }

  stop() {
    if (this._current) {
      this._current.stop();
      this._current = null;
    }
  }

  update(deltaSeconds) {
    if (this.mixer) this.mixer.update(deltaSeconds);
  }

  setSpeed(timeScale = 1) {
    this._timeScale = Math.max(0.01, Number(timeScale));
    if (this.mixer) this.mixer.timeScale = this._timeScale;
    if (this._current) this._current.timeScale = this._timeScale;
  }

  // 切換玩家號碼 → 換貼圖
  async setPlayerNo(n) {
    this.playerNo = this._clampPlayerNo(n);
    await this._applyPlayerTexture(this.playerNo);
  }

  dispose() {
    // 先停掉與解除 action 快取，再把 mixer 置空
    if (this._current) this._current.stop();

    if (this.mixer) {
      // 逐一解除已建立的 actions
      for (const action of Object.values(this._actions)) {
        const clip = action?.getClip?.();
        if (clip) this.mixer.uncacheAction(clip, this.model);
      }
      this.mixer.uncacheRoot(this.model);
    }

    this._actions = {};
    this._current = null;
    this._baseClip = null;

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
          t.colorSpace = THREE.SRGBColorSpace;   // ★ 關鍵：貼圖是 sRGB
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

  _applyMapToMaterial(mat, tex) {
  if (!mat) return;
  mat.map = tex;
  if (mat.map) {
    mat.map.flipY = false;
    mat.map.colorSpace = THREE.SRGBColorSpace; // ★ 關鍵
  }
  mat.needsUpdate = true;
}

  _join(folder, file) {
    return folder.endsWith("/") ? folder + file : folder + "/" + file;
  }

  _pickBaseClip(clips) {
    if (!clips || clips.length === 0) return null;
    // 先找名稱含 horse 的，找不到選時長最長
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
      // 寬鬆：大小寫不敏感比對
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
        this._actions[logicalName] = action;
        bound++;
      }
    }

    return bound >= 3; // 命中 3 段以上就視為採用 named clips
  }

  _makeSubclipsFromBase() {
    if (!this._baseClip) return;
    this._actions = {};

    for (const [name, range] of Object.entries(HORSE_RANGES)) {
      const sub = THREE.AnimationUtils.subclip(this._baseClip, name, range.from, range.to, this.fps);
      const action = this.mixer.clipAction(sub);
      action.enabled = true;
      action.clampWhenFinished = true;
      action.loop = THREE.LoopRepeat; // 預設可覆蓋
      this._actions[name] = action;
    }
  }

  _play(name, loop = true, fadeSeconds = 0.2) {
    const next = this._actions[name];
    if (!next) {
      console.warn(`[HorsePlayer] 播放失敗：沒有名為 ${name} 的動作。`);
      return;
    }
    next.enabled = true;
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !loop;
    next.timeScale = this._timeScale;
    next.reset();

    if (this._current && this._current !== next) {
      this._current.crossFadeTo(next, Math.max(0, fadeSeconds), false);
    } else {
      next.play();
    }

    this._current = next;
    return next;
  }
}
