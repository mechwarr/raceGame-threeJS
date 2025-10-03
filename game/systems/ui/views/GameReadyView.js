// GameReadyView：以 three-canvas 的實際座標為基準，置中一個黑底半透明面板（占 canvas 的 1/3）
// 本版新增：hideWaitingPanel()、startCountdown(secs, onFinish)，並把 API 掛到 window.GameReadyViewAPI
export class GameReadyView {
  mount(root, ctx){
    this.ctx = ctx;
    this.root = root;
    this._started = false;

    // 取得 canvas；若找不到就退回 root
    this.canvas = document.getElementById('three-canvas') || root;

    /* =========================
       等待面板（可被關閉）
    ==========================*/
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed',              // 用 fixed 以 viewport 座標精準覆蓋到 canvas 中心
      left: '0px', top: '0px',        // 會由 positionToCanvas() 動態更新
      transform: 'translate(-50%, -50%)',
      
      background: 'rgba(0,0,0,0.6)',
      color: '#fff',
      border: 'none',
      borderRadius: '16px',
      backdropFilter: 'blur(4px)',
      boxShadow: '0 10px 24px rgba(0,0,0,0.35)',
      
      // 保持 flex 佈局以置中文字
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      
      textAlign: 'center',
      letterSpacing: '0.5px',
      userSelect: 'none',
      cursor: 'pointer',
      zIndex: 10000,
      pointerEvents: 'auto',
      whiteSpace: 'nowrap',
      transition: 'width 0.2s, height 0.2s, font-size 0.2s',
    });
    this.panel.textContent = '等待開始遊戲…';

    // 倒數顯示元素（預設不建立；startCountdown 時才建立）
    this.countdownEl = null;

    // 位置計算（面板 & 倒數共用）
    this.positionToCanvas = () => {
      const rect = this.canvas.getBoundingClientRect();
      const cx = rect.left + rect.width  / 2;
      const cy = rect.top  + rect.height / 2;

      // 等待面板尺寸：
      if (this.panel) {
        // 1. 寬度比例：Canvas 寬度的 1/3
        const w = Math.round(rect.width / 3);
        // 2. 高度比例：根據 16:9 比例計算 (w * 9 / 16)
        const h = Math.round(w * 9 / 16);

        // 設置合理的最小/最大限制，避免面板過大或過小
        const minW = 260, maxW = 680;
        const minH = Math.round(minW * 9 / 16), maxH = Math.round(maxW * 9 / 16);
        
        const finalW = Math.max(minW, Math.min(maxW, w));
        const finalH = Math.max(minH, Math.min(maxH, h));

        // 字體大小：Canvas 寬度的約 1/40，並隨面板寬度縮放
        const fontSize = Math.max(16, Math.min(32, Math.round(finalW / 18))); 
        
        // 內邊距：與字體大小成比例
        const paddingY = Math.max(8, Math.round(fontSize * 0.75));
        const paddingX = Math.max(16, Math.round(fontSize * 1.5));
        
        Object.assign(this.panel.style, {
          width:      finalW + 'px',
          height:     finalH + 'px',
          left:       cx + 'px',
          top:        cy + 'px',
          fontSize:   fontSize + 'px',
          padding:    `${paddingY}px ${paddingX}px`,
        });
      }

      // 倒數字樣大小：依 canvas 寬做比例
      if (this.countdownEl) {
        const fontSize = Math.max(48, Math.min(220, Math.round(rect.width / 6)));
        Object.assign(this.countdownEl.style, {
          left: cx + 'px',
          top:  cy + 'px',
          fontSize: fontSize + 'px',
        });
      }
    };

    document.body.appendChild(this.panel);
    this.positionToCanvas();

    // 監聽尺寸/捲動/Canvas 變更，保持對齊
    this._onResize = () => this.positionToCanvas();
    this._onScroll = () => this.positionToCanvas();
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('scroll', this._onScroll, { passive: true });

    // 精準監看 canvas 尺寸變化
    this._ro = new ResizeObserver(() => this.positionToCanvas());
    this._ro.observe(this.canvas);

    // 對外 API：掛到 window，方便 game.js 呼叫
    const api = {
      hideWaitingPanel: () => this.hideWaitingPanel(),
      startCountdown: (secs, onFinish) => this.startCountdown(secs, onFinish),
    };
    this._publishAPI(api);
  }

  /* ========= 對外 API ========= */

  hideWaitingPanel() {
    if (this.panel) {
      this.panel.style.display = 'none'; // 不移除，避免之後還想再顯示
    }
  }

  /**
   * 啟動倒數：3,2,1, GO! → 完成後呼叫 onFinish()
   * @param {number} secs  倒數秒數（會取整數與最小 1）
   * @param {Function} onFinish 倒數結束回呼
   */
  startCountdown(secs, onFinish) {
    const total = Math.max(1, Math.floor(secs || 0));

    // 先關閉等待面板
    this.hideWaitingPanel();

    // 若已存在倒數，先清掉
    this._clearCountdown();

    // 建立倒數元素（置中大字）
    this.countdownEl = document.createElement('div');
    Object.assign(this.countdownEl.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      transform: 'translate(-50%, -50%)',
      color: '#fff',
      textShadow: '0 4px 18px rgba(0,0,0,0.55)',
      fontWeight: '800',
      zIndex: 10001,
      pointerEvents: 'none',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, "Noto Sans TC", sans-serif',
    });
    document.body.appendChild(this.countdownEl);
    this.positionToCanvas();

    let remain = total;   // 3 → 2 → 1 → GO
    const tick = () => {
      if (!this.countdownEl) return;
      if (remain > 0) {
        this.countdownEl.textContent = String(remain);
        remain -= 1;
        this._countdownTimer = setTimeout(tick, 1000);
      } else {
          this._clearCountdown();
          try { onFinish && onFinish(); } catch (_) {}
      }
    };
    tick();
  }

  /* ========= 內部工具 ========= */

  _clearCountdown() {
    if (this._countdownTimer) {
      clearTimeout(this._countdownTimer);
      this._countdownTimer = null;
    }
    if (this.countdownEl) {
      this.countdownEl.remove();
      this.countdownEl = null;
    }
  }

  _publishAPI(api) {
    // 把 API 掛在 window.GameReadyViewAPI（同名就覆蓋）
    if (typeof window !== 'undefined') {
      window.GameReadyViewAPI = api;
    }
  }

  unmount(){
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('scroll', this._onScroll);
    this._ro?.disconnect();

    this._clearCountdown();

    if (this.panel) {
      this.panel.remove();
      this.panel = null;
    }

    // 清掉掛在 window 的 API（避免殘留）
    if (typeof window !== 'undefined' && window.GameReadyViewAPI) {
      delete window.GameReadyViewAPI;
    }
  }
}