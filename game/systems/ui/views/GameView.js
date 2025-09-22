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
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      background: 'rgba(0,0,0,0.85)', // 使用半透明黑底
      color: '#e7eef6',
      border: 'none',
      borderRadius: '0',
      zIndex: 1000,
      fontFamily: 'sans-serif' // 確保字體統一
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
      flexDirection: 'row',
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
    this.vol.type = 'range';
    this.vol.min = '0';
    this.vol.max = '1';
    this.vol.step = '0.01';
    this.vol.value = '1';

    // 這裡，我們用一個 <style> 標籤來動態插入 CSS 規則
    // 這是解決 JS 中無法直接操作偽元素的常用方式
    const styleId = 'volume-slider-style';
    if (!document.getElementById(styleId)) {
        const styleSheet = document.createElement('style');
        styleSheet.id = styleId;
        styleSheet.innerHTML = `
            #three-canvas + .top-bar input[type="range"]::-webkit-slider-runnable-track {
                background: linear-gradient(to right, #4CAF50 0%, #F5F55B 100%);
                border-radius: 5px;
                height: 5px;
                cursor: pointer;
            }
            #three-canvas + .top-bar input[type="range"]::-webkit-slider-thumb {
                background: #e7eef6;
                width: 15px;
                height: 15px;
                border-radius: 50%;
                border: 2px solid #141a22;
                box-shadow: 0 0 2px rgba(0,0,0,0.5);
                margin-top: -5px;
                cursor: pointer;
            }
            #three-canvas + .top-bar input[type="range"]::-moz-range-track {
                background: linear-gradient(to right, #4CAF50 0%, #F5F55B 100%);
                border-radius: 5px;
                height: 5px;
                cursor: pointer;
            }
            #three-canvas + .top-bar input[type="range"]::-moz-range-thumb {
                background: #e7eef6;
                width: 15px;
                height: 15px;
                border: 2px solid #141a22;
                box-shadow: 0 0 2px rgba(0,0,0,0.5);
                border-radius: 50%;
                cursor: pointer;
            }
        `;
        document.head.appendChild(styleSheet);
    }
    
    Object.assign(this.vol.style, { width: '160px' });
    this.vol.addEventListener('input', ()=> this.ctx.hooks.onVolume?.(Number(this.vol.value)));

    this.bar.append(this.gameIdSpan, this.rankRow, this.soundBtn, this.vol);
    this.bar.classList.add('top-bar'); // 添加 class 以供 CSS 選擇器使用

    // 若能取得 canvas，切為 fixed 並精準貼齊 canvas 上方寬度
    this._positionToCanvas = () => {
      if (!this.canvas || this.bar.parentElement === this.root) return;
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
    const list = getRanking();
    if (!Array.isArray(list)) return;

    // 顏色表
    const COLOR = {
      1:'#F5F55B',  2:'#0605D9',  3:'#5B5A5D',  4:'#CD733B',
      5:'#5DADA9',  6:'#24276F',  7:'#B1B1B1',  8:'#C73F39',
      9:'#601E1A', 10:'#355D3E', 11:'#52194E',
    };
    const SLANT = 14;

    this.rankRow.innerHTML = '';

    list.forEach((label, idx) => {
      const num = parseInt((label+'').match(/\d+/)?.[0] || '0', 10);
      const bg  = COLOR[num] || '#444';

      const pill = document.createElement('div');
      Object.assign(pill.style, {
        height: '22px',
        width: '22px',
        lineHeight: '22px',
        padding: '0 10px',
        fontSize: '12px',
        fontWeight: 700,
        color: '#fff',
        background: bg,
        clipPath: `polygon(${SLANT}px 0, 100% 0, calc(100% - ${SLANT}px) 100%, 0 100%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        whiteSpace: 'nowrap',
        marginLeft: idx === 0 ? '0' : `-${Math.floor(SLANT*0.75)}px`,
        boxShadow: '0 0 0 1px rgba(0,0,0,0.15) inset',
      });
      pill.textContent = label;

      this.rankRow.appendChild(pill);
    });
  }
}