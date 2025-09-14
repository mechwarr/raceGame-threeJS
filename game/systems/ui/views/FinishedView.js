// FinishedView：置中於 three-canvas 的結果面板（前五名、依色票顯示、水平排列；16:9 RWD）
export class FinishedView {
  mount(root, ctx){
    this.ctx = ctx;
    this.root = root;
    this.canvas = document.getElementById('three-canvas') || root;

    // ===== 可調參數 =====
    this.PANEL_SCALE = 0.92;         // 面板相對於 canvas 的最大佔比
    this.GAP_PERCENT = 2;            // 錦旗之間的 gap（% of panel width）
    this.ITEMS = 5;                  // 錦旗數量（最多 5）
    // 每個錦旗容器的寬度百分比（平均分配）
    this.ITEM_WIDTH_PERCENT = (100 - (this.ITEMS - 1) * this.GAP_PERCENT) / this.ITEMS; // 例如 18.4%

    // 中央面板：固定定位、置中；大小在 _positionToCanvas 依 16:9 計算
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      transform: 'translate(-50%, -20%)',
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 10010,
      pointerEvents: 'auto',
      textAlign: 'center',
      // 讓 gap 用 %：寫在 _positionToCanvas
    });

    this.panel.innerHTML = '';
    document.body.appendChild(this.panel);

    // 定位 + 16:9 尺寸（相對 canvas）
    this._positionToCanvas = () => {
      const rect = this.canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      // 在 canvas 內取能容納的 16:9 最大框
      const maxW = rect.width  * this.PANEL_SCALE;
      const maxH = rect.height * this.PANEL_SCALE;
      let panelW = maxW;
      let panelH = panelW * 9 / 16;
      if (panelH > maxH) { // 高度超了就以高度為準回推寬度
        panelH = maxH;
        panelW = panelH * 16 / 9;
      }

      this._lastPanelWidth = panelW;
      this._lastPanelHeight = panelH;

      Object.assign(this.panel.style, {
        left: `${cx}px`,
        top:  `${cy}px`,
        width: `${panelW}px`,
        height: `${panelH}px`,
        gap: `${this.GAP_PERCENT}%`,   // % of panel width
      });

      // 不必重建 DOM（因為大多用 %），但要更新字級等需 px 的部分
      this._applyResponsiveFont();
    };

    this._renderTop5 = () => {
      const top5 = this.ctx.providers.getTop5?.() || [];
      this.panel.innerHTML = '';

      for (let i = 0; i < this.ITEMS; i++) {
        const label = top5[i] || '';

        // 每個錦旗的容器：用 % 寬、維持相對高度比例（可依圖比例微調）
        const pennantContainer = document.createElement('div');
        Object.assign(pennantContainer.style, {
          position: 'relative',
          width: `${this.ITEM_WIDTH_PERCENT}%`, // 以 panel 寬度的百分比
          // 若想所有錦旗等高，可開啟固定比例（依你的 PNG 外觀調整）
          // aspectRatio: '3 / 4',
          height: 'auto',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        });

        const pennantImg = document.createElement('img');
        pennantImg.src = `/public/finished/pennant0${i+1}.png`;
        Object.assign(pennantImg.style, {
          width: '100%',   // 填滿容器寬
          height: 'auto',  // 高度依圖片比例
          display: 'block',
        });

        const horseNumber = document.createElement('div');
        horseNumber.textContent = label;
        Object.assign(horseNumber.style, {
          position: 'absolute',
          top: '60%',                  // 以錦旗容器高度百分比定位
          left: '50%',
          transform: 'translate(-50%, -50%)',
          color: '#fff',
          fontWeight: 'bold',
          textShadow: '0 0 4px rgba(0,0,0,0.8)',
          letterSpacing: '0.5px',
          display: label ? 'block' : 'none',
          // fontSize 由 _applyResponsiveFont 依 panel 寬度動態套用
        });

        // 打標籤方便 _applyResponsiveFont() 取用
        horseNumber.dataset.role = 'horse-number';

        pennantContainer.append(pennantImg, horseNumber);
        this.panel.appendChild(pennantContainer);
      }

      // 首次渲染時也套一次字級
      this._applyResponsiveFont();
    };

    // 依 panel 寬度換算字級（px），其餘尺寸都用 %
    this._applyResponsiveFont = () => {
      if (!this._lastPanelWidth) return;
      const panelW = this._lastPanelWidth;

      // 算出單面錦旗的實際 px 寬：panelW * (ITEM_WIDTH_PERCENT/100)
      const itemW = panelW * (this.ITEM_WIDTH_PERCENT / 100);

      // 字級 ≈ 錦旗寬的 30%（可依視覺調小/調大）
      const numberFontPx = Math.max(14, itemW * 0.30);

      this.panel.querySelectorAll('[data-role="horse-number"]').forEach(el => {
        el.style.fontSize = `${numberFontPx}px`;
      });
    };

    this._positionToCanvas();
    this._renderTop5();

    // 監聽尺寸/捲動/Canvas 變更
    this._onResize = () => { this._positionToCanvas(); };
    this._onScroll = () => { this._positionToCanvas(); };
    window.addEventListener('resize', this._onResize, { passive:true });
    window.addEventListener('scroll', this._onScroll, { passive:true });
    this._ro = new ResizeObserver(() => this._positionToCanvas());
    this._ro.observe(this.canvas);
  }

  onTick(){ /* 完賽結果固定，不需更新 */ }

  unmount(){
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('scroll', this._onScroll);
    this._ro?.disconnect();
    this.panel?.remove();
  }
}
