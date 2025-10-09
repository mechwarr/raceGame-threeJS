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
    
    // 【新增】用於追蹤所有正在播放的 SFX 實例，以便進行停止操作
    /** @type {Set<HTMLAudioElement>} */ this._activeSfx = new Set();
    
    // 【新增】用於記錄遊戲是否處於暫停狀態 (防止新 SFX 播放)
    this._isPaused = false;
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
   * 【新增】停止所有正在播放的 SFX
   * 這是實現「停止SFX」的核心方法
   */
  stopAllSFX() {
    for (const audio of this._activeSfx) {
      audio.pause(); // 暫停音效
      audio.currentTime = 0; // 重置時間 (可選)
    }
    this._activeSfx.clear(); // 清空追蹤 Set
  }

  /** 設定主音量（共同影響 BGM 與 SFX） */
  setMasterVolume(v){
    this.masterVolume = clamp01(Number(v) || 0);
    this._applyBgmVolume(); // 讓 BGM 立即反映主音量變化
    // 註：SFX 的音量會在新實例播放時才更新
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
      if (!m && this._bgmWasPlaying) { 
        this.bgm.play().catch(()=>{});
      }
    }
    // 註：對於正在播放的 SFX，由於它們的 `muted` 屬性是在 playSFX 中設定的，
    // 要實現立即靜音/解除靜音，需要遍歷 this._activeSfx (但在此處暫不添加以簡化邏輯)
  }

  /** 註冊 SFX */
  addSFX(name, url){ if (name && url) this.sfx.set(name, url); }

  /** 播放 SFX（修改：加入追蹤與自動清理） */
  playSFX(name, vol=1){
    const url = this.sfx.get(name); if (!url) return;
    const a = new Audio(url);
    const final = this._finalVolume(this.sfxVolume * clamp01(vol));
    a.volume = final;
    a.muted = this.muted;
    
    // ★ 只有在非暫停狀態下才播放音效
    if (!this._isPaused) {
      
      // 1. 【新增】開始追蹤這個 SFX 實例
      this._activeSfx.add(a); 

      // 2. 設置事件監聽器：當音效播放完畢或錯誤時，自動從追蹤清單中移除
      const cleanup = () => {
         this._activeSfx.delete(a);
      };
      a.addEventListener('ended', cleanup);
      a.addEventListener('error', cleanup);

      a.play().catch(()=>{ 
        // 播放失敗時也清理，確保 Set 中沒有幽靈實例
        cleanup(); 
      });
    }
  }

  /** 內部：套用目前主音量/分音量到 BGM element */
  _applyBgmVolume(){
    if (this.bgm){
      this.bgm.volume = this._finalVolume(this.bgmVolume);
    }
  }

  /**
   * ★ 遊戲暫停時呼叫：暫停所有音樂和音效（加入停止 SFX）
   */
  onGamePaused() {
    this._isPaused = true;
    if (this.bgm) {
      this._bgmWasPlaying = !this.bgm.paused; // ★ 記錄 BGM 狀態
      this.bgm.pause();
    }
    
    // 【修改點】停止所有正在播放的 SFX
    this.stopAllSFX();
  }

  /**
   * ★ 遊戲繼續時呼叫：恢復所有音樂
   */
  onGameResumed() {
    this._isPaused = false;
    // SFX 不需要恢復，因為它們是一次性播放，只需允許新的 SFX 播放即可。
    if (this.bgm && this._bgmWasPlaying) { // ★ 只有在暫停前正在播放時才恢復
      this.bgm.play().catch(() => {});
    }
  }
}

/** 輔助函式：將數值限制在 0.0 到 1.0 之間 */
function clamp01(x){ 
  return Math.max(0, Math.min(1, x)); 
}