// GameReadyView：透明背景，顯示「遊戲準備完成」，提供「開始」按鈕
export class GameReadyView {
  mount(root, ctx){
    this.ctx = ctx;
    this.root = root;
    this.container = document.createElement('div');
    Object.assign(this.container.style, {
      background: 'transparent',
      padding: '8px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      alignItems: 'flex-end',
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
      padding: '10px 12px',
      borderRadius: '10px',
      border: '1px solid #2a2f3a',
      background: '#0b0d12cc',
      color: '#e7eef6',
      backdropFilter: 'blur(6px)',
      fontSize: '14px',
    });
    box.textContent = '✅ 遊戲準備完成';

    const startBtn = document.createElement('button');
    startBtn.textContent = '▶ 開始遊戲';
    Object.assign(startBtn.style, {
      padding: '8px 10px',
      borderRadius: '10px',
      border: '1px solid #2a2f3a',
      background: '#12161d',
      color: '#e7eef6',
      cursor: 'pointer',
    });
    startBtn.addEventListener('click', ()=>{
      this.ctx.hooks.onStart?.();
      this.ctx.onSwitch?.('game');   // 切換到正式遊戲 UI
    });

    this.container.append(box, startBtn);
    this.root.appendChild(this.container);
  }

  unmount(){
    this.container?.remove();
  }
}
