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

  /** 設定主音量（共同影響 BGM 與 SFX） */
  setMasterVolume(v){
    this.masterVolume = clamp01(Number(v) || 0);
    this._applyBgmVolume(); // 讓 BGM 立即反映主音量變化
  }

  /** 與舊版相容：setVolume = setMasterVolume */
  setVolume(v){ this.setMasterVolume(v); }

  /** 設定 BGM 分音量（僅影響 BGM） */
  setBGMVolume(v){
    const newVolume = clamp01(Number(v) || 0);
    this.bgmVolume = newVolume;
    this._applyBgmVolume();
  }

  /** 設定 SFX 分音量（僅影響 SFX） */
  setSFXVolume(v){
    this.sfxVolume = clamp01(Number(v) || 0);
  }

  /** 靜音（共同影響 BGM 與 SFX） */
  setMuted(m){
    this.muted = !!m;
    if (this.bgm){
      this.bgm.muted = this.muted;
      if (!m && this._bgmWasPlaying) { // ★ 只有在暫停前正在播放時才恢復
        this.bgm.play().catch(()=>{});
      }
    }
  }

  /** 註冊 SFX */
  addSFX(name, url){ if (name && url) this.sfx.set(name, url); }

  /** 播放 SFX（會套用主音量 * SFX 分音量 * 參數 vol） */
  playSFX(name, vol=1){
    const url = this.sfx.get(name); if (!url) return;
    const a = new Audio(url);
    const final = this._finalVolume(this.sfxVolume * clamp01(vol));
    a.volume = final;
    a.muted = this.muted;
    // ★ 只有在非暫停狀態下才播放音效
    if (!this._isPaused) {
      a.play().catch(()=>{});
    }
  }

  /** 內部：套用目前主音量/分音量到 BGM element */
  _applyBgmVolume(){
    if (this.bgm){
      this.bgm.volume = this._finalVolume(this.bgmVolume);
    }
  }

  /**
   * ★ 遊戲暫停時呼叫：暫停所有音樂和音效
   */
  onGamePaused() {
    this._isPaused = true;
    if (this.bgm) {
      this._bgmWasPlaying = !this.bgm.paused; // ★ 記錄 BGM 狀態
      this.bgm.pause();
    }
    // 註：SFX 是一次性播放，無法暫停，所以我們只需停止播放新的 SFX 即可。
  }

  /**
   * ★ 遊戲繼續時呼叫：恢復所有音樂
   */
  onGameResumed() {
    this._isPaused = false;
    if (this.bgm && this._bgmWasPlaying) { // ★ 只有在暫停前正在播放時才恢復
      this.bgm.play().catch(() => {});
    }
  }
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }