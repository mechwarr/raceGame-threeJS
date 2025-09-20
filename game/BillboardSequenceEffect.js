// BillboardSequenceEffect.js
import * as THREE from 'three';

export class BillboardSequenceEffect {
  /**
   * 只需要傳入一個已 load 完成的 HorsePlayer 實例
   * @param {HorsePlayer} horsePlayer
   */
  constructor(horsePlayer) {
    if (!horsePlayer || !horsePlayer.model) {
      throw new Error('[BillboardSequenceEffect] horsePlayer.model 尚未就緒');
    }

    // === 預設參數（可依專案調整）===
    this.folderUrl = 'public/sheets';     // 圖片序列資料夾
    this.prefix    = 'sparkle_';          // 檔名前綴
    this.start     = 0;                   // 起始編號（會自動補三位數）
    this.end       = 23;                  // 結束編號
    this.fps       = 15;                  // 預設播放幀率
    this.alphaTest = 0.5;                 // 透明裁切
    this.doubleSide = true;               // 是否雙面
    this.renderOrder = 999;               // 讓它後畫比較不會被蓋住
    this.depthWrite = false;              // 不寫入深度，避免排序黑化
    this.lookAtMode = 'full';             // 'full' 完全平行螢幕；'yaw' 只跟水平面朝向
    this.rotationInScreenDeg = 0;         // 畫面內的額外旋轉（度）
    this.offset = new THREE.Vector3(-50, 30, 0); // 相對馬模型的位置
    this.scale  = 1;                      // 整體縮放

    // === 狀態 ===
    this._horse = horsePlayer;
    this._scene = this._horse.scene;
    this._parent = this._horse.model;     // 就是你要求掛在 model node 底下
    this._billboardNode = new THREE.Group();
    this._mesh = null;
    this._textures = [];
    this._ready = false;
    this._enabled = true;

    this._frameIdx = 0;
    this._frameTimer = 0;
    this._frameInterval = 1 / this.fps;

    // 掛上父層
    this._parent.add(this._billboardNode);
    this._billboardNode.position.copy(this.offset);
    this._billboardNode.scale.set(this.scale, this.scale, this.scale);

    // 開始載入
    this._loadTextures();
  }

  // ====== Public APIs（可在外部呼叫）======
  setVisible(v) { this._enabled = !!v; if (this._mesh) this._mesh.visible = this._enabled; }
  setFPS(fps)   { this.fps = Math.max(1, fps | 0); this._frameInterval = 1 / this.fps; }
  setOffset(x,y,z) { this.offset.set(x,y,z); }
  setScale(s)   { this.scale = s; }
  setRotationInScreenDeg(deg) { this.rotationInScreenDeg = deg; }
  setLookAtMode(mode/* 'full' | 'yaw' */){ this.lookAtMode = mode === 'yaw' ? 'yaw' : 'full'; }

  dispose() {
    if (this._mesh) {
      this._mesh.parent?.remove(this._mesh);
      this._mesh.material?.map?.dispose?.();
      this._mesh.material?.dispose?.();
      this._mesh.geometry?.dispose?.();
      this._mesh = null;
    }
    for (const t of this._textures) t?.dispose?.();
    this._textures.length = 0;
    this._billboardNode.parent?.remove(this._billboardNode);
    this._billboardNode.clear();
    this._ready = false;
  }

  /**
   * 每幀呼叫
   * @param {number} delta
   * @param {THREE.Camera} camera
   */
  update(delta, camera) {
    if (!this._ready || !this._enabled || !this._mesh) return;

    // 對齊攝影機（billboard）
    this._applyBillboard(camera);

    // 播放序列
    this._frameTimer += delta;
    if (this._frameTimer >= this._frameInterval) {
      this._frameIdx = (this._frameIdx + 1) % this._textures.length;
      this._frameTimer = this._frameTimer % this._frameInterval;
      this._mesh.material.map = this._textures[this._frameIdx];
      this._mesh.material.needsUpdate = true;
    }

    // 位置/縮放
    this._billboardNode.position.copy(this.offset);
    this._billboardNode.scale.set(this.scale, this.scale, this.scale);
  }

  // ====== Internal ======
  async _loadTextures() {
    const loader = new THREE.TextureLoader();
    const promises = [];
    for (let i=this.start; i<=this.end; i++) {
      const name = String(i).padStart(3,'0');
      const url  = `${this.folderUrl}/${this.prefix}${name}.png`;
      promises.push(new Promise((resolve, reject) => {
        loader.load(
          url,
          tex => {
            tex.colorSpace = THREE.SRGBColorSpace;
            // 也可在這裡做 90° 旋轉
            // tex.center.set(0.5,0.5); tex.rotation = Math.PI/2;
            resolve(tex);
          },
          undefined,
          err => reject(new Error(`載入失敗: ${url}`))
        );
      }));
    }

    try {
      this._textures = await Promise.all(promises);
      if (this._textures.length === 0) throw new Error('沒有載入到任何序列貼圖');

      // 以第一張建立幾何/材質
      const tex0 = this._textures[0];
      const mat = new THREE.MeshBasicMaterial({
        map: tex0,
        transparent: true,
        alphaTest: this.alphaTest,
        side: this.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
        depthWrite: this.depthWrite,
      });

      const w = tex0.image.width  || 256;
      const h = tex0.image.height || 256;
      const geo = new THREE.PlaneGeometry(w, h);

      this._mesh = new THREE.Mesh(geo, mat);
      this._mesh.renderOrder = this.renderOrder;
      this._mesh.visible = this._enabled;

      // 節點結構：父層做 billboard、子層做畫面內旋轉
      this._billboardNode.add(this._mesh);

      this._ready = true;
    } catch (e) {
      console.error('[BillboardSequenceEffect] 圖片序列載入失敗：', e);
      this._ready = false;
    }
  }

  _applyBillboard(camera) {
    if (!camera) return;

    // 額外增加一個 45 度旋轉
    const extraRotationRad = THREE.MathUtils.degToRad(45);
    const rotationQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -0.6), extraRotationRad);

    if (this.lookAtMode === 'full') {
      // 完全跟相機同姿態（最平行）
      this._billboardNode.quaternion.copy(camera.quaternion);
      // 額外套用 45 度 Y 軸旋轉
      this._billboardNode.quaternion.multiply(rotationQuaternion);
    } else {
      // 只對水平朝向（忽略 pitch/roll）
      const camPos = new THREE.Vector3().copy(camera.position);
      const nodePos = new THREE.Vector3().setFromMatrixPosition(this._billboardNode.matrixWorld);
      camPos.y = nodePos.y;
      this._billboardNode.lookAt(camPos);
      // 額外套用 45 度 Y 軸旋轉
      this._billboardNode.quaternion.multiply(rotationQuaternion);
    }

    // 畫面內微調角度（例如 90°）
    if (this._mesh) {
      this._mesh.rotation.set(0, 0, THREE.MathUtils.degToRad(this.rotationInScreenDeg));
    }
  }
}