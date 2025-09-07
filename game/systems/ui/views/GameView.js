// GameView：TopBar 黑底滿版（貼齊 canvas）、無邊框；名次為平行四邊形色塊（緊貼）
export class GameView {
  mount(root, ctx){
    this.ctx = ctx;
    this.root = root;

    // 嘗試抓 three.js 的 canvas，若抓不到就退回 root
    this.canvas = document.getElementById('three-canvas') || root;

    // —— TopBar —— //
    this.bar = document.createElement('div');

    // 先給通用樣式（若後面偵測到 canvas，會切換為 position:fixed 並鎖定到 canvas）
    Object.assign(this.bar.style, {
      position: 'absolute',     // 若沒抓到 canvas 會維持 absolute + width:100%
      left: '0',
      top: '0',
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      background: '#000',       // 黑底
      color: '#e7eef6',
      border: 'none',           // 無邊框
      borderRadius: '0',
      zIndex: 1000,
    });

    // GameID
    this.gameIdSpan = document.createElement('span');
    const getGameId = this.ctx?.providers?.getGameId;
    this.gameIdSpan.textContent = `GameID: ${getGameId ? getGameId() : '--------'}`;
    Object.assign(this.gameIdSpan.style, { fontSize: '12px', opacity: '0.95', whiteSpace: 'nowrap' });

    // 排名列（緊貼排版；用負邊距貼合斜邊）
    this.rankRow = document.createElement('div');
    Object.assign(this.rankRow.style, {
      display: 'flex',
      flexDirection: 'row',   // 由左到右（第一名在最左）
      alignItems: 'center',
      gap: '0',
      flex: '1',
      minWidth: '0',
      overflow: 'hidden',
    });

    // 聲音按鈕
    this.soundBtn = document.createElement('button');
    this._muted = false;
    this._syncSoundBtnText();
    Object.assign(this.soundBtn.style, {
      padding: '6px 10px',
      borderRadius: '10px',
      border: 'none',
      background: '#141a22',
      color: '#e7eef6',
      cursor: 'pointer',
      fontSize: '12px',
      whiteSpace: 'nowrap',
    });
    this.soundBtn.addEventListener('click', ()=>{
      this._muted = !this._muted;
      this.ctx.hooks.onMute?.(this._muted);
      this._syncSoundBtnText();
    });

    // 音量 Slider
    this.vol = document.createElement('input');
    this.vol.type = 'range'; this.vol.min = '0'; this.vol.max = '1'; this.vol.step = '0.01'; this.vol.value = '1';
    Object.assign(this.vol.style, { width: '160px' });
    this.vol.addEventListener('input', ()=> this.ctx.hooks.onVolume?.(Number(this.vol.value)));

    this.bar.append(this.gameIdSpan, this.rankRow, this.soundBtn, this.vol);

    // 若能取得 canvas，切為 fixed 並精準貼齊 canvas 上方寬度
    this._positionToCanvas = () => {
      if (!this.canvas || this.bar.parentElement === this.root) return; // 若沒移到 body 就不處理
      const rect = this.canvas.getBoundingClientRect();
      Object.assign(this.bar.style, {
        position: 'fixed',
        left: rect.left + 'px',
        top:  rect.top  + 'px',
        width: rect.width + 'px',
      });
    };

    // 若抓到 canvas → 掛到 body 並精準定位；否則掛到 root（寬度 100%）
    if (this.canvas && document.body) {
      document.body.appendChild(this.bar);
      this._positionToCanvas();
      this._onResize = () => this._positionToCanvas();
      this._onScroll = () => this._positionToCanvas();
      window.addEventListener('resize', this._onResize, { passive: true });
      window.addEventListener('scroll', this._onScroll, { passive: true });
      this._ro = new ResizeObserver(this._positionToCanvas);
      this._ro.observe(this.canvas);
    } else {
      // 退回 root 寬度
      this.root.appendChild(this.bar);
    }

    // 初始渲染一次排名
    this._renderRanking();

    // 節流控制（每 300ms 更新一次）
    this._nextRankUpdate = 0;
  }

  onTick(){
    const now = performance.now();
    if (now >= this._nextRankUpdate) {
      this._renderRanking();
      this._nextRankUpdate = now + 300;
    }
  }

  unmount(){
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('scroll', this._onScroll);
    this._ro?.disconnect();
    this.bar?.remove();
  }

  // ---- private ----
  _syncSoundBtnText(){
    this.soundBtn.textContent = this._muted ? '🔇 靜音' : '🔊 聲音';
  }

  _renderRanking(){
    const getRanking = this.ctx?.providers?.getRanking;
    if (!getRanking) return;
    const list = getRanking();                 // 例如：['#3','#1','#5', ...]（第一名在最左）
    if (!Array.isArray(list)) return;

    // 顏色表
    const COLOR = {
      1:'#F5F55B',  2:'#0605D9',  3:'#5B5A5D',  4:'#CD733B',
      5:'#5DADA9',  6:'#24276F',  7:'#B1B1B1',  8:'#C73F39',
      9:'#601E1A', 10:'#355D3E', 11:'#52194E',
    };
    const SLANT = 14; // 斜邊偏移（px），同時用來計算負邊距

    this.rankRow.innerHTML = '';

    list.forEach((label, idx) => {
      const num = parseInt((label+'').match(/\d+/)?.[0] || '0', 10);
      const bg  = COLOR[num] || '#444';

      const pill = document.createElement('div');
      Object.assign(pill.style, {
        height: '22px',
        lineHeight: '22px',
        padding: '0 10px',
        fontSize: '12px',
        fontWeight: 700,
        color: '#fff',
        background: bg,
        // 平行四邊形（右上、左下）
        clipPath: `polygon(${SLANT}px 0, 100% 0, calc(100% - ${SLANT}px) 100%, 0 100%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        whiteSpace: 'nowrap',
        // 緊貼排版：後續色塊用負邊距吃掉斜角
        marginLeft: idx === 0 ? '0' : `-${Math.floor(SLANT*0.75)}px`,
        boxShadow: '0 0 0 1px rgba(0,0,0,0.15) inset', // 內陰影微分界線（非邊框）
      });
      pill.textContent = label; // 保留原始「#編號」文字

      this.rankRow.appendChild(pill);
    });
  }
}
