// FinishedView：顯示前五名結果（與頒獎畫面同步）
export class FinishedView {
  mount(root, ctx){
    this.ctx = ctx;
    this.root = root;

    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '10px 12px',
      background: '#0b0d12cc',
      border: '1px solid #2a2f3a',
      borderRadius: '12px',
      color: '#e7eef6',
      backdropFilter: 'blur(6px)',
      minWidth: '220px'
    });

    const title = document.createElement('div');
    title.textContent = '🏆 本局結果（前五名）';
    Object.assign(title.style, { fontSize:'14px', fontWeight:'600' });

    this.list = document.createElement('ol');
    Object.assign(this.list.style, { margin:'0', padding:'0 0 0 18px', lineHeight:'1.6' });

    this.panel.append(title, this.list);
    this.root.appendChild(this.panel);

    this._renderTop5();
  }

  _renderTop5(){
    const top5 = this.ctx.providers.getTop5?.() || [];
    this.list.innerHTML = '';
    top5.forEach((label, i)=>{
      const li = document.createElement('li');
      li.textContent = label;
      this.list.appendChild(li);
    });
  }

  onTick(){ /* 完賽結果固定，可不更新 */ }
  unmount(){ this.panel?.remove(); }
}
