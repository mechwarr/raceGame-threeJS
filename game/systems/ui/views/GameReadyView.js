// GameReadyView：以 three-canvas 的實際座標為基準，置中一個黑底半透明面板（占 canvas 的 1/3）
// 本版：使用 transform: scale() 依「寬度」等比縮放（以 1920 為基準）
// 新增：倒數字樣也用 scale 依寬度縮放
// API：window.GameReadyViewAPI = { hideWaitingPanel, startCountdown }

export class GameReadyView {
  mount(root, ctx){
    this.ctx = ctx;
    this.root = root;
    this._started = false;

    // 取得 canvas；若找不到就退回 root
    this.canvas = document.getElementById('three-canvas') || root;

    // ========== 基準尺寸（在 1920x1080 時的實際大小）==========
    this._BASE = {
      panelW: 640,         // 面板寬
      panelH: 360,         // 面板高（16:9）
      font: 56,            // 面板字體大小
      padY: 20,
      padX: 40,
      countdownFont: 160,  // 倒數字樣字體大小
      designW: 1920,       // 以寬度做等比縮放
    };

    // ========== 共用面板樣式：等待面板與倒數面板共用這些視覺樣式 ==========
    this._PANEL_STYLE = {
      background: 'rgba(0,0,0,0.6)',
      color: '#fff',
      border: 'none',
      borderRadius: '16px',
      backdropFilter: 'blur(4px)',
      boxShadow: '0 10px 24px rgba(0,0,0,0.35)',

      // 讓子內容（文字）置中
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      
      textAlign: 'center',
      letterSpacing: '0.5px',
      userSelect: 'none',
      zIndex: 10000,
      whiteSpace: 'nowrap',

      // 這裡改成針對 transform 做過渡，縮放更平滑
      transition: 'transform 0.2s ease',
    };

    /* =========================
       等待面板（可被關閉）
    ==========================*/
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed',              // 用 fixed 以 viewport 座標精準覆蓋到 canvas 中心
      left: '0px', top: '0px',        // 會由 positionToCanvas() 動態更新
      transform: 'translate(-50%, -50%) scale(1)', // 初始 scale=1，之後依寬度更新
      
      pointerEvents: 'auto', // 讓等待面板可互動（如點擊關閉，雖然目前沒有實作）
      cursor: 'pointer',     // 加上指標，表示可互動
      
      ...this._PANEL_STYLE, // 匯入共用樣式
    });

    // 先套用「基準尺寸」；實際縮放交給 transform: scale()
    Object.assign(this.panel.style, {
      width: `${this._BASE.panelW}px`,
      height: `${this._BASE.panelH}px`,
      fontSize: `${this._BASE.font}px`,
      padding: `${this._BASE.padY}px ${this._BASE.padX}px`,
    });

    this.panel.textContent = '等待開始遊戲…';

    // 倒數顯示元素（預設不建立；startCountdown 時才建立）
    this.countdownEl = null;

    // 位置計算（面板 & 倒數共用）— 以「寬度」等比縮放
    this.positionToCanvas = () => {
      const rect = this.canvas.getBoundingClientRect();
      const cx = rect.left + rect.width  / 2;
      const cy = rect.top  + rect.height / 2;

      // 依寬度計算 scale（同等寬度縮放）
      const scaleW = rect.width / this._BASE.designW;

      // 等待面板定位 & 縮放
      if (this.panel) {
        Object.assign(this.panel.style, {
          left: cx + 'px',
          top:  cy + 'px',
          transform: `translate(-50%, -50%) scale(${scaleW})`,
        });
      }

      // 倒數字樣定位 & 縮放（字體使用基準值，依 scale 視覺縮放）
      if (this.countdownEl) {
        Object.assign(this.countdownEl.style, {
          left: cx + 'px',
          top:  cy + 'px',
          transform: `translate(-50%, -50%) scale(${scaleW})`,
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

    // 建立倒數元素（現在它是一個包含大字的面板）
    this.countdownEl = document.createElement('div');
    Object.assign(this.countdownEl.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      transform: 'translate(-50%, -50%) scale(1)', // 初始，馬上在 positionToCanvas() 依寬度套 scale
      
      // 匯入共用面板樣式
      ...this._PANEL_STYLE,
      
      // 倒數面板的尺寸與等待面板一致
      width: `${this._BASE.panelW}px`,
      height: `${this._BASE.panelH}px`,
      
      // 其他專屬於倒數的樣式
      color: '#fff',
      textShadow: '0 4px 18px rgba(0,0,0,0.55)',
      fontWeight: '800',
      zIndex: 10001,
      pointerEvents: 'none',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, "Noto Sans TC", sans-serif',
      fontSize: `${this._BASE.countdownFont}px`, // 使用更大的倒數字體大小
    });
    
    document.body.appendChild(this.countdownEl);
    this.positionToCanvas();

    let remain = total;   // 3 → 2 → 1 → GO
    const tick = () => {
      if (!this.countdownEl) return;
      
      // 設定倒數文字
      let text = '';
      let color = '#fff';
      
      if (remain > 0) {
        text = String(remain);
        if (remain <= 10) {
            color = '#f00'; // 剩下 10 秒以內用紅色
        }
        
        this.countdownEl.textContent = text;
        this.countdownEl.style.color = color;
        
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