// UIController.js
// 只做狀態切換與掛載，不再內建任何特定 UI。
// 你可以用它的事件匯流排，以及自動派發的 leader 事件。

export const UI_STATUS = {
  READY: 'ready',
  PLAYING: 'playing',
  ENDED: 'ended',
};

/**
 * @typedef {(ctx: ViewContext) => HTMLElement | { el: HTMLElement, dispose?: () => void }} ViewFactory
 * @typedef {{ status: string, root: HTMLElement, on: (type:string,fn:Function)=>void, off:(type:string,fn:Function)=>void, dispatch:(type:string,detail?:any)=>void, helpers: typeof h }} ViewContext
 */

export class UIController {
  /**
   * @param {{ views?: Record<string, ViewFactory>, leaderProvider?: ()=>string }} opts
   * @param {string} [mountSelector='#ui-overlay']
   */
  constructor(opts = {}, mountSelector = '#ui-overlay') {
    const { views = {}, leaderProvider } = opts;
    this.root = document.querySelector(mountSelector) || this._autoMount();
    this._views = views;        // { ready, playing, ended } 由外部注入
    this._current = null;       // { el, dispose? }
    this._status = null;

    // 簡易事件匯流排
    this._em = new Map(); // type -> Set<fn>
    this.on = this.on.bind(this);
    this.off = this.off.bind(this);
    this.dispatch = this.dispatch.bind(this);

    // 可選：定時把 leader name 丟出去，view 自己決定要不要聽
    if (typeof leaderProvider === 'function') {
      this._leaderTicker = setInterval(() => {
        const name = leaderProvider() ?? '-';
        this.dispatch('leader:update', { name });
      }, 300);
    }
  }

  /** 設定/覆蓋各狀態的 view 工廠 */
  setViews(views) {
    Object.assign(this._views, views);
    return this;
  }

  /** 切換 UI 狀態並掛載對應 view */
  setStatus(status) {
    if (this._status === status) return;
    this._status = status;
    this._mount(status);
  }

  /** 目前狀態 */
  getStatus() { return this._status; }

  /** 釋放資源 */
  destroy() {
    if (this._leaderTicker) clearInterval(this._leaderTicker);
    this._unmount();
    this._em.clear();
    this.root.innerHTML = '';
  }

  /** 事件：訂閱 */
  on(type, fn) {
    if (!this._em.has(type)) this._em.set(type, new Set());
    this._em.get(type).add(fn);
  }
  /** 事件：退訂 */
  off(type, fn) {
    this._em.get(type)?.delete(fn);
  }
  /** 事件：派發（同時也會在 root 派發 CustomEvent，方便純 DOM 監聽） */
  dispatch(type, detail) {
    this._em.get(type)?.forEach(fn => fn(detail));
    this.root.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---- internal ----
  _autoMount() {
    const d = document.createElement('div');
    d.id = 'ui-overlay';
    document.body.appendChild(d);
    return d;
  }

  _unmount() {
    if (this._current?.dispose) {
      // 給外部 view 清理事件/interval
      try { this._current.dispose(); } catch (e) { /* noop */ }
    }
    this.root.replaceChildren(); // 清掉內容
    this._current = null;
  }

  _mount(status) {
    this._unmount();
    const factory = this._views[status];
    if (!factory) return;

    /** @type {ViewContext} */
    const ctx = {
      status,
      root: this.root,
      on: this.on,
      off: this.off,
      dispatch: this.dispatch,
      helpers: h,
    };

    const out = factory(ctx);
    const el = out?.el ?? out; // 支援回傳 el 或 {el, dispose}
    this.root.appendChild(el);
    this._current = typeof out === 'object' ? out : { el };
  }
}

/** DOM helpers，外部 view 可直接使用 */
export const h = {
  div: (cls, ...children) => {
    const el = document.createElement('div');
    if (cls) el.className = cls;
    el.append(...children);
    return el;
  },
  span: (cls, text) => {
    const el = document.createElement('span');
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  },
  btn: (text, on) => {
    const el = document.createElement('button');
    el.textContent = text;
    if (on) el.addEventListener('click', on);
    return el;
  },
  label: (text) => {
    const el = document.createElement('label');
    el.textContent = text;
    return el;
  },
  input: (type, placeholder = '') => {
    const el = document.createElement('input');
    el.type = type;
    if (placeholder) el.placeholder = placeholder;
    return el;
  },
};
