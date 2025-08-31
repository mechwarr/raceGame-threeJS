// GameView：頂部黑色 TopBar，內容：GameID、即時賽馬排序（右→左）、聲音按鈕與音量 Slider
export class GameView {
  mount(root, ctx){
    this.ctx = ctx;
    this.root = root;

    // 外層（TopBar）
    this.bar = document.createElement('div');
    Object.assign(this.bar.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '8px 12px',
      background: '#0b0d12',
      border: '1px solid #2a2f3a',
      borderRadius: '12px',
      color: '#e7eef6',
    });

    // GameID
    this.gameIdSpan = document.createElement('span');
    this.gameIdSpan.textContent = `GameID: ${this.ctx.providers.getGameId?.() ?? '--------'}`;
    Object.assign(this.gameIdSpan.style, { fontSize: '12px', opacity: '0.95' });

    // 排名列（由右至左展示）
    this.rankRow = document.createElement('div');
    Object.assign(this.rankRow.style, {
      display: 'flex',
      flexDirection: 'row-reverse', // 右→左
      gap: '6px',
      flex: '1',
      justifyContent: 'flex-start',
      alignItems: 'center',
    });

    // 聲音按鈕
    this.soundBtn = document.createElement('button');
    this._muted = false;
    this._syncSoundBtnText();
    Object.assign(this.soundBtn.style, {
      padding: '6px 10px',
      borderRadius: '10px',
      border: '1px solid #2a2f3a',
      background: '#12161d',
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
    this.root.appendChild(this.bar);

    // 初始渲染一次排名
    this._renderRanking();
  }

  onTick(){
    // 每 300ms 更新一次排名即可
    this._renderRanking();
  }

  unmount(){
    this.bar?.remove();
  }

  // ---- private ----
  _syncSoundBtnText(){
    this.soundBtn.textContent = this._muted ? '🔇 靜音' : '🔊 聲音';
  }

  _renderRanking(){
    const getRanking = this.ctx.providers.getRanking;
    if (!getRanking) return;
    const list = getRanking(); // 期望回傳字串陣列，如：['Lane#3','Lane#1','Lane#5', ...]（第 1 名先出現）
    if (!Array.isArray(list)) return;

    this.rankRow.innerHTML = '';
    // 由右至左排列 → 元素順序照「第一名→第二名→第三名」append 即可（因為 flex row-reverse）
    for (const label of list){
      const pill = document.createElement('span');
      pill.textContent = label;
      Object.assign(pill.style, {
        fontSize: '12px',
        padding: '3px 8px',
        borderRadius: '999px',
        background: '#122',
        border: '1px solid #234',
      });
      this.rankRow.appendChild(pill);
    }
  }
}
