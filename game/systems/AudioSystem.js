// AudioSystem：BGM / SFX 分離音量 + 共同主音量與靜音
export class AudioSystem {
  constructor(){
    /** @type {HTMLAudioElement|null} */ this.bgm = null;
    /** @type {Map<string,string>} */ this.sfx = new Map();

    // 主控：共同影響 BGM 與 SFX（0~1）
    this.masterVolume = 1;
    this.muted = false;

    // 分控：各自細調（0~1）
    this.bgmVolume = 1; // 只影響 BGM
    this.sfxVolume = 1; // 只影響 SFX

    // ★ 變更：新增一個狀態來記錄 BGM 在暫停前是否正在播放
    this._bgmWasPlaying = false;
    
    // 用於追蹤所有正在播放的 SFX 實例，以便進行停止/同步音量/同步靜音
    /** @type {Set<HTMLAudioElement>} */ this._activeSfx = new Set();
    
    // 用於記錄遊戲是否處於暫停狀態 (防止新 SFX 播放)
    this._isPaused = false;
  }

  /** 輔助：安全解析 0~1 音量；若無效則回傳 fallback（保留原值而不是歸 0） */
  _sanitizeVolume(v, fallback){
    const n = (typeof v === 'string' && v.trim() === '') ? NaN : Number(v);
    if (!Number.isFinite(n)) return clamp01(fallback);
    return clamp01(n);
  }

  /** 內部：計算最終音量（會套用 master 與 mute） */
  _finalVolume(channelVolume){
    if (this.muted) return 0;
    return clamp01(this.masterVolume) * clamp01(channelVolume);
  }

  /** 載入並播放 BGM（會套用主音量與 BGM 分音量） */
  async loadBGM(url){
    if (!url) return;
    if (this.bgm) { this.bgm.pause(); this.bgm = null; }
    this.bgm = new Audio(url);
    this.bgm.loop = true;
    this.bgm.muted = this.muted;
    this._applyBgmVolume();
    try { 
      await this.bgm.play();
      this._bgmWasPlaying = true; // ★ 播放成功時更新狀態
    } catch { 
      this._bgmWasPlaying = false; // ★ 播放失敗時也更新狀態
    }
  }

  stopBGM(){ 
    if (this.bgm) {
      this.bgm.pause();
      this._bgmWasPlaying = false; // ★ 停止時更新狀態
    }
  }
  
  /**
   * 停止所有正在播放的 SFX
   */
  stopAllSFX() {
    for (const audio of this._activeSfx) {
      audio.pause();
      audio.currentTime = 0;
    }
    this._activeSfx.clear();
  }

  /** 設定主音量（共同影響 BGM 與 SFX） */
  setMasterVolume(v){
    // 重要修正：使用 _sanitizeVolume，避免無效輸入把音量歸 0
    this.masterVolume = this._sanitizeVolume(v, this.masterVolume);

    // 讓 BGM 立即反映主音量變化
    this._applyBgmVolume();

    // 讓目前正在播放的 SFX 也即時反映主音量變化
    this._updateAllActiveSfxVolumes();
  }

  /** 與舊版相容：setVolume = setMasterVolume */
  setVolume(v){ this.setMasterVolume(v); }

  /** 設定 BGM 分音量（僅影響 BGM） */
  setBGMVolume(v){
    // 重要修正：使用 _sanitizeVolume，避免無效輸入把音量歸 0
    this.bgmVolume = this._sanitizeVolume(v, this.bgmVolume);
    this._applyBgmVolume();
  }

  /** 設定 SFX 分音量（僅影響 SFX） */
  setSFXVolume(v){
    // 重要修正：使用 _sanitizeVolume，避免無效輸入把音量歸 0
    this.sfxVolume = this._sanitizeVolume(v, this.sfxVolume);

    // 讓目前正在播放的 SFX 立即反映新分音量
    this._updateAllActiveSfxVolumes();
  }

  /** 靜音（共同影響 BGM 與 SFX） */
  setMuted(m){
    this.muted = !!m;

    if (this.bgm){
      this.bgm.muted = this.muted;

      // 若解除靜音且 BGM 之前是播放狀態，嘗試恢復
      if (!m && this._bgmWasPlaying) { 
        this.bgm.play().catch(()=>{});
      }
    }

    // 同步所有正在播放的 SFX 靜音狀態
    for (const a of this._activeSfx) {
      a.muted = this.muted;
      // 同時把音量依新的最終值更新（避免瀏覽器行為差異）
      a.volume = this._finalVolume(this.sfxVolume) * clamp01(a.volume / Math.max(this._finalVolume(this.sfxVolume), 0.00001));
      // 上面這行確保解除靜音後維持比例（若不需要比例可改成：a.volume = this._finalVolume(this.sfxVolume);）
    }
  }

  /** 註冊 SFX */
  addSFX(name, url){ if (name && url) this.sfx.set(name, url); }

  /** 播放 SFX（加入追蹤與自動清理） */
  playSFX(name, vol=1){
    const url = this.sfx.get(name); if (!url) return;

    // 單次播放的目標音量（允許 vol 無效時保留 1 的比例）
    const volSan = this._sanitizeVolume(vol, 1);

    // ★ 只有在非暫停狀態下才播放音效
    if (this._isPaused) return;

    const a = new Audio(url);
    a.muted = this.muted;
    a.volume = this._finalVolume(this.sfxVolume * volSan);

    // 追蹤
    this._activeSfx.add(a);

    const cleanup = () => { this._activeSfx.delete(a); };
    a.addEventListener('ended', cleanup);
    a.addEventListener('error', cleanup);

    a.play().catch(()=>{ cleanup(); });
  }

  /** 內部：套用目前主音量/分音量到 BGM element */
  _applyBgmVolume(){
    if (this.bgm){
      this.bgm.volume = this._finalVolume(this.bgmVolume);
    }
  }

  /** 內部：把目前所有正在播放的 SFX 依主音量/分音量重算 */
  _updateAllActiveSfxVolumes(){
    const final = this._finalVolume(this.sfxVolume);
    for (const a of this._activeSfx) {
      // 若需要保留每個實例的相對比例，可記錄原始比例；這裡採用直接覆蓋為當前管道最終值
      a.volume = final;
    }
  }

  /**
   * 遊戲暫停：暫停 BGM 並停止所有 SFX
   */
  onGamePaused() {
    this._isPaused = true;
    if (this.bgm) {
      this._bgmWasPlaying = !this.bgm.paused;
      this.bgm.pause();
    }
    this.stopAllSFX();
  }

  /**
   * 遊戲繼續：可恢復 BGM；SFX 為一次性，不需要恢復
   */
  onGameResumed() {
    this._isPaused = false;
    if (this.bgm && this._bgmWasPlaying) {
      this.bgm.play().catch(() => {});
    }
  }

  // ====== 新增：音量與狀態取得方法（Getters） ======

  /** 取得主音量（0~1） */
  getMasterVolume() { return this.masterVolume; }

  /** 取得 BGM 分音量（0~1，未乘 master） */
  getBGMVolume() { return this.bgmVolume; }

  /** 取得 SFX 分音量（0~1，未乘 master） */
  getSFXVolume() { return this.sfxVolume; }

  /** 取得實際播放時的 BGM 最終音量（考慮 master 與 mute） */
  getFinalBGMVolume() { return this._finalVolume(this.bgmVolume); }

  /** 取得實際播放時的 SFX 最終音量（考慮 master 與 mute） */
  getFinalSFXVolume() { return this._finalVolume(this.sfxVolume); }

  /** 是否靜音 */
  isMuted() { return this.muted; }

  /** 是否處於暫停狀態（阻止新 SFX 播放） */
  isPaused() { return this._isPaused; }

  /** BGM 目前是否正在播放（根據 element 狀態推斷） */
  isBgmPlaying() { return !!(this.bgm && !this.bgm.paused && !this.bgm.ended); }
}

/** 輔助函式：將數值限制在 0.0 到 1.0 之間 */
function clamp01(x){ 
  return Math.max(0, Math.min(1, x)); 
}
