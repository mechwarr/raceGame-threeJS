// iframe-game-core.js
// 核心：可重用的 Iframe 小遊戲 Instance（非模組；依賴 window.IframeGameUtils）
// API：Create / StartGame / PauseGame / DisposeGame、state、onStateChange()
// 設計重點：
// - 可在 Create 傳入 { width }：固定 16:9，高度自算，之後不再變動；不傳則 RWD。
// - 建立後先下發 host:config（預設 1920×1080 渲染）。
// - loadingRefs 仍支援：overlay/bar/text。
// - readyTimeoutMs（預設 1500ms）：超時自動 ready；設 0 代表必須等子頁回 game:ready。

;(function (global) {
  const U = global.IframeGameUtils || {};
  if (!U.applyIframeAttributes) {
    throw new Error('[IframeGame] 請先載入 iframe-game-utils.js');
  }

  /** @typedef {'idle'|'initializing'|'ready'|'running'|'paused'|'destroyed'} GameState */

  /** @typedef {Object} StartOptions
   *  @property {string=} gameId     // 遊戲識別碼
   *  @property {number[]=} rank     // 例如 [3,5,1,7,2]（1~11）
   *  @property {number=} countdown  // 倒數秒數（整數）
   */

  let instanceCounter = 0;

  class IframeGame {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container
     * @param {string=} options.src
     * @param {string=} options.targetOrigin
     * @param {string=} options.sandbox
     * @param {Object=} options.attributes
     * @param {Object=} options.loadingRefs     { overlay, bar, text }
     * @param {number=} options.width           固定寬度（px），強制 16:9；不傳則 RWD
     * @param {number=} options.readyTimeoutMs  等待 game:ready 超時（預設 1500；0=不自動 ready）
     */
    constructor({
      container,
      src,
      targetOrigin = '*',
      sandbox,
      attributes,
      loadingRefs,
      width,
      readyTimeoutMs = 1500,
    } = {}) {
      if (!container) throw new Error('IframeGame: 必須提供 container');

      // 參數
      this.id = `game-${++instanceCounter}`;
      this.container = container;
      this.src = src;
      this.targetOrigin = targetOrigin;
      this.sandbox = sandbox;
      this.attributes = attributes || {};
      this.loadingRefs = loadingRefs || {};
      this._fixedWidth = typeof width === 'number' && width > 0 ? Math.floor(width) : null;
      this.readyTimeoutMs = typeof readyTimeoutMs === 'number' ? readyTimeoutMs : 1500;

      // 狀態
      /** @type {GameState} */
      this._state = 'idle';
      this._iframe = null;
      this._onMessage = this._onMessage.bind(this);
      this._onStateChange = null;
      this._awaitReadyResolve = null;
      this._destroyed = false;
    }

    /** 目前狀態（唯讀） */
    get state() {
      return this._state;
    }

    /** 註冊狀態變更回呼（用於 UI 狀態顯示等） */
    onStateChange(cb) {
      this._onStateChange = cb;
    }

    _setState(s) {
      this._state = s;
      if (typeof this._onStateChange === 'function') {
        try {
          this._onStateChange(s);
        } catch (_) {}
      }
    }

    /** 建立 iframe + 顯示載入畫面 + 等待 ready（或超時 fallback） */
    async Create() {
      this._assertNotDestroyed();
      if (this._state !== 'idle') return;
      this._setState('initializing');

      // 建立 iframe
      const iframe = document.createElement('iframe');
      iframe.setAttribute('title', '小遊戲');
      iframe.setAttribute('aria-label', '小遊戲');
      U.applyIframeSize(iframe, this._fixedWidth);
      U.applyIframeAttributes(iframe, { sandbox: this.sandbox, attributes: this.attributes });
      if (this.src) iframe.src = this.src;
      else iframe.srcdoc = (global.IframeGameDemo && IframeGameDemo.srcdoc) ? IframeGameDemo.srcdoc() : '<!doctype html><title>Demo</title>';

      // 插入 DOM 與初始化 loading UI
      U.clearContainer(this.container);
      this.container.appendChild(iframe);
      this._iframe = iframe;

      global.addEventListener('message', this._onMessage);
      U.showLoading(this.loadingRefs, true);
      U.setProgress(this.loadingRefs, 5);

      // 等 onload（先 30%）
      await new Promise((resolve) => {
        iframe.addEventListener(
          'load',
          () => {
            U.setProgress(this.loadingRefs, 30);
            resolve();
          },
          { once: true }
        );
      });

      // 下發 host:config（預設 1920×1080；若固定寬則讓子頁鎖定渲染解析度）
      U.postToGame(iframe.contentWindow, U.defaultHostConfig(!!this._fixedWidth), this.targetOrigin);

      // 等待 ready：超時自動 ready（readyTimeoutMs=0 則不自動）
      await new Promise((resolve) => {
        let done = false;
        let timer = null;

        const finishAsReady = () => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          U.setProgress(this.loadingRefs, 100);
          U.showLoading(this.loadingRefs, false);
          this._setState('ready');
          resolve();
        };

        if (this.readyTimeoutMs > 0) timer = setTimeout(finishAsReady, this.readyTimeoutMs);

        this._awaitReadyResolve = () => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          resolve();
        };
      });
    }

    /** 將 StartGame 的參數正規化為 payload 物件 */
    _normalizeStartArgs(argsLike) {
      /** @type {StartOptions} */
      let opt = {};
      const a0 = argsLike[0];

      if (a0 && typeof a0 === 'object' && !Array.isArray(a0)) {
        // 物件寫法：StartGame({ gameId, rank, countdown })
        opt = a0;
      } else {
        // 參數寫法：StartGame(gameId, rank, countdown)
        opt.gameId = (typeof a0 === 'string') ? a0 : undefined;
        opt.rank = Array.isArray(argsLike[1]) ? argsLike[1] : undefined;
        opt.countdown = (typeof argsLike[2] === 'number') ? argsLike[2] : undefined;
      }

      const payload = {};
      if (typeof opt.gameId === 'string') payload.gameId = opt.gameId;
      if (Array.isArray(opt.rank)) payload.rank = opt.rank;
      if (typeof opt.countdown === 'number') payload.countdown = opt.countdown;

      return payload;
    }

    /** 開始：支援 StartGame(gameId, rank, countdown) 或 StartGame({ gameId, rank, countdown }) */
    StartGame(gameIdOrOptions, rank, countdown) {
      this._assertNotDestroyed();
      if (!this._iframe) throw new Error('尚未建立遊戲');
      if (!['ready', 'paused'].includes(this._state)) return;

      const payload = this._normalizeStartArgs(arguments);
      // 傳給子頁（game.js 會讀取 payload.gameId / payload.rank / payload.countdown）
      U.postToGame(this._iframe.contentWindow, { type: 'host:start', payload }, this.targetOrigin);

      // 維持既有行為：立刻把容器側狀態設為 running（子頁會自行倒數後開跑）
      this._setState('running');
    }

    /** 暫停（冪等） */
    PauseGame() {
      this._assertNotDestroyed();
      if (!this._iframe) throw new Error('尚未建立遊戲');
      U.postToGame(this._iframe.contentWindow, { type: 'host:pause' }, this.targetOrigin);
      this._setState('paused');
    }

    /** 結束並釋放資源 */
    DisposeGame() {
      this._assertNotDestroyed();
      if (this._iframe) {
        U.postToGame(this._iframe.contentWindow, { type: 'host:end' }, this.targetOrigin);
      }
      this._teardown();
      this._setState('destroyed');
      this._destroyed = true;
    }

    /** 取得狀態快照（debug 方便） */
    getSnapshot() {
      return {
        id: this.id,
        state: this._state,
        hasIframe: !!this._iframe,
        src: this.src || '(srcdoc demo)',
        fixedWidth: this._fixedWidth,
      };
    }

    /* ── 內部：訊息 / 載入 UI / 清理解構 ─────────────────── */

    _onMessage(ev) {
      if (this.targetOrigin !== '*' && ev.origin !== this.targetOrigin) return;
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        case 'game:progress': {
          const p = Number(msg.value) || 0;
          U.setProgress(this.loadingRefs, Math.max(0, Math.min(100, p)));
          break;
        }
        case 'game:ready': {
          U.setProgress(this.loadingRefs, 100);
          U.showLoading(this.loadingRefs, false);
          this._setState('ready');
          if (this._awaitReadyResolve) {
            this._awaitReadyResolve();
            this._awaitReadyResolve = null;
          }
          break;
        }
        case 'game:error': {
          console.error('[Game Error]', msg.error);
          break;
        }
      }
    }

    _teardown() {
      global.removeEventListener('message', this._onMessage);
      if (this._iframe) {
        try { this._iframe.src = 'about:blank'; } catch {}
        this._iframe.remove();
        this._iframe = null;
      }
      U.clearContainer(this.container);
      U.showLoading(this.loadingRefs, false);
      U.setProgress(this.loadingRefs, 0);
    }

    _assertNotDestroyed() {
      if (this._destroyed) throw new Error('此 instance 已被銷毀，請重新建立');
    }
  }

  // 全域暴露
  global.IframeGame = IframeGame;
})(window);
