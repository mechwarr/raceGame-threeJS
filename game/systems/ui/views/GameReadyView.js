// GameReadyView：以 three-canvas 的實際座標為基準，置中一個黑底半透明面板（占 canvas 的 1/3）
export class GameReadyView {
  mount(root, ctx){
    this.ctx = ctx;
    this.root = root;
    this._started = false;

    // 取得 canvas；若找不到就退回 root
    this.canvas = document.getElementById('three-canvas') || root;

    // 置中的面板（黑底半透明、白字）
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed',              // 用 fixed 以 viewport 座標精準覆蓋到 canvas 中心
      left: '0px', top: '0px',        // 會由 positionToCanvas() 動態更新
      transform: 'translate(-50%, -50%)',
      width: '320px', height: '180px', // 先放預設，稍後會依 canvas 1/3 重算
      background: 'rgba(0,0,0,0.6)',
      color: '#fff',
      border: 'none',
      borderRadius: '16px',
      backdropFilter: 'blur(4px)',
      boxShadow: '0 10px 24px rgba(0,0,0,0.35)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      fontSize: '18px',
      letterSpacing: '0.5px',
      userSelect: 'none',
      cursor: 'pointer',
      zIndex: 10000,
      padding: '12px',
      pointerEvents: 'auto',
    });
    this.panel.textContent = '等待開始遊戲…';

    const handleStart = () => {
      if (this._started) return;
      this._started = true;
      this.ctx.hooks?.onStart?.();   // 通知遊戲開始
      this.ctx.onSwitch?.('game');   // 切到正式遊戲 UI
      this.unmount();
    };

    document.body.appendChild(this.panel);

    // 依 canvas 實際矩形計算面板位置與尺寸（寬高 = canvas 的 1/3，含 min/max）
    this.positionToCanvas = () => {
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(260, Math.min(680, Math.round(rect.width  / 3)));
      const h = Math.max(140, Math.min(360, Math.round(rect.height / 3)));
      const cx = rect.left + rect.width  / 2;
      const cy = rect.top  + rect.height / 2;

      Object.assign(this.panel.style, {
        width:  w + 'px',
        height: h + 'px',
        left:   cx + 'px',
        top:    cy + 'px',
      });
    };

    // 初始定位
    this.positionToCanvas();

    // 監聽尺寸/捲動/Canvas 變更，保持對齊
    this._onResize = () => this.positionToCanvas();
    this._onScroll = () => this.positionToCanvas();
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('scroll', this._onScroll, { passive: true });

    // 精準監看 canvas 尺寸變化
    this._ro = new ResizeObserver(() => this.positionToCanvas());
    this._ro.observe(this.canvas);
  }

  unmount(){
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('scroll', this._onScroll);
    this._ro?.disconnect();
    this.panel?.remove();
    this.panel = null;
  }
}
