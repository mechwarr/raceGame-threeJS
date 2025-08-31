// iframe-game-utils.js
// 輕量工具與預設值（非模組；掛到 window）
// - 專注 DOM 與共用小工具，避免核心類別過肥

;(function (global) {
  const IframeGameUtils = {
    /** 將 allow / sandbox / 其他屬性套到 iframe */
    applyIframeAttributes(iframe, { sandbox, attributes } = {}) {
      if (sandbox) iframe.setAttribute('sandbox', sandbox);
      if (attributes && typeof attributes === 'object') {
        for (const [k, v] of Object.entries(attributes)) {
          iframe.setAttribute(k, v);
        }
      }
    },

    /** 依「固定寬度 16:9」或「RWD」設定 iframe CSS 尺寸 */
    applyIframeSize(iframe, fixedWidth /* number|null */) {
      if (typeof fixedWidth === 'number' && fixedWidth > 0) {
        const fixedHeight = Math.round((fixedWidth * 9) / 16);
        Object.assign(iframe.style, {
          width: `${fixedWidth}px`,
          height: `${fixedHeight}px`,
          maxWidth: `${fixedWidth}px`,
          maxHeight: `${fixedHeight}px`,
          minWidth: `${fixedWidth}px`,
          minHeight: `${fixedHeight}px`,
          flex: '0 0 auto',
          display: 'block',
        });
      } else {
        Object.assign(iframe.style, {
          width: '100%',
          height: '100%',
          display: 'block',
        });
      }
      iframe.style.border = '0';
    },

    /** 顯示/隱藏載入遮罩 */
    showLoading(loadingRefs, show) {
      const el = loadingRefs?.overlay;
      if (el) el.classList.toggle('active', !!show);
    },

    /** 更新進度條/數字（若有提供） */
    setProgress(loadingRefs, p) {
      const bar = loadingRefs?.bar;
      const text = loadingRefs?.text;
      if (bar) bar.style.width = `${p}%`;
      if (text) text.textContent = `${Math.floor(p)}%`;
      const prg = elClosestProgress(loadingRefs?.overlay);
      if (prg) prg.setAttribute('aria-valuenow', String(Math.floor(p)));
      function elClosestProgress(overlay) {
        if (!overlay) return null;
        return overlay.querySelector?.('.progress') || null;
      }
    },

    /** 清空容器內所有 iframe */
    clearContainer(container) {
      [...container.querySelectorAll('iframe')].forEach((n) => n.remove());
    },

    /** 封裝 postMessage，容錯 */
    postToGame(win, payload, targetOrigin) {
      try {
        win?.postMessage(payload, targetOrigin);
      } catch (err) {
        console.warn('postMessage 失敗：', err);
      }
    },

    /** 預設 host→子頁的設定（固定 1920×1080 渲染，並可指示鎖定 resize） */
    defaultHostConfig(lockResize) {
      return {
        type: 'host:config',
        aspect: '16:9',
        renderWidth: 1920,
        renderHeight: 1080,
        lockResize: !!lockResize,
      };
    },
  };

  global.IframeGameUtils = IframeGameUtils;
})(window);
