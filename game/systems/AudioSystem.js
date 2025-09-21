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
    try { await this.bgm.play(); } catch { /* 可能需使用者互動 */ }
  }

  stopBGM(){ if (this.bgm) this.bgm.pause(); }

  /** 設定主音量（共同影響 BGM 與 SFX） */
  setMasterVolume(v){
    this.masterVolume = clamp01(Number(v) || 0);
    this._applyBgmVolume(); // 讓 BGM 立即反映主音量變化
  }

  /** 與舊版相容：setVolume = setMasterVolume */
  setVolume(v){ this.setMasterVolume(v); }

  /** 設定 BGM 分音量（僅影響 BGM） */
  setBGMVolume(v){
    this.bgmVolume = clamp01(Number(v) || 0);
    this._applyBgmVolume();
  }

  /** 設定 SFX 分音量（僅影響 SFX） */
  setSFXVolume(v){
    this.sfxVolume = clamp01(Number(v) || 0);
    // SFX 是即播即棄，不需立即套用；會在 playSFX 時計算
  }

  /** 靜音（共同影響 BGM 與 SFX） */
  setMuted(m){
    this.muted = !!m;
    if (this.bgm){
      this.bgm.muted = this.muted;
      if (!m) this.bgm.play().catch(()=>{});
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
    a.play().catch(()=>{});
  }

  /** 內部：套用目前主音量/分音量到 BGM element */
  _applyBgmVolume(){
    if (this.bgm){
      this.bgm.volume = this._finalVolume(this.bgmVolume);
    }
  }
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
