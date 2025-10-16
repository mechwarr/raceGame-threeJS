// GameView：TopBar 黑底滿版（貼齊 canvas）、無邊框；名次為平行四邊形色塊（緊貼）
// 修改版：TopBar 高度為 iframe 高度的 10%，內部元素等比縮放
export class GameView {
  mount(root, ctx) {
    this.ctx = ctx;
    this.root = root;

    // 嘗試抓 three.js 的 canvas，若抓不到就退回 root
    this.canvas = document.getElementById('three-canvas') || root;

    // —— TopBar —— //
    this.bar = document.createElement('div');
    this.bar.classList.add('top-bar'); // 添加 class 以供 CSS 選擇器使用

    // 通用樣式，尺寸相關的會由 _updateLayoutAndStyles 動態設定
    Object.assign(this.bar.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      boxSizing: 'border-box',
      padding: '0 12px', // 垂直 padding 設為 0，由 height 控制
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      background: 'rgba(0,0,0,0.85)',
      color: '#e7eef6',
      border: 'none',
      borderRadius: '0',
      zIndex: 1000,
      fontFamily: 'sans-serif'
    });

    // GameID (保持原樣，可取消註解)
    this.gameIdSpan = document.createElement('span');
    // const getGameId = this.ctx?.providers?.getGameId;
    // this.gameIdSpan.textContent = `GameID: ${getGameId ? getGameId() : '--------'}`;
    // Object.assign(this.gameIdSpan.style, { fontSize: '12px', opacity: '0.95', whiteSpace: 'nowrap' });

    // 排名列
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
    this._muted = ctx.providers.getIsMuted();
    this._syncSoundBtnText();
    // 樣式改由 _updateLayoutAndStyles 動態設定
    Object.assign(this.soundBtn.style, {
      border: 'none',
      background: '#141a22',
      color: '#e7eef6',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0', // 內距設為 0，靠字體大小和 height 撐開
    });
    this.soundBtn.addEventListener('click', () => {
      this._muted = !this._muted;
      this.ctx.hooks.onMute?.(this._muted);
      this._syncSoundBtnText();
    });

    this.bar.append(this.gameIdSpan, this.rankRow, this.soundBtn);

    // 掛載元素並設定監聽器
    if (this.canvas && document.body) {
      document.body.appendChild(this.bar);
      this._onResize = () => this._updateLayoutAndStyles();
      this._onScroll = () => this._updateLayoutAndStyles();
      window.addEventListener('resize', this._onResize, { passive: true });
      window.addEventListener('scroll', this._onScroll, { passive: true });
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(this.canvas);
    } else {
      this.root.appendChild(this.bar);
      this._onResize = () => this._updateLayoutAndStyles();
      window.addEventListener('resize', this._onResize, { passive: true });
    }
    
    // 初始渲染一次佈局和排名
    this._updateLayoutAndStyles();

    // 節流控制（每 300ms 更新一次排名資料）
    this._nextRankUpdate = 0;
  }

  onTick() {
    const now = performance.now();
    if (now >= this._nextRankUpdate) {
      this._renderRanking(); // 注意：這裡只更新排名內容，不重新計算樣式
      this._nextRankUpdate = now + 300;
    }
  }

  unmount() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('scroll', this._onScroll);
    this._ro?.disconnect();
    this.bar?.remove();
  }

  // ---- private ----

  /**
   * 核心方法：計算並應用所有動態尺寸和樣式
   */
  _updateLayoutAndStyles() {
    // 1. 計算 TopBar 的基準高度（iframe 高度的 10%）
    const barHeight = window.innerHeight * 0.10;

    // 2. 計算所有衍生尺寸
    const pillScale = 0.8; // Pill 高度佔 Bar 高度的比例
    const pillHeight = barHeight * pillScale;
    const pillSlantRatio = 10 / 22; // 原始傾斜角度與高度的比例 (10px slant / 22px height)
    
    this._layoutMetrics = {
      pillHeight: pillHeight,
      pillPadding: pillHeight * 0.45, // 左右內距
      pillFontSize: pillHeight * 0.9, // 字體大小
      slant: pillHeight * pillSlantRatio, // 平行四邊形的傾斜像素
      // 緊貼效果，負邊距設為傾斜量的一個比例，可微調
      pillMarginLeft: `-${Math.floor(pillHeight * pillSlantRatio * 0.75)}px`,
      
      btnSize: barHeight * 0.75, // 按鈕大小
      btnFontSize: barHeight * 0.5, // 按鈕圖示大小
      btnBorderRadius: barHeight * 0.2, // 按鈕圓角
    };

    // 3. 應用樣式到 TopBar
    Object.assign(this.bar.style, {
        height: `${barHeight}px`,
        padding: `0 ${barHeight * 0.15}px`, // 左右 padding 也等比縮放
        gap: `${barHeight * 0.15}px`,
    });

    // 4. 應用樣式到 Sound按鈕
    Object.assign(this.soundBtn.style, {
      width: `${this._layoutMetrics.btnSize}px`,
      height: `${this._layoutMetrics.btnSize}px`,
      fontSize: `${this._layoutMetrics.btnFontSize}px`,
      borderRadius: `${this._layoutMetrics.btnBorderRadius}px`,
    });

    // 5. 如果有 canvas，精準定位 TopBar
    if (this.canvas && this.bar.parentElement === document.body) {
      const rect = this.canvas.getBoundingClientRect();
      Object.assign(this.bar.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
      });
    }

    // 6. 重新渲染排名 (因為尺寸變了)
    this._renderRanking();
  }

  _syncSoundBtnText() {
    this.soundBtn.textContent = this._muted ? '🔇' : '🔊';
  }

  _renderRanking() {
    // 如果佈局指標還沒計算好，就先不渲染
    if (!this._layoutMetrics) return;

    const getRanking = this.ctx?.providers?.getRanking;
    if (!getRanking) return;
    const list = getRanking();
    if (!Array.isArray(list)) return;

    // 顏色表
    const COLOR = {
      1: '#F5F55B', 2: '#0605D9', 3: '#5B5A5D', 4: '#CD733B',
      5: '#5DADA9', 6: '#24276F', 7: '#B1B1B1', 8: '#C73F39',
      9: '#601E1A', 10: '#355D3E', 11: '#52194E',
    };
    
    // 從 this._layoutMetrics 獲取動態計算的尺寸
    const {
        pillHeight,
        pillPadding,
        pillFontSize,
        slant,
        pillMarginLeft,
    } = this._layoutMetrics;

    this.rankRow.innerHTML = '';

    list.forEach((label, idx) => {
      const num = parseInt((label + '').match(/\d+/)?.[0] || '0', 10);
      const bg = COLOR[num] || '#444';

      const pill = document.createElement('div');
      
      // 使用動態計算的尺寸來設定樣式
      Object.assign(pill.style, {
        height: `${pillHeight}px`,
        lineHeight: `${pillHeight}px`,
        padding: `0 ${pillPadding}px`,
        fontSize: `${pillFontSize}px`,
        fontWeight: 700,
        color: '#fff',
        background: bg,
        clipPath: `polygon(${slant}px 0, 100% 0, calc(100% - ${slant}px) 100%, 0 100%)`,
        textShadow: '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        whiteSpace: 'nowrap',
        marginLeft: idx === 0 ? '0' : pillMarginLeft,
        boxShadow: '0 0 0 1px rgba(0,0,0,0.15) inset',
      });
      pill.textContent = label;

      this.rankRow.appendChild(pill);
    });
  }
}