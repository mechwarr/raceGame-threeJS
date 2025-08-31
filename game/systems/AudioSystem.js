// AudioSystem：BGM 與 SFX 管理（音量、靜音、播放/停止）
export class AudioSystem {
  constructor(){
    /** @type {HTMLAudioElement|null} */ this.bgm = null;
    /** @type {Map<string,string>} */ this.sfx = new Map();
    this.volume = 1;   // 0~1
    this.muted  = false;
  }
  async loadBGM(url){
    if (!url) return;
    if (this.bgm) { this.bgm.pause(); this.bgm = null; }
    this.bgm = new Audio(url);
    this.bgm.loop = true;
    this.bgm.volume = this.volume;
    this.bgm.muted = this.muted;
    try { await this.bgm.play(); } catch { /* 可能需使用者互動 */ }
  }
  stopBGM(){ if (this.bgm) this.bgm.pause(); }
  setVolume(v){ this.volume = clamp01(Number(v)||0); if (this.bgm) this.bgm.volume = this.volume; }
  setMuted(m){ this.muted = !!m; if (this.bgm){ this.bgm.muted = this.muted; if (!m) this.bgm.play().catch(()=>{}); } }
  addSFX(name, url){ if (name && url) this.sfx.set(name, url); }
  playSFX(name, vol=1){
    const url = this.sfx.get(name); if (!url) return;
    const a = new Audio(url);
    a.volume = this.muted ? 0 : this.volume * clamp01(vol);
    a.play().catch(()=>{});
  }
}
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
