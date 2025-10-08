class NativeBridge {
    constructor(options = {}) {
        this.debug = options.debug || false;
        this.targetOrigin = options.targetOrigin || '*'; // Web postMessage 的目標 origin
        
        // 回調管理
        this.callbacks = new Map();
        this.messageId = 0;
        this.callbackTimeout = options.callbackTimeout || 30000; // 30秒超時
        
        // 事件監聽器
        this.listeners = new Map();
        
        // 平台檢測
        this.platform = this.detectPlatform();
        
        // 初始化接收器
        this.setupReceiver();
        
        this.log('✅ NativeBridge initialized', { platform: this.platform });
    }
    
    // ==================== 平台檢測 ====================
    detectPlatform() {
        if (window.webkit?.messageHandlers?.nativeApp) {
            return 'ios';
        }
        if (window.AndroidBridge) {
            return 'android';
        }
        if (window.parent !== window) {
            return 'web-iframe';
        }
        return 'web';
    }
    
    // ==================== 發送訊息 (Web → Native/Parent) ====================
    send(action, data = {}, callback = null) {
        const id = ++this.messageId;
        const message = {
            id,
            action,
            data,
            timestamp: Date.now(),
            platform: this.platform
        };
        
        // 如果有回調，註冊回調並設定超時
        if (callback) {
            this.registerCallback(id, callback);
        }
        
        try {
            switch (this.platform) {
                case 'ios':
                    window.webkit.messageHandlers.nativeApp.postMessage(message);
                    this.log('📤 Sent to iOS:', message);
                    break;
                    
                case 'android':
                    window.AndroidBridge.postMessage(JSON.stringify(message));
                    this.log('📤 Sent to Android:', message);
                    break;
                    
                case 'web-iframe':
                    window.parent.postMessage(message, this.targetOrigin);
                    this.log('📤 Sent to parent window:', message);
                    break;
                    
                case 'web':
                default:
                    // 觸發自定義事件作為降級方案
                    window.dispatchEvent(new CustomEvent('nativeBridgeSend', {
                        detail: message
                    }));
                    this.log('📤 Sent (web fallback):', message);
                    
                    // 模擬回應（用於測試）
                    if (callback) {
                        setTimeout(() => {
                            callback({ success: true, message: 'Web fallback response' });
                        }, 100);
                    }
                    break;
            }
            
            return id;
            
        } catch (error) {
            this.log('❌ Send error:', error);
            if (callback) {
                callback(null, error.message);
            }
            return null;
        }
    }
    
    // 帶 Promise 的發送
    sendAsync(action, data = {}) {
        return new Promise((resolve, reject) => {
            this.send(action, data, (response, error) => {
                if (error) {
                    reject(new Error(error));
                } else {
                    resolve(response);
                }
            });
        });
    }
    
    // ==================== 接收訊息 (Native/Parent → Web) ====================
    setupReceiver() {
        // iOS 回調函數
        window.receiveNativeMessage = (message) => {
            this.log('📥 Received from iOS:', message);
            this.handleMessage(message, 'ios');
        };
        
        // Android 回調函數
        window.onNativeMessage = (messageStr) => {
            try {
                const message = JSON.parse(messageStr);
                this.log('📥 Received from Android:', message);
                this.handleMessage(message, 'android');
            } catch (error) {
                this.log('❌ Parse Android message error:', error);
            }
        };
        
        // Web postMessage 監聽
        window.addEventListener('message', (event) => {
            // 安全檢查（生產環境應該驗證 origin）
            // if (event.origin !== 'https://your-domain.com') return;
            
            // 確保訊息包含 action 且不是來自自身
            if (event.data && typeof event.data === 'object' && event.data.action && event.source !== window) {
                this.log('📥 Received from parent window:', event.data);
                this.handleMessage(event.data, 'web-postmessage');
            }
        });
        
        // Web 自定義事件監聽（用於同頁面測試）
        window.addEventListener('nativeBridgeSend', (event) => {
            this.log('📥 Received from custom event:', event.detail);
            this.handleMessage(event.detail, 'web-event');
        });
    }
    
    // 處理接收到的訊息
    handleMessage(message, source) {
        const { id, action, data, error } = message;
        
        // 如果是回調訊息（有 id 且存在對應的回調）
        if (id && this.callbacks.has(id)) {
            const callback = this.callbacks.get(id);
            clearTimeout(callback.timeoutId);
            // 回調函數格式: (response, error)
            callback.fn(data, error); 
            this.callbacks.delete(id);
            return;
        }
        
        // 觸發對應 action 的監聽器
        if (action && this.listeners.has(action)) {
            this.listeners.get(action).forEach(listener => {
                try {
                    // 監聽器函數格式: (data, originalMessage)
                    listener(data, message); 
                } catch (error) {
                    this.log('❌ Listener error:', error);
                }
            });
        }
        
        // 觸發通用監聽器
        if (this.listeners.has('*')) {
            this.listeners.get('*').forEach(listener => {
                try {
                    listener(message, source);
                } catch (error) {
                    this.log('❌ Universal listener error:', error);
                }
            });
        }
    }
    
    // ==================== 回調管理 ====================
    registerCallback(id, callback) {
        const timeoutId = setTimeout(() => {
            if (this.callbacks.has(id)) {
                this.log(`⏰ Callback timeout for message ${id}`);
                callback(null, 'Timeout');
                this.callbacks.delete(id);
            }
        }, this.callbackTimeout);
        
        this.callbacks.set(id, {
            fn: callback,
            timeoutId
        });
    }
    
    // ==================== 事件監聽 ====================
    on(action, callback) {
        if (!this.listeners.has(action)) {
            this.listeners.set(action, []);
        }
        this.listeners.get(action).push(callback);
        
        // 返回取消監聽的函數
        return () => this.off(action, callback);
    }
    
    off(action, callback) {
        if (!this.listeners.has(action)) return;
        
        const listeners = this.listeners.get(action);
        const index = listeners.indexOf(callback);
        if (index > -1) {
            listeners.splice(index, 1);
        }
    }
    
    // 監聽所有訊息
    onAll(callback) {
        return this.on('*', callback);
    }
    
    // ==================== 回覆訊息 (用於回應原生端) ====================
    reply(originalMessage, data, error = null) {
        const replyMessage = {
            id: originalMessage.id,
            action: originalMessage.action,
            data,
            error,
            isReply: true,
            timestamp: Date.now()
        };
        
        // 根據平台發送回覆
        // 注意：這裡假設 Host (index2.html) 處於 Native 環境，因此只回覆給 Native 接口。
        switch (this.platform) {
            case 'ios':
                if (window.webkit?.messageHandlers?.nativeApp) {
                    window.webkit.messageHandlers.nativeApp.postMessage(replyMessage);
                }
                break;
            case 'android':
                if (window.AndroidBridge) {
                    window.AndroidBridge.postMessage(JSON.stringify(replyMessage));
                }
                break;
            case 'web-iframe':
                // 如果 Host 自身是 iFrame，則回覆給 parent
                window.parent.postMessage(replyMessage, this.targetOrigin);
                break;
        }
        
        this.log('↩️ Reply sent:', replyMessage);
    }
    
    // ==================== 工具方法 ====================
    log(...args) {
        if (this.debug) {
            console.log('[NativeBridge]', ...args);
        }
    }
    
    getPlatform() {
        return this.platform;
    }
    
    isNative() {
        return this.platform === 'ios' || this.platform === 'android';
    }
    
    // 清理所有監聽器和回調
    destroy() {
        this.listeners.clear();
        this.callbacks.forEach(cb => clearTimeout(cb.timeoutId));
        this.callbacks.clear();
        this.log('🗑️ Bridge destroyed');
    }
}

// 匯出供全域使用
window.NativeBridge = NativeBridge;