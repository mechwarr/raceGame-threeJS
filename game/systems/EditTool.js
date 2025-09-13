// systems/EditTool.js
// 開發用相機調校工具（可選開關）
// - 距離偵測浮層（右上角）
// - Camera Panel（可即時調整 CAM 重要參數 + 儲存到 localStorage）
// - 方向向量面板（調整 FIXED_DIR 或自訂方向，會自動 normalize）
//
// 使用：
//   import { createEditTool, mountEditTool } from './systems/tools/EditTool.js';
//   // 方式一：建構 → 手動 mount / update / destroy
//   const tool = createEditTool({ getCAM, getCamera, getDirVec, startLineX });
//   tool.mount({ enable: true, panels: { distance:true, camera:true, dir:true } });
//   // 每幀：tool.update(distance, gameState);
//   // 收掉：tool.destroy();
//
//   // 方式二：一次搞定（若 enable=false 則不做任何事）
//   const tool = mountEditTool(true, { getCAM, getCamera, getDirVec, startLineX });
//   // 每幀：tool.update(distance, gameState);
//
// 備註：
// - getCAM(): 回傳 CAM 物件（需可被直接 mutate）
// - getCamera(): 回傳 THREE.PerspectiveCamera 物件
// - getDirVec(): 回傳 THREE.Vector3（你的 FIXED_DIR 或任意向量參考）
// - startLineX: 用於 SIDE_READY.x 預設顯示（若 CAM 沒提供）

/* =========================
 * 小工具：安全取值
 * ========================= */
function _isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function _assignDeep(dst, src) {
  for (const k in src) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      dst[k] ??= {};
      _assignDeep(dst[k], v);
    } else if (v !== undefined) {
      dst[k] = v;
    }
  }
}

/* =========================
 * 距離偵測浮層
 * ========================= */
function _createDistanceOverlay(getCAM) {
  let node = null;
  function mount() {
    if (node) return;
    const CAM = getCAM();
    const box = document.createElement('div');
    box.style.cssText = `
      position: fixed; top: 10px; right: 10px; z-index: 99999;
      font: 12px/1.45 system-ui,-apple-system,Segoe UI,Roboto,'Noto Sans TC',sans-serif;
      color: #eaeaea; background: #00000090; backdrop-filter: blur(6px);
      padding: 8px 10px; border: 1px solid #444; border-radius: 10px;
      box-shadow: 0 6px 16px #0006; min-width: 220px; pointer-events: none;
    `;
    box.innerHTML = `
      <div style="font-weight:600; margin-bottom:4px;">Camera Distance</div>
      <div id="cam-dbg-state">State: -</div>
      <div id="cam-dbg-d">d: -</div>
      <div id="cam-dbg-fov">FOV: ${CAM?.FOV_DEG ?? '-'}</div>
      <div id="cam-dbg-viewh">VIEW_HEIGHT: ${CAM?.VIEW_HEIGHT ?? '-'}</div>
      <div id="cam-dbg-min">LOOK_AHEAD_MIN: ${CAM?.LOOK_AHEAD_MIN ?? '-'}</div>
    `;
    document.body.appendChild(box);
    node = {
      root: box,
      state: box.querySelector('#cam-dbg-state'),
      d: box.querySelector('#cam-dbg-d'),
      fov: box.querySelector('#cam-dbg-fov'),
      vh: box.querySelector('#cam-dbg-viewh'),
      min: box.querySelector('#cam-dbg-min'),
    };
  }
  function update(distance, state) {
    if (!node) return;
    node.state.textContent = `State: ${state || '-'}`;
    node.d.textContent = `d: ${_isNum(distance) ? distance.toFixed(3) : '-'}`;
  }
  function destroy() {
    if (!node) return;
    node.root.remove();
    node = null;
  }
  return { mount, update, destroy };
}

/* =========================
 * Camera Panel（可即時調 CAM）
 * ========================= */
function _makeSlider(label, get, set, {min, max, step=0.01, width='100%'} = {}) {
  const row = document.createElement('div');
  row.style.cssText = 'display:grid; grid-template-columns: 80px 1fr 72px; gap:6px; align-items:center; margin:6px 0;';
  const lab = document.createElement('div'); lab.textContent = label; lab.style.opacity='0.9';
  const rng = document.createElement('input'); rng.type='range'; rng.min=min; rng.max=max; rng.step=step; rng.style.width=width;
  const num = document.createElement('input'); num.type='number'; num.min=min; num.max=max; num.step=step;
  num.style.cssText = 'width:100%; background:#111; color:#eee; border:1px solid #444; border-radius:6px; padding:2px 6px;';
  row.appendChild(lab); row.appendChild(rng); row.appendChild(num);

  const sync = () => { const v = Number(get()); rng.value = String(v); num.value = Number.isFinite(v) ? v.toFixed(3) : ''; };
  const commit = (v) => { const nv = Math.min(max, Math.max(min, Number(v))); set(nv); sync(); };

  rng.addEventListener('input', () => commit(rng.value));
  num.addEventListener('change', () => commit(num.value));

  sync();
  return { row, sync };
}

function _createCameraPanel(getCAM, getCamera, startLineX) {
  const STORAGE_KEY = 'CAM_SETTINGS_V1';
  let wrap = null;
  const load = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      const CAM = getCAM();
      _assignDeep(CAM, saved);
    } catch {}
  };
  const save = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(getCAM())); } catch {}
  };
  const applyToCamera = () => {
    const camera = getCamera?.();
    if (!camera) return;
    const CAM = getCAM();
    camera.fov = CAM.FOV_DEG;
    camera.updateProjectionMatrix();
  };

  function mount() {
    if (wrap) return;
    load();
    applyToCamera();

    const CAM = getCAM();

    wrap = document.createElement('div');
    wrap.style.cssText = `
      position: fixed; right: 12px; bottom: 12px; z-index: 99999;
      width: 320px; color:#eee; background:#0b0b0fcc; backdrop-filter: blur(8px);
      border: 1px solid #3b3b3f; border-radius: 12px; padding: 10px 12px;
      font: 12px/1.45 system-ui,-apple-system,Segoe UI,Roboto,'Noto Sans TC',sans-serif;
      box-shadow: 0 12px 28px #0009;
    `;

    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';
    header.innerHTML = `<div style="font-weight:700;">Camera Panel</div>`;
    const btn = document.createElement('button');
    btn.textContent = '收合';
    btn.style.cssText = 'cursor:pointer; font-size:12px; color:#ddd; background:#222; border:1px solid #444; padding:2px 8px; border-radius:6px;';
    header.appendChild(btn);
    wrap.appendChild(header);

    const panel = document.createElement('div');

    const makeGroup = (title) => {
      const g = document.createElement('div');
      const t = document.createElement('div');
      t.textContent = title;
      t.style.cssText = 'font-weight:600; opacity:.9; margin:8px 0 4px;';
      g.appendChild(t);
      return g;
    };

    // View
    const gv = makeGroup('View');
    const sViewHeight = _makeSlider('VIEW_HEIGHT',
      () => getCAM().VIEW_HEIGHT,
      v => { getCAM().VIEW_HEIGHT = v; save(); applyToCamera(); },
      { min: 5, max: 150, step: 1 }
    );
    const sFov = _makeSlider('FOV_DEG',
      () => getCAM().FOV_DEG,
      v => { getCAM().FOV_DEG = v; save(); applyToCamera(); },
      { min: 20, max: 100, step: 1 }
    );
    const sBiasY = _makeSlider('FRAMING_Y',
      () => getCAM().FRAMING_BIAS_Y,
      v => { getCAM().FRAMING_BIAS_Y = v; save(); },
      { min: 0, max: 0.8, step: 0.01 }
    );
    const sAhead = _makeSlider('AHEAD_MIN',
      () => getCAM().LOOK_AHEAD_MIN,
      v => { getCAM().LOOK_AHEAD_MIN = v; save(); },
      { min: 0, max: 40, step: 0.5 }
    );
    gv.appendChild(sViewHeight.row);
    gv.appendChild(sFov.row);
    gv.appendChild(sBiasY.row);
    gv.appendChild(sAhead.row);

    // SIDE_READY
    const gr = makeGroup('SIDE_READY');
    const sRx = _makeSlider('x',
      () => (getCAM().SIDE_READY.x ?? startLineX),
      v => { getCAM().SIDE_READY.x = v; save(); },
      { min: -2000, max: 2000, step: 1 }
    );
    const sRz = _makeSlider('z',
      () => getCAM().SIDE_READY.z,
      v => { getCAM().SIDE_READY.z = v; save(); },
      { min: 0, max: 300, step: 1 }
    );
    const sRh = _makeSlider('h',
      () => getCAM().SIDE_READY.h,
      v => { getCAM().SIDE_READY.h = v; save(); },
      { min: 0, max: 200, step: 1 }
    );
    const sRlerp = _makeSlider('lerp',
      () => getCAM().SIDE_READY.lerp,
      v => { getCAM().SIDE_READY.lerp = v; save(); },
      { min: 0, max: 1, step: 0.01 }
    );
    gr.appendChild(sRx.row);
    gr.appendChild(sRz.row);
    gr.appendChild(sRh.row);
    gr.appendChild(sRlerp.row);

    // AWARD
    const ga = makeGroup('AWARD');
    const sZoom = _makeSlider('ZOOM',
      () => getCAM().AWARD.ZOOM,
      v => { getCAM().AWARD.ZOOM = v; save(); },
      { min: 0.5, max: 4, step: 0.01 }
    );
    const sPosX = _makeSlider('POS.x',
      () => getCAM().AWARD.POS.x,
      v => { getCAM().AWARD.POS.x = v; save(); },
      { min: -50, max: 50, step: 0.1 }
    );
    const sPosY = _makeSlider('POS.y',
      () => getCAM().AWARD.POS.y,
      v => { getCAM().AWARD.POS.y = v; save(); },
      { min: -50, max: 50, step: 0.1 }
    );
    const sPosZ = _makeSlider('POS.z',
      () => getCAM().AWARD.POS.z,
      v => { getCAM().AWARD.POS.z = v; save(); },
      { min: -50, max: 50, step: 0.1 }
    );
    const sLookX = _makeSlider('LOOK.x',
      () => getCAM().AWARD.LOOK.x,
      v => { getCAM().AWARD.LOOK.x = v; save(); },
      { min: -50, max: 50, step: 0.1 }
    );
    const sLookY = _makeSlider('LOOK.y',
      () => getCAM().AWARD.LOOK.y,
      v => { getCAM().AWARD.LOOK.y = v; save(); },
      { min: -50, max: 50, step: 0.1 }
    );
    const sLookZ = _makeSlider('LOOK.z',
      () => getCAM().AWARD.LOOK.z,
      v => { getCAM().AWARD.LOOK.z = v; save(); },
      { min: -50, max: 50, step: 0.1 }
    );
    ga.appendChild(sZoom.row);
    ga.appendChild(sPosX.row);
    ga.appendChild(sPosY.row);
    ga.appendChild(sPosZ.row);
    ga.appendChild(sLookX.row);
    ga.appendChild(sLookY.row);
    ga.appendChild(sLookZ.row);

    panel.appendChild(gv);
    panel.appendChild(gr);
    panel.appendChild(ga);
    wrap.appendChild(panel);
    document.body.appendChild(wrap);

    // 收合
    let collapsed = false;
    btn.addEventListener('click', () => {
      collapsed = !collapsed;
      panel.style.display = collapsed ? 'none' : '';
      btn.textContent = collapsed ? '展開' : '收合';
    });

    // Console 輔助
    window.CamPanel = {
      refresh() {
        sViewHeight.sync(); sFov.sync(); sBiasY.sync(); sAhead.sync();
        sRx.sync(); sRz.sync(); sRh.sync(); sRlerp.sync();
        sZoom.sync(); sPosX.sync(); sPosY.sync(); sPosZ.sync(); sLookX.sync(); sLookY.sync(); sLookZ.sync();
      },
      reset() { localStorage.removeItem(STORAGE_KEY); location.reload(); },
    };
  }
  function destroy() {
    if (!wrap) return;
    wrap.remove();
    wrap = null;
  }
  return { mount, destroy };
}

/* =========================
 * 方向向量面板（FIXED_DIR 或自訂）
 * ========================= */
function _createDirPanel(getDirVec) {
  let wrap = null;
  const STORAGE_KEY = 'camdir.v1';

  function mount() {
    if (wrap) return;

    // 讀存檔
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && _isNum(saved.x) && _isNum(saved.y) && _isNum(saved.z)) {
        const v = getDirVec?.();
        v?.set(saved.x, saved.y, saved.z).normalize();
      }
    } catch {}

    wrap = document.createElement('div');
    wrap.style.cssText = `
      position: fixed; right: 12px; bottom: 12px; transform: translateY(-360px);
      z-index: 99999; font: 12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,'Noto Sans TC',sans-serif;
      color: #eee; background:#111a; backdrop-filter: blur(6px); border: 1px solid #444;
      border-radius: 10px; padding: 10px; width: 240px; box-shadow: 0 6px 24px #0008;
    `;
    const title = document.createElement('div');
    title.textContent = 'Camera Dir (x,y,z)';
    title.style.cssText = 'font-weight:600; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;';
    const btn = document.createElement('button');
    btn.textContent = '收合';
    btn.style.cssText = 'cursor:pointer; font-size:12px; color:#ddd; background:#222; border:1px solid #444; padding:2px 8px; border-radius:6px;';
    title.appendChild(btn);

    const panel = document.createElement('div');

    const makeRow = (label, key, min=-1, max=1, step=0.01) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid; grid-template-columns: 28px 1fr 52px; gap:6px; align-items:center; margin:6px 0;';
      const lab = document.createElement('div'); lab.textContent = label; lab.style.opacity='0.9';
      const rng = document.createElement('input'); rng.type='range'; rng.min=min; rng.max=max; rng.step=step; rng.style.width='100%';
      const num = document.createElement('input'); num.type='number'; num.min=min; num.max=max; num.step=step;
      num.style.cssText = 'width:100%; background:#111; color:#eee; border:1px solid #444; border-radius:6px; padding:2px 6px;';
      row.appendChild(lab); row.appendChild(rng); row.appendChild(num);

      const syncFromVec = () => {
        const v = getDirVec?.(); if (!v) return;
        rng.value = String(v[key]);
        num.value = (v[key] ?? 0).toFixed(3);
      };
      const commit = (val) => {
        const v = getDirVec?.(); if (!v) return;
        const x = key==='x' ? Number(val) : v.x;
        const y = key==='y' ? Number(val) : v.y;
        const z = key==='z' ? Number(val) : v.z;
        v.set(x, y, z).normalize();
        rx.sync(); ry.sync(); rz.sync();
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: v.x, y: v.y, z: v.z })); } catch {}
      };

      rng.addEventListener('input', () => commit(rng.value));
      num.addEventListener('change', () => commit(num.value));
      const rx = { sync: syncFromVec };
      return { row, sync: syncFromVec };
    };

    const X = makeRow('x', 'x');
    const Y = makeRow('y', 'y');
    const Z = makeRow('z', 'z');

    panel.appendChild(X.row); panel.appendChild(Y.row); panel.appendChild(Z.row);

    const hint = document.createElement('div');
    hint.innerHTML = `<div style="opacity:.8; margin-top:6px;">向量會自動 <code>normalize()</code>；常見側視：x=0, y≈-0.5, z≈-1</div>`;

    wrap.appendChild(title);
    wrap.appendChild(panel);
    wrap.appendChild(hint);
    document.body.appendChild(wrap);

    // 初始同步
    X.sync(); Y.sync(); Z.sync();

    // 收合
    let collapsed = false;
    btn.addEventListener('click', () => {
      collapsed = !collapsed;
      panel.style.display = collapsed ? 'none' : '';
      hint.style.display  = collapsed ? 'none' : '';
      btn.textContent = collapsed ? '展開' : '收合';
    });

    // Console
    window.CamDirUI = {
      get() { const v = getDirVec?.(); return v ? { x: v.x, y: v.y, z: v.z } : null; },
      set(x, y, z) { const v = getDirVec?.(); v?.set(x, y, z).normalize(); X.sync(); Y.sync(); Z.sync();
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: v.x, y: v.y, z: v.z })); } catch {} },
      reset() { this.set(0, -0.5, -1); }
    };
  }
  function destroy() { if (!wrap) return; wrap.remove(); wrap = null; }
  return { mount, destroy };
}

/* =========================
 * 工廠：建立整合工具物件
 * ========================= */
export function createEditTool(opts) {
  const {
    getCAM,       // () => CAM 物件
    getCamera,    // () => THREE.PerspectiveCamera
    getDirVec,    // () => THREE.Vector3（例如你的 FIXED_DIR）
    startLineX = 0,
  } = opts || {};

  const distanceOverlay = _createDistanceOverlay(getCAM);
  const cameraPanel     = _createCameraPanel(getCAM, getCamera, startLineX);
  const dirPanel        = _createDirPanel(getDirVec);

  let mounted = { distance:false, camera:false, dir:false };

  function mount({ enable=true, panels } = {}) {
    if (!enable) return;
    const use = Object.assign({ distance:true, camera:true, dir:true }, panels || {});
    if (use.distance && !mounted.distance) { distanceOverlay.mount(); mounted.distance = true; }
    if (use.camera   && !mounted.camera)   { cameraPanel.mount();     mounted.camera   = true; }
    if (use.dir      && !mounted.dir)      { dirPanel.mount();        mounted.dir      = true; }
  }

  function update(distance, state) {
    if (mounted.distance) distanceOverlay.update(distance, state);
  }

  function destroy() {
    if (mounted.distance) distanceOverlay.destroy();
    if (mounted.camera)   cameraPanel.destroy();
    if (mounted.dir)      dirPanel.destroy();
    mounted = { distance:false, camera:false, dir:false };
  }

  return { mount, update, destroy };
}

/* =========================
 * 便捷：一行掛載
 * ========================= */
export function mountEditTool(enable, opts) {
  const tool = createEditTool(opts);
  tool.mount({ enable });
  return tool;
}
