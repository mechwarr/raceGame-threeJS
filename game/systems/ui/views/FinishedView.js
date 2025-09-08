// FinishedView：置中於 three-canvas 的結果面板（前五名、依色票顯示、平行四邊形）
export class FinishedView {
  mount(root, ctx){
    this.ctx = ctx;
    this.root = root;

    // 找 canvas 作為定位基準；找不到就退回 root
    this.canvas = document.getElementById('three-canvas') || root;

    // 中央面板
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed',                 // 用 viewport 座標鎖在 canvas 中心
      left: '0px',
      top: '0px',
      transform: 'translate(-50%, -50%)',
      width: '40vw',                     // 先給個預設，之後依 canvas 重算
      maxWidth: '560px',
      minWidth: '280px',
      background: 'rgba(0,0,0,0.7)',     // 黑底半透明
      color: '#e7eef6',
      border: 'none',                    // 無邊框
      borderRadius: '16px',
      backdropFilter: 'blur(6px)',
      boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
      padding: '16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      zIndex: 10010,
      pointerEvents: 'auto',
      textAlign: 'center',
    });

    // 標題
    const title = document.createElement('div');
    title.textContent = '🏆 本局結果（前五名）';
    Object.assign(title.style, { fontSize:'16px', fontWeight:'700', letterSpacing:'0.3px' });

    // 前五名列表容器
    this.list = document.createElement('div');
    Object.assign(this.list.style, {
      display:'flex',
      flexDirection:'column',
      gap:'8px',
      marginTop:'2px',
    });

    this.panel.append(title, this.list);
    document.body.appendChild(this.panel);

    // 依 canvas 定位與寬度（置中，寬度為 canvas 的 40%）
    this._positionToCanvas = () => {
      const rect = this.canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const w = Math.max(280, Math.min(560, Math.round(rect.width * 0.4)));

      Object.assign(this.panel.style, {
        left: cx + 'px',
        top:  cy + 'px',
        width: w + 'px',
      });
    };
    this._positionToCanvas();

    // 監聽尺寸/捲動/Canvas 變更
    this._onResize = () => this._positionToCanvas();
    this._onScroll = () => this._positionToCanvas();
    window.addEventListener('resize', this._onResize, { passive:true });
    window.addEventListener('scroll', this._onScroll, { passive:true });
    this._ro = new ResizeObserver(() => this._positionToCanvas());
    this._ro.observe(this.canvas);

    // 渲染前五名
    this._renderTop5();
  }

  _renderTop5(){
    const top5 = this.ctx.providers.getTop5?.() || [];
    this.list.innerHTML = '';

    // 顏色表
    const COLOR = {
      1:'#F5F55B',  2:'#0605D9',  3:'#5B5A5D',  4:'#CD733B',
      5:'#5DADA9',  6:'#24276F',  7:'#B1B1B1',  8:'#C73F39',
      9:'#601E1A', 10:'#355D3E', 11:'#52194E',
    };
    const SLANT = 16; // 平行四邊形斜邊像素

    top5.forEach((label, i) => {
      const num = parseInt((label+'').match(/\d+/)?.[0] || '0', 10);
      const bg  = COLOR[num] || '#444';

      // 每一列（排名 + 色塊）
      const row = document.createElement('div');
      Object.assign(row.style, {
        display:'flex',
        alignItems:'center',
        justifyContent:'center',
        gap:'10px',
      });

      // 排名徽記（1/2/3 用獎牌，其餘用數字）
      const rankBadge = document.createElement('div');
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `第${i+1}`;
      rankBadge.textContent = medal;
      Object.assign(rankBadge.style, {
        minWidth:'46px',
        textAlign:'right',
        fontWeight:'700',
      });

      // 平行四邊形色塊：顯示「#號碼」
      const pill = document.createElement('div');
      pill.textContent = label;
      Object.assign(pill.style, {
        height:'28px',
        lineHeight:'28px',
        padding:'0 14px',
        fontSize:'14px',
        fontWeight:'800',
        color:'#fff',
        background:bg,
        clipPath: `polygon(${SLANT}px 0, 100% 0, calc(100% - ${SLANT}px) 100%, 0 100%)`,
        display:'inline-flex',
        alignItems:'center',
        justifyContent:'center',
        boxShadow:'0 0 0 1px rgba(0,0,0,0.18) inset',
        letterSpacing:'0.5px',
      });

      row.append(rankBadge, pill);
      this.list.appendChild(row);
    });
  }

  onTick(){ /* 完賽結果固定，不需更新 */ }

  unmount(){
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('scroll', this._onScroll);
    this._ro?.disconnect();
    this.panel?.remove();
  }
}
