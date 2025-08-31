// UIController：統一管理 UI 視圖（View）的建立/切換/銷毀與週期更新
// --------------------------------------------------
// View 介面規約：
// class SomeView {
//   mount(rootEl, ctx) { /* 建立 DOM；ctx = { hooks, providers, onSwitch } */ }
//   unmount() { /* 釋放 DOM/事件 */ }
//   onTick?() { /* 非必要：每 300ms 呼叫一次，用於即時資訊更新 */ }
// }
// --------------------------------------------------
export class UIController {
  /**
   * @param {{
   *   mountSelector?: string,                // 掛載容器（預設 #ui-overlay）
   *   hooks: object,                         // 動作：onStart/onPause/onMute/setVolume/...（由 game.js 傳入）
   *   providers: object,                     // 資料提供：getGameId/getRanking/...（由 game.js 傳入）
   *   initialView?: string,                  // 初始要顯示的 view key（可選）
   *   tickIntervalMs?: number                // 週期更新間隔（預設 300ms）
   * }} options
   */
  constructor({ mountSelector = '#ui-overlay', hooks, providers, initialView, tickIntervalMs = 300 }){
    this.hooks = hooks || {};
    this.providers = providers || {};
    this.root = document.querySelector(mountSelector) || this._autoMount();
    this.views = new Map();          // key -> ViewClass
    this.active = null;              // { key, instance }
    this.ticker = null;
    this.tickIntervalMs = tickIntervalMs;

    if (initialView) this.show(initialView);
  }

  register(key, ViewClass){
    this.views.set(key, ViewClass);
  }

  show(key){
    const ViewClass = this.views.get(key);
    if (!ViewClass) { console.warn('[UIController] 未註冊的 view:', key); return; }
    this._stopTick();
    this._unmountActive();

    const instance = new ViewClass();
    const ctx = {
      hooks: this.hooks,
      providers: this.providers,
      onSwitch: (nextKey)=> this.show(nextKey),
    };
    instance.mount(this.root, ctx);
    this.active = { key, instance };

    this._startTick();
  }

  destroy(){
    this._stopTick();
    this._unmountActive();
    this.root.innerHTML = '';
  }

  // ---- private ----
  _autoMount(){
    const d = document.createElement('div');
    d.id = 'ui-overlay';
    d.style.position = 'absolute';
    d.style.right = '12px';
    d.style.top = '12px';
    document.body.appendChild(d);
    return d;
  }

  _unmountActive(){
    if (this.active?.instance?.unmount) {
      this.active.instance.unmount();
    }
    this.active = null;
  }

  _startTick(){
    if (!this.active?.instance?.onTick) return;
    this.ticker = setInterval(()=> {
      try { this.active.instance.onTick(); } catch (e) { /* ignore */ }
    }, this.tickIntervalMs);
  }

  _stopTick(){
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
  }
}
