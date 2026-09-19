// ==UserScript==
// @name         BiliForge
// @namespace    https://space.bilibili.com/1937432404
// @version      3.3.1
// @updateURL    https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/biliforge.user.js
// @downloadURL  https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/biliforge.user.js
// @description  Bilibili 体验优化，去广告，URL 清理，P2P CDN 控制，直播优化，文章复制修复
// @author       素晴
// @match        https://*.bilibili.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_addStyle
// @grant        GM_notification
// ==/UserScript==

(function (W, D) {
    'use strict';

    const CONFIG = Object.freeze({
        name: 'BiliForge',
        debug: false,

        features: Object.freeze({
            hideAds: true,
            cleanUrl: true,
            cleanFont: true,
            removeGrayFilter: true,

            dynamicWide: true,
            articleCopyFix: true,
            videoFit: true,

            blockTrackers: true,
            fakeReporter: true,

            p2pBlocker: true,
            cdnReplace: true,
            liveOptimizer: true,

            disableWebRTC: false,
            fakeSentry: false,
            blockFingerprint: false
        }),

        urlParams: Object.freeze({
            global: Object.freeze([
                'vd_source',
                /^spm/,
                /^share/
            ]),
            home: Object.freeze([
                'buvid',
                'session_id',
                'launch_id'
            ]),
            video: Object.freeze([
                'is_story_h5',
                'mid',
                'timestamp',
                'up_id'
            ]),
            live: Object.freeze([
                'live_from'
            ]),
            dynamic: Object.freeze([
                'is_story_h5'
            ])
        }),

        selectors: Object.freeze({
            dynamicTabList: '.bili-dyn-list-tabs__list',
            dynamicWideSwitch: '#wide-mode-switch',

            articleHolder: '.article-holder',

            playerSettingLeft: '.bpx-player-ctrl-setting-menu-left',
            playerSettingMore: '.bpx-player-ctrl-setting-more',
            playerSettingPanel: '.bpx-player-ctrl-setting-box .bui-panel-item',

            videoFitButton: '.mbga-fit-mode',

            fontLink: 'link[href*="/jinkela/long/font/"]'
        }),

        cdn: Object.freeze({
            fallbackDomain: 'upos-sz-mirrorcoso1.bilivideo.com',
            mediaUrlPattern: /\.(m4s|mp4|flv|m3u8)(?:\?|$)/i
        }),

        live: Object.freeze({
            mcdnPattern: /[xy0-9]+\.mcdn\.bilivideo\.cn:\d+/i,
            smtcdnsPattern: /[\w.]+\.smtcdns\.net\/([\w-]+\.bilivideo\.com\/)/i,
            qualityPattern: /(live-bvc\/\d+\/live_\d+_\d+)_\w+/,
            hevcPattern: /(\d+)_(mini|pro)hevc/g,
            mediaPattern: /\.(m3u8|m4s)(?:\?|$)/i,
            errorLimit: 5,
            errorDecayMs: 10000,
            recoveryMs: 30000
        }),

        trackers: Object.freeze({
            urlPattern: /(?:^|\/\/)(?:cm|data)\.bilibili\.com/i
        })
    });

    const Logger = {
        log(...args) {
            if (CONFIG.debug || W.__MBGA_DEBUG__ || W.__MBGA_PROMAX_DEBUG__) {
                console.log(`[${CONFIG.name}]`, ...args);
            }
        },

        warn(...args) {
            console.warn(`[${CONFIG.name}]`, ...args);
        },

        error(...args) {
            console.error(`[${CONFIG.name}]`, ...args);
        }
    };

    const StorageManager = {
        get(key, fallback = null) {
            try {
                return W.localStorage?.getItem(key) ?? fallback;
            } catch (e) {
                Logger.warn(`localStorage read failed: ${key}`, e);
                return fallback;
            }
        },

        set(key, value) {
            try {
                W.localStorage?.setItem(key, String(value));
                return true;
            } catch (e) {
                Logger.warn(`localStorage write failed: ${key}`, e);
                return false;
            }
        },

        remove(key) {
            try {
                W.localStorage?.removeItem(key);
                return true;
            } catch (e) {
                Logger.warn(`localStorage remove failed: ${key}`, e);
                return false;
            }
        },

        has(key) {
            return this.get(key) !== null;
        },

        isTrue(key) {
            return this.get(key) === 'true';
        }
    };

    const Router = {
        get host() {
            return location.host;
        },

        get href() {
            return location.href;
        },

        get path() {
            return location.pathname;
        },

        isHome() {
            return this.host === 'www.bilibili.com' && (this.path === '/' || this.path === '');
        },

        isDynamic() {
            return this.host === 't.bilibili.com';
        },

        isVideo() {
            return this.host === 'www.bilibili.com' && this.path.startsWith('/video/');
        },

        isBangumi() {
            return this.host === 'www.bilibili.com' && this.path.startsWith('/bangumi/play/');
        },

        isMediaPage() {
            return this.isVideo() || this.isBangumi();
        },

        isLive() {
            return this.host === 'live.bilibili.com';
        },

        isArticle() {
            return this.host === 'www.bilibili.com' && this.path.startsWith('/read/cv');
        }
    };

    const HookManager = {
        records: new Map(),

        _key(owner, target, prop) {
            const targetName = target === W ? 'window'
                : target === D ? 'document'
                    : target?.constructor?.name || 'object';
            return `${owner}:${targetName}:${String(prop)}`;
        },

        define(owner, target, prop, descriptor) {
            if (!target || !prop) return false;

            const key = this._key(owner, target, prop);
            if (this.records.has(key)) return true;

            const originalDescriptor = Object.getOwnPropertyDescriptor(target, prop);

            if (originalDescriptor && originalDescriptor.configurable === false) {
                Logger.warn(`skip non-configurable property: ${String(prop)}`);
                return false;
            }

            try {
                Object.defineProperty(target, prop, {
                    configurable: true,
                    enumerable: originalDescriptor?.enumerable ?? false,
                    ...descriptor
                });

                this.records.set(key, {
                    owner,
                    target,
                    prop,
                    originalDescriptor
                });

                return true;
            } catch (e) {
                Logger.error(`define failed: ${String(prop)}`, e);
                return false;
            }
        },

        method(owner, target, prop, factory) {
            if (!target || typeof target[prop] !== 'function') return false;

            const original = target[prop];

            return this.define(owner, target, prop, {
                writable: true,
                value: factory(original)
            });
        },

        restore(owner) {
            for (const [key, record] of Array.from(this.records.entries())) {
                if (owner && record.owner !== owner) continue;

                try {
                    if (record.originalDescriptor) {
                        Object.defineProperty(record.target, record.prop, record.originalDescriptor);
                    } else {
                        delete record.target[record.prop];
                    }

                    this.records.delete(key);
                } catch (e) {
                    Logger.error(`restore failed: ${String(record.prop)}`, e);
                }
            }
        },

        restoreAll() {
            this.restore();
        }
    };

    const SafeDOM = {
        ready(callback) {
            if (D.readyState === 'loading') {
                D.addEventListener('DOMContentLoaded', callback, { once: true });
            } else {
                callback();
            }
        },

        loaded(callback) {
            if (D.readyState === 'complete') {
                callback();
            } else {
                W.addEventListener('load', callback, { once: true });
            }
        },

        query(selector, root = D) {
            try {
                return root.querySelector(selector);
            } catch (e) {
                Logger.error(`query failed: ${selector}`, e);
                return null;
            }
        },

        queryAll(selector, root = D) {
            try {
                return Array.from(root.querySelectorAll(selector));
            } catch (e) {
                Logger.error(`queryAll failed: ${selector}`, e);
                return [];
            }
        },

        waitFor(selector, options = {}) {
            const {
                root = D,
                timeout = 15000,
                checkInterval = 250
            } = options;

            return new Promise((resolve, reject) => {
                const first = this.query(selector, root);
                if (first) {
                    resolve(first);
                    return;
                }

                let done = false;
                let observer = null;
                let interval = null;
                let timer = null;

                const finish = (node) => {
                    if (done) return;
                    done = true;
                    if (observer) observer.disconnect();
                    if (interval) clearInterval(interval);
                    if (timer) clearTimeout(timer);
                    resolve(node);
                };

                const fail = () => {
                    if (done) return;
                    done = true;
                    if (observer) observer.disconnect();
                    if (interval) clearInterval(interval);
                    reject(new Error(`waitFor timeout: ${selector}`));
                };

                const check = () => {
                    const node = this.query(selector, root);
                    if (node) finish(node);
                };

                const observeRoot = root === D ? D.documentElement : root;

                if (observeRoot) {
                    observer = new MutationObserver(check);
                    observer.observe(observeRoot, {
                        childList: true,
                        subtree: true
                    });
                }

                interval = setInterval(check, checkInterval);
                timer = setTimeout(fail, timeout);
            });
        },

        observeFor(selector, callback, options = {}) {
            const {
                root = D,
                once = false,
                subtree = true,
                immediate = true
            } = options;

            const seen = new WeakSet();

            const run = () => {
                const nodes = this.queryAll(selector, root);
                for (const node of nodes) {
                    if (seen.has(node)) continue;

                    seen.add(node);

                    try {
                        callback(node);
                    } catch (e) {
                        Logger.error(`observe callback failed: ${selector}`, e);
                    }

                    if (once) {
                        observer.disconnect();
                        return;
                    }
                }
            };

            const observeRoot = root === D ? D.documentElement : root;
            if (!observeRoot) return null;

            const observer = new MutationObserver(run);

            observer.observe(observeRoot, {
                childList: true,
                subtree
            });

            if (immediate) run();

            return observer;
        },

        create(tag, props = {}) {
            const el = D.createElement(tag);

            for (const [key, value] of Object.entries(props)) {
                if (key === 'text') {
                    el.textContent = value;
                } else if (key === 'style' && value && typeof value === 'object') {
                    Object.assign(el.style, value);
                } else if (key === 'className') {
                    el.className = value;
                } else if (key.startsWith('on') && typeof value === 'function') {
                    el.addEventListener(key.slice(2).toLowerCase(), value);
                } else {
                    el.setAttribute(key, value);
                }
            }

            return el;
        }
    };

    const StyleManager = {
        injected: new Set(),

        add(id, css) {
            if (this.injected.has(id)) return;
            this.injected.add(id);

            try {
                if (typeof GM_addStyle === 'function') {
                    GM_addStyle(css);
                    return;
                }
            } catch (e) {
                Logger.error(`GM_addStyle failed: ${id}`, e);
            }

            const style = D.createElement('style');
            style.setAttribute('data-mbga-style', id);
            style.textContent = css;

            const parent = D.head || D.documentElement;
            if (parent) parent.appendChild(style);
        },

        initBase() {
            const css = `
                html, body {
                    -webkit-filter: none !important;
                    filter: none !important;
                }

                html, body {
                    font-family: initial !important;
                }

                .adblock-tips,
                .ad-report,
                a[href*="cm.bilibili.com"],
                .feed-card:has(.bili-video-card > div:empty) {
                    display: none !important;
                }

                .feed2 .feed-card:has(a[href*="cm.bilibili.com"]),
                .feed2 .feed-card:has(.bili-video-card:empty) {
                    display: none !important;
                }

                .feed2 .container > * {
                    margin-top: 0 !important;
                }

                #welcome-area-bottom-vm,
                .web-player-icon-roomStatus {
                    display: none !important;
                }
            `;

            this.add('base', css);
        },

        initDynamicWide() {
            const css = `
                html[wide] #app {
                    display: flex;
                }

                html[wide] .bili-dyn-home--member {
                    box-sizing: border-box;
                    padding: 0 10px;
                    width: 100%;
                    flex: 1;
                }

                html[wide] .bili-dyn-content {
                    width: initial;
                }

                html[wide] main {
                    margin: 0 8px;
                    flex: 1;
                    overflow: hidden;
                    width: initial;
                }

                #wide-mode-switch {
                    margin-left: 0;
                    margin-right: 20px;
                    user-select: none;
                    cursor: pointer;
                }

                .bili-dyn-list__item:has(.bili-dyn-card-goods),
                .bili-dyn-list__item:has(.bili-rich-text-module.goods) {
                    display: none !important;
                }
            `;

            this.add('dynamic-wide', css);
        },

        initVideoFit() {
            const css = `
                body[video-fit] #bilibili-player video {
                    object-fit: cover;
                }

                .bpx-player-ctrl-setting-fit-mode {
                    display: flex;
                    width: 100%;
                    height: 32px;
                    line-height: 32px;
                }

                .bpx-player-ctrl-setting-box .bui-panel-wrap,
                .bpx-player-ctrl-setting-box .bui-panel-item {
                    min-height: 172px !important;
                }
            `;

            this.add('video-fit', css);
        },

        initLive() {
            const css = `
                div[data-cy="EvaRenderer_LayerWrapper"]:has(.player) {
                    z-index: 999999;
                }

                .fixedPageBackground_root {
                    z-index: 999999 !important;
                }
            `;

            this.add('live', css);
        }
    };

    const URLCleaner = {
        init() {
            if (!CONFIG.features.cleanUrl) return;

            this.cleanCurrentUrl();
            this.patchHistory();

            W.addEventListener('popstate', () => {
                setTimeout(() => {
                    this.cleanCurrentUrl();
                    App.onRouteChange();
                }, 0);
            });
        },

        getRulesForCurrentPage() {
            const rules = [...CONFIG.urlParams.global];

            if (Router.isHome()) rules.push(...CONFIG.urlParams.home);
            if (Router.isMediaPage()) rules.push(...CONFIG.urlParams.video);
            if (Router.isLive()) rules.push(...CONFIG.urlParams.live);
            if (Router.isDynamic()) rules.push(...CONFIG.urlParams.dynamic);

            return rules;
        },

        shouldDeleteParam(key) {
            for (const rule of this.getRulesForCurrentPage()) {
                if (typeof rule === 'string' && key === rule) return true;
                if (rule instanceof RegExp && rule.test(key)) return true;
            }

            return false;
        },

        removeTracking(url) {
            if (!url) return url;

            try {
                const urlObj = new URL(url, location.href);
                if (!urlObj.search) return url;

                const keys = Array.from(urlObj.searchParams.keys());
                let changed = false;

                for (const key of keys) {
                    if (this.shouldDeleteParam(key)) {
                        urlObj.searchParams.delete(key);
                        changed = true;
                    }
                }

                if (!changed) return url;

                return urlObj.toString();
            } catch (e) {
                Logger.error('URL clean failed:', e);
                return url;
            }
        },

        cleanCurrentUrl() {
            const cleaned = this.removeTracking(location.href);
            if (cleaned && cleaned !== location.href) {
                history.replaceState(history.state, '', cleaned);
            }
        },

        patchHistory() {
            HookManager.method('URLCleaner', W.history, 'pushState', (original) => {
                return function (state, unused, url) {
                    const cleaned = url ? URLCleaner.removeTracking(url) : url;
                    const result = original.call(this, state, unused, cleaned);
                    App.onRouteChange();
                    return result;
                };
            });

            HookManager.method('URLCleaner', W.history, 'replaceState', (original) => {
                return function (state, unused, url) {
                    const cleaned = url ? URLCleaner.removeTracking(url) : url;
                    const result = original.call(this, state, unused, cleaned);
                    App.onRouteChange();
                    return result;
                };
            });
        }
    };

    const NetworkManager = {
        initialized: false,
        rules: new Map(),
        fetchObservers: new Map(),

        init() {
            if (this.initialized) return;
            this.initialized = true;

            this.patchFetch();
            this.patchXHR();
            this.patchBeacon();
        },

        addRule(name, fn) {
            this.rules.set(name, fn);
        },

        addFetchObserver(name, fn) {
            this.fetchObservers.set(name, fn);
        },

        getInputUrl(input) {
            if (typeof input === 'string') return input;
            if (input instanceof URL) return input.href;
            if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
            return '';
        },

        rebuildFetchInput(originalInput, newUrl, init) {
            if (!newUrl) return originalInput;

            if (typeof originalInput === 'string') return newUrl;
            if (originalInput instanceof URL) return newUrl;

            if (typeof Request !== 'undefined' && originalInput instanceof Request) {
                try {
                    const cloned = new Request(newUrl, originalInput);
                    return init ? new Request(cloned, init) : cloned;
                } catch (e) {
                    Logger.warn('failed to rebuild Request, fallback to string URL', e);
                    return newUrl;
                }
            }

            return originalInput;
        },

        applyRules(url, context) {
            let current = url;

            for (const [name, fn] of this.rules.entries()) {
                try {
                    const result = fn(current, context);

                    if (!result) continue;

                    if (typeof result === 'string') {
                        current = result;
                        continue;
                    }

                    if (result.block) {
                        return {
                            blocked: true,
                            mode: result.mode || 'empty',
                            reason: result.reason || name,
                            url: current
                        };
                    }

                    if (typeof result.url === 'string') {
                        current = result.url;
                    }
                } catch (e) {
                    Logger.error(`network rule failed: ${name}`, e);
                }
            }

            return {
                blocked: false,
                url: current
            };
        },

        makeBlockedFetchResult(mode, reason) {
            if (mode === 'reject') {
                return Promise.reject(new DOMException(reason || 'Blocked by MBGA', 'AbortError'));
            }

            return Promise.resolve(new Response(null, {
                status: 204,
                statusText: 'No Content'
            }));
        },

        notifyFetchObservers(url, response, error) {
            for (const [name, fn] of this.fetchObservers.entries()) {
                try {
                    fn(url, response, error);
                } catch (e) {
                    Logger.error(`fetch observer failed: ${name}`, e);
                }
            }
        },

        patchFetch() {
            if (typeof W.fetch !== 'function') return;

            HookManager.method('NetworkManager', W, 'fetch', (original) => {
                return function (input, init) {
                    const originalUrl = NetworkManager.getInputUrl(input);

                    if (!originalUrl) {
                        return original.call(this, input, init);
                    }

                    const action = NetworkManager.applyRules(originalUrl, {
                        type: 'fetch',
                        input,
                        init
                    });

                    if (action.blocked) {
                        return NetworkManager.makeBlockedFetchResult(action.mode, action.reason);
                    }

                    const finalInput = action.url === originalUrl
                        ? input
                        : NetworkManager.rebuildFetchInput(input, action.url, init);

                    const promise = original.call(this, finalInput, init);

                    return promise.then(
                        (response) => {
                            NetworkManager.notifyFetchObservers(action.url, response, null);
                            return response;
                        },
                        (error) => {
                            NetworkManager.notifyFetchObservers(action.url, null, error);
                            throw error;
                        }
                    );
                };
            });
        },

        patchXHR() {
            if (!W.XMLHttpRequest?.prototype) return;

            const proto = W.XMLHttpRequest.prototype;

            HookManager.method('NetworkManager', proto, 'open', (originalOpen) => {
                return function (method, url, ...rest) {
                    // An XMLHttpRequest can be reopened after an intercepted request.
                    delete this.__MBGA_BLOCKED__;
                    const originalUrl = typeof url === 'string' ? url : String(url || '');
                    const action = NetworkManager.applyRules(originalUrl, {
                        type: 'xhr',
                        xhr: this,
                        method
                    });

                    if (action.blocked) {
                        this.__MBGA_BLOCKED__ = {
                            mode: action.mode,
                            reason: action.reason,
                            url: originalUrl
                        };

                        return originalOpen.call(this, method, originalUrl, ...rest);
                    }

                    return originalOpen.call(this, method, action.url || originalUrl, ...rest);
                };
            });

            HookManager.method('NetworkManager', proto, 'send', (originalSend) => {
                return function (...args) {
                    if (this.__MBGA_BLOCKED__) {
                        try {
                            this.abort();
                        } catch (e) {
                            Logger.warn('blocked XHR abort failed', e);
                        }

                        return;
                    }

                    return originalSend.apply(this, args);
                };
            });
        },

        patchBeacon() {
            if (!W.navigator || typeof W.navigator.sendBeacon !== 'function') return;

            HookManager.method('NetworkManager', W.navigator, 'sendBeacon', (original) => {
                return function (url, data) {
                    const originalUrl = typeof url === 'string' ? url : String(url || '');
                    const action = NetworkManager.applyRules(originalUrl, {
                        type: 'beacon',
                        data
                    });

                    if (action.blocked) {
                        return true;
                    }

                    return original.call(this, action.url || originalUrl, data);
                };
            });
        }
    };

    const TrackerBlocker = {
        init() {
            if (!CONFIG.features.blockTrackers) return;

            NetworkManager.addRule('tracker-block', (url, context) => {
                if (!url || !CONFIG.trackers.urlPattern.test(url)) return null;

                return {
                    block: true,
                    mode: context.type === 'fetch' ? 'empty' : 'abort',
                    reason: 'tracker-block'
                };
            });
        }
    };

    const PrivacyGuard = {
        init() {
            if (CONFIG.features.disableWebRTC) this.disableWebRTC();
            if (CONFIG.features.fakeReporter) this.fakeReporter();
            if (CONFIG.features.fakeSentry) this.fakeSentry();
            if (CONFIG.features.blockFingerprint) this.blockFingerprint();
        },

        disableWebRTC() {
            const NoopRTC = class {
                addEventListener() { }
                removeEventListener() { }
                createDataChannel() { return {}; }
                createOffer() { return Promise.reject(new Error('WebRTC disabled by MBGA')); }
                createAnswer() { return Promise.reject(new Error('WebRTC disabled by MBGA')); }
                setLocalDescription() { return Promise.reject(new Error('WebRTC disabled by MBGA')); }
                setRemoteDescription() { return Promise.reject(new Error('WebRTC disabled by MBGA')); }
                close() { }
            };

            const NoopChannel = class {
                addEventListener() { }
                removeEventListener() { }
                close() { }
                send() { }
            };

            HookManager.define('PrivacyGuard', W, 'RTCPeerConnection', {
                writable: true,
                value: NoopRTC
            });

            HookManager.define('PrivacyGuard', W, 'webkitRTCPeerConnection', {
                writable: true,
                value: NoopRTC
            });

            HookManager.define('PrivacyGuard', W, 'RTCDataChannel', {
                writable: true,
                value: NoopChannel
            });

            HookManager.define('PrivacyGuard', W, 'webkitRTCDataChannel', {
                writable: true,
                value: NoopChannel
            });
        },

        createNoopProxy(name) {
            const fn = function () { };

            return new Proxy(fn, {
                get(_target, prop) {
                    Logger.log(`${name}.${String(prop)} called`);
                    return function () { };
                },

                set() {
                    return true;
                },

                construct() {
                    return PrivacyGuard.createNoopProxy(`${name}Instance`);
                },

                apply() {
                    return undefined;
                }
            });
        },

        fakeReporter() {
            HookManager.define('PrivacyGuard', W, 'MReporterInstance', {
                writable: true,
                value: this.createNoopProxy('MReporterInstance')
            });

            HookManager.define('PrivacyGuard', W, 'MReporter', {
                writable: true,
                value: this.createNoopProxy('MReporter')
            });

            HookManager.define('PrivacyGuard', W, 'ReporterPbInstance', {
                writable: true,
                value: this.createNoopProxy('ReporterPbInstance')
            });

            HookManager.define('PrivacyGuard', W, 'ReporterPb', {
                writable: true,
                value: this.createNoopProxy('ReporterPb')
            });
        },

        fakeSentry() {
            const Hub = class {
                bindClient() { }
            };

            const fake = {
                SDK_NAME: 'sentry.javascript.browser',
                SDK_VERSION: '0.0.0',
                BrowserClient: class { },
                Hub,
                Integrations: {
                    Vue: class { },
                    GlobalHandlers: class { },
                    InboundFilters: class { }
                },
                init() { },
                configureScope() { },
                getCurrentHub: () => new Hub(),
                setContext() { },
                setExtra() { },
                setExtras() { },
                setTag() { },
                setTags() { },
                setUser() { },
                wrap(fn) {
                    return typeof fn === 'function' ? fn : function () { };
                }
            };

            HookManager.define('PrivacyGuard', W, 'Sentry', {
                writable: true,
                value: fake
            });
        },

        blockFingerprint() {
            const noop = {
                init() { },
                queryUserLog() {
                    return [];
                }
            };

            HookManager.define('PrivacyGuard', W, '__biliUserFp__', {
                get() {
                    return noop;
                },
                set() { }
            });

            HookManager.define('PrivacyGuard', W, '__USER_FP_CONFIG__', {
                get() {
                    return undefined;
                },
                set() { }
            });

            HookManager.define('PrivacyGuard', W, '__MIRROR_CONFIG__', {
                get() {
                    return undefined;
                },
                set() { }
            });
        }
    };

    const P2PBlocker = {
        owner: 'P2PBlocker',

        init() {
            if (!CONFIG.features.p2pBlocker) return;

            this.guardGlobal('PCDNLoader', class { });
            this.guardGlobal('BPP2PSDK', class {
                on() { }
                off() { }
                destroy() { }
            });
            this.guardGlobal('SeederSDK', class { });
        },

        guardGlobal(prop, value) {
            HookManager.define(this.owner, W, prop, {
                get() {
                    return value;
                },
                set() {
                    Logger.log(`${prop} assignment ignored`);
                }
            });
        }
    };

    const CDNReplacer = {
        mediaSrcHooked: false,
        playinfoHooked: false,
        detectedDomain: null,

        init() {
            if (!CONFIG.features.cdnReplace) return;

            this.hookPlayinfo();
            this.hookMediaSrc();

            NetworkManager.addRule('cdn-replace', (url) => {
                if (!Router.isMediaPage()) return null;

                const replaced = CDNReplacer.replaceUrl(url);
                return replaced !== url ? replaced : null;
            });
        },

        isValidFallback(host) {
            return typeof host === 'string'
                && /^[a-zA-Z0-9.-]+$/.test(host)
                && host.endsWith('.bilivideo.com');
        },

        detectDomainFromString(text) {
            if (typeof text !== 'string') return null;

            const match = text.match(/up[\w-]+\.bilivideo\.com/);
            return match?.[0] || null;
        },

        detectDomainFromDocument() {
            const mediaNodes = SafeDOM.queryAll('script[src], link[href], source[src], video[src]', D);

            for (const node of mediaNodes) {
                const value = node.getAttribute('src') || node.getAttribute('href') || '';
                const domain = this.detectDomainFromString(value);
                if (domain) return domain;
            }

            return this.detectDomainFromString(D.head?.textContent || '');
        },

        getDomainFromPage() {
            if (this.detectedDomain) return this.detectedDomain;

            const fromHead = this.detectDomainFromDocument();
            if (fromHead) {
                this.detectedDomain = fromHead;
                return fromHead;
            }

            return CONFIG.cdn.fallbackDomain;
        },

        replaceUrl(url) {
            if (typeof url !== 'string') return url;

            try {
                const urlObj = new URL(url, location.href);
                const host = urlObj.hostname;

                if (host.endsWith('.mcdn.bilivideo.cn')) {
                    const target = this.getDomainFromPage();

                    if (!this.isValidFallback(target)) {
                        return url;
                    }

                    urlObj.protocol = 'https:';
                    urlObj.hostname = target;
                    urlObj.port = '';

                    Logger.log(`CDN replace: ${host} -> ${target}`);
                    return urlObj.toString();
                }

                if (host.endsWith('.szbdyd.com')) {
                    const fallback = urlObj.searchParams.get('xy_usource');

                    if (!this.isValidFallback(fallback)) {
                        return url;
                    }

                    urlObj.protocol = 'https:';
                    urlObj.hostname = fallback;
                    urlObj.port = '';

                    Logger.log(`CDN replace: ${host} -> ${fallback}`);
                    return urlObj.toString();
                }

                return url;
            } catch (e) {
                return url;
            }
        },

        deepReplace(obj, seen = new WeakSet()) {
            if (!obj || typeof obj !== 'object') return;
            if (seen.has(obj)) return;

            seen.add(obj);

            if (Array.isArray(obj)) {
                for (let i = 0; i < obj.length; i++) {
                    const item = obj[i];

                    if (typeof item === 'string') {
                        obj[i] = this.replaceUrl(item);
                    } else if (item && typeof item === 'object') {
                        this.deepReplace(item, seen);
                    }
                }

                return;
            }

            for (const key of Object.keys(obj)) {
                const value = obj[key];

                if (typeof value === 'string') {
                    const replaced = this.replaceUrl(value);
                    obj[key] = replaced;

                    const domain = this.detectDomainFromString(replaced);
                    if (domain) this.detectedDomain = domain;
                } else if (value && typeof value === 'object') {
                    this.deepReplace(value, seen);
                }
            }
        },

        hookPlayinfo() {
            if (this.playinfoHooked) return;
            this.playinfoHooked = true;

            let playinfo = W.__playinfo__;

            if (playinfo) {
                this.deepReplace(playinfo);
            }

            HookManager.define('CDNReplacer', W, '__playinfo__', {
                get() {
                    return playinfo;
                },

                set(value) {
                    playinfo = value;
                    if (value) CDNReplacer.deepReplace(value);
                }
            });
        },

        hookMediaSrc() {
            if (this.mediaSrcHooked) return;
            this.mediaSrcHooked = true;

            const proto = W.HTMLMediaElement?.prototype;
            if (!proto) return;

            const desc = Object.getOwnPropertyDescriptor(proto, 'src');
            if (!desc || typeof desc.set !== 'function') return;

            HookManager.define('CDNReplacer', proto, 'src', {
                get: typeof desc.get === 'function'
                    ? function () {
                        return desc.get.call(this);
                    }
                    : undefined,

                set(value) {
                    const replaced = CDNReplacer.replaceUrl(value);
                    return desc.set.call(this, replaced);
                }
            });
        }
    };

    const StatePatcher = {
        hooked: false,

        init() {
            if (this.hooked) return;
            this.hooked = true;

            let state = W.__INITIAL_STATE__;

            if (state) {
                this.patch(state);
            }

            HookManager.define('StatePatcher', W, '__INITIAL_STATE__', {
                get() {
                    return state;
                },

                set(value) {
                    state = value;
                    if (value) StatePatcher.patch(value);
                }
            });
        },

        patch(state) {
            if (!state || typeof state !== 'object') return;

            if (CONFIG.features.hideAds) {
                this.patchAdData(state);
            }

            this.patchElecInfo(state);
        },

        patchAdData(state) {
            const adData = state.adData;
            if (!adData || typeof adData !== 'object') return;

            for (const key of Object.keys(adData)) {
                const items = adData[key];
                if (!Array.isArray(items)) continue;

                for (const item of items) {
                    if (!item || typeof item !== 'object') continue;

                    item.name = 'B 站未来有可能会倒闭，但绝不会变质';
                    item.pic = 'https://static.hdslb.com/images/transparent.gif';
                    item.url = 'https://space.bilibili.com/208259';
                }
            }
        },

        patchElecInfo(state) {
            if (Array.isArray(state.elecFullInfo?.list)) {
                state.elecFullInfo.list = [];
            }
        }
    };

    const FontCleanup = {
        observer: null,

        init() {
            if (!CONFIG.features.cleanFont) return;

            this.removeExisting();

            SafeDOM.ready(() => {
                this.removeExisting();
                this.observe();
            });
        },

        removeExisting() {
            SafeDOM.queryAll(CONFIG.selectors.fontLink).forEach((link) => {
                try {
                    link.remove();
                } catch (e) {
                    Logger.warn('font link remove failed', e);
                }
            });
        },

        observe() {
            if (this.observer || !D.documentElement) return;

            this.observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (!node || node.nodeType !== 1) continue;

                        if (node.matches?.(CONFIG.selectors.fontLink)) {
                            node.remove();
                        }

                        node.querySelectorAll?.(CONFIG.selectors.fontLink).forEach((link) => {
                            link.remove();
                        });
                    }
                }
            });

            this.observer.observe(D.documentElement, {
                childList: true,
                subtree: true
            });
        }
    };

    const DynamicWide = {
        initialized: false,

        init() {
            if (!CONFIG.features.dynamicWide) return;
            if (!Router.isDynamic()) return;

            StyleManager.initDynamicWide();

            if (!StorageManager.has('WIDE_OPT_OUT')) {
                D.documentElement.setAttribute('wide', 'wide');
            }

            if (this.initialized) return;
            this.initialized = true;

            SafeDOM.ready(() => {
                this.injectSwitch();
            });
        },

        injectSwitch() {
            SafeDOM.waitFor(CONFIG.selectors.dynamicTabList, {
                timeout: 15000
            }).then((tabList) => {
                if (SafeDOM.query(CONFIG.selectors.dynamicWideSwitch, tabList)) return;

                const placeholder = SafeDOM.create('div', {
                    style: {
                        flex: '1'
                    }
                });

                const button = SafeDOM.create('a', {
                    id: 'wide-mode-switch',
                    className: 'bili-dyn-list-tabs__item',
                    text: '宽屏模式',
                    href: 'javascript:void(0)'
                });

                button.addEventListener('click', (e) => {
                    e.preventDefault();

                    const isWide = D.documentElement.hasAttribute('wide');

                    if (isWide) {
                        StorageManager.set('WIDE_OPT_OUT', '1');
                        D.documentElement.removeAttribute('wide');
                    } else {
                        StorageManager.remove('WIDE_OPT_OUT');
                        D.documentElement.setAttribute('wide', 'wide');
                    }
                });

                tabList.appendChild(placeholder);
                tabList.appendChild(button);
            }).catch((e) => {
                Logger.warn('dynamic wide switch injection skipped', e);
            });
        }
    };

    const ArticleFix = {
        observer: null,

        init() {
            if (!CONFIG.features.articleCopyFix) return;
            if (!Router.isArticle()) return;

            SafeDOM.ready(() => {
                SafeDOM.waitFor(CONFIG.selectors.articleHolder, {
                    timeout: 15000
                }).then((holder) => {
                    this.patchHolder(holder);
                }).catch((e) => {
                    Logger.warn('article holder not found', e);
                });
            });
        },

        patchHolder(holder) {
            try {
                if (W.original && typeof W.original === 'object') {
                    W.original.reprint = '1';
                }

                holder.classList.remove('unable-reprint');

                if (!holder.__MBGA_COPY_FIXED__) {
                    holder.__MBGA_COPY_FIXED__ = true;

                    holder.addEventListener('copy', (e) => {
                        e.stopImmediatePropagation();
                    }, true);
                }
            } catch (e) {
                Logger.error('article copy fix failed', e);
            }
        }
    };

    const VideoFit = {
        observer: null,

        init() {
            if (!CONFIG.features.videoFit) return;
            if (!Router.isVideo()) return;

            StyleManager.initVideoFit();

            const saved = StorageManager.isTrue('MBGA_VIDEO_FIT');
            D.body?.toggleAttribute('video-fit', saved);

            SafeDOM.ready(() => {
                if (!this.observer) {
                    this.observer = SafeDOM.observeFor(
                        CONFIG.selectors.playerSettingLeft,
                        (container) => this.injectButton(container),
                        {
                            once: false
                        }
                    );
                }

                SafeDOM.waitFor(CONFIG.selectors.playerSettingLeft, {
                    timeout: 15000
                }).then((container) => {
                    this.injectButton(container);
                }).catch(() => { });
            });
        },

        injectButton(container) {
            if (!container || container.querySelector(CONFIG.selectors.videoFitButton)) return;

            const more = container.querySelector(CONFIG.selectors.playerSettingMore);

            const item = SafeDOM.create('div', {
                className: 'bpx-player-ctrl-setting-fit-mode bui bui-switch mbga-fit-mode'
            });

            const input = SafeDOM.create('input', {
                className: 'bui-switch-input',
                type: 'checkbox',
                id: 'mbga-fit-toggle'
            });

            input.checked = StorageManager.isTrue('MBGA_VIDEO_FIT');

            const label = SafeDOM.create('label', {
                className: 'bui-switch-label',
                for: 'mbga-fit-toggle'
            });

            const labelName = SafeDOM.create('span', {
                className: 'bui-switch-name',
                text: '裁切模式'
            });

            const switchBody = SafeDOM.create('span', {
                className: 'bui-switch-body'
            });

            const switchDot = SafeDOM.create('span', {
                className: 'bui-switch-dot'
            });

            switchDot.appendChild(SafeDOM.create('span'));
            switchBody.appendChild(switchDot);
            label.appendChild(labelName);
            label.appendChild(switchBody);

            item.appendChild(input);
            item.appendChild(label);

            input.addEventListener('change', (e) => {
                const enabled = Boolean(e.target.checked);

                StorageManager.set('MBGA_VIDEO_FIT', enabled);
                D.body?.toggleAttribute('video-fit', enabled);
            });

            if (more) {
                container.insertBefore(item, more);
            } else {
                container.appendChild(item);
            }

            const panel = SafeDOM.query(CONFIG.selectors.playerSettingPanel);
            if (panel) {
                panel.style.height = '';
            }
        }
    };

    const LiveCDNOptimizer = {
        initialized: false,

        init() {
            if (this.initialized) return;
            this.initialized = true;

            W.disableMcdn = typeof W.disableMcdn === 'boolean' ? W.disableMcdn : true;
            W.disableSmtcdns = typeof W.disableSmtcdns === 'boolean' ? W.disableSmtcdns : true;
            W.forceHighestQuality = W.forceHighestQuality === true
                || StorageManager.isTrue('forceHighestQuality');

            NetworkManager.addRule('live-cdn-optimizer', (url) => {
                if (!Router.isLive()) return null;

                let current = url;

                if (W.disableMcdn && CONFIG.live.mcdnPattern.test(current)) {
                    return {
                        block: true,
                        mode: 'reject',
                        reason: 'live-mcdn-block'
                    };
                }

                if (W.disableSmtcdns && CONFIG.live.smtcdnsPattern.test(current)) {
                    current = current.replace(CONFIG.live.smtcdnsPattern, '$1');
                }

                const shouldForceHighest = LiveFailureGuard.canAutoHigh()
                    && (W.forceHighestQuality === true
                        || StorageManager.isTrue('forceHighestQuality'));

                if (shouldForceHighest && CONFIG.live.qualityPattern.test(current)) {
                    current = current
                        .replace(CONFIG.live.qualityPattern, '$1')
                        .replace(CONFIG.live.hevcPattern, '$1');
                }

                return current !== url ? current : null;
            });
        }
    };

    const LiveFailureGuard = {
        initialized: false,
        recentErrors: 0,
        lastErrorAt: 0,
        tripped: false,
        decayTimer: null,

        init() {
            if (this.initialized) return;
            this.initialized = true;

            NetworkManager.addFetchObserver('live-failure-guard', (url, response, error) => {
                if (!Router.isLive()) return;
                if (!CONFIG.live.mediaPattern.test(url)) return;

                if (error || [403, 404].includes(response?.status)) {
                    this.recordFailure();
                }
            });

            this.startDecay();
        },

        recordFailure() {
            this.recentErrors += 1;
            this.lastErrorAt = Date.now();

            if (this.recentErrors >= CONFIG.live.errorLimit) {
                this.trip();
            }
        },

        canAutoHigh() {
            return !this.tripped;
        },

        startDecay() {
            if (this.decayTimer) return;

            this.decayTimer = setInterval(() => {
                if (this.recentErrors > 0) {
                    this.recentErrors = Math.floor(this.recentErrors / 2);
                }

                if (
                    this.tripped
                    && this.recentErrors === 0
                    && Date.now() - this.lastErrorAt >= CONFIG.live.recoveryMs
                ) {
                    this.recover();
                }
            }, CONFIG.live.errorDecayMs);
        },

        trip() {
            if (this.tripped) return;

            this.tripped = true;
            LiveQualityController.suppressHigh();

            try {
                if (typeof GM_notification === 'function') {
                    GM_notification({
                        title: '最高清晰度可能不可用',
                        text: '已暂停自动拉高画质，网络稳定后会自动恢复。',
                        timeout: 3000,
                        silent: true
                    });
                }
            } catch (e) {
                Logger.warn('notification failed', e);
            }
        },

        recover() {
            if (!this.tripped) return;

            this.tripped = false;
            this.recentErrors = 0;
            LiveQualityController.onFailureRecovery();
            Logger.log('live quality auto-high recovered');
        }
    };

    const LiveQualityController = {
        initialized: false,
        ready: false,
        switching: false,
        pendingSelection: null,
        lastAction: null,
        lastActionTime: 0,
        initAttempts: 0,
        operationId: 0,
        pageFocused: true,
        initTimer: null,

        selectors: Object.freeze({
            qualityWrap: '.quality-wrap',
            qualityItems: '.quality-wrap .quality-item',
            activeQuality: '.quality-wrap .quality-item.active',
            refreshButton: Object.freeze([
                '.bilibili-player-video-refresh, .video-refresh',
                '[title*="刷新"]',
                '[aria-label*="刷新"]'
            ])
        }),

        qualityRanks: Object.freeze([
            Object.freeze(['杜比', 30000]),
            Object.freeze(['4K', 20000]),
            Object.freeze(['2160P', 20000]),
            Object.freeze(['2K', 15000]),
            Object.freeze(['1440P', 15000]),
            Object.freeze(['原画', 10000]),
            Object.freeze(['蓝光', 400]),
            Object.freeze(['1080P', 400]),
            Object.freeze(['超清', 250]),
            Object.freeze(['720P', 250]),
            Object.freeze(['高清', 150]),
            Object.freeze(['480P', 150]),
            Object.freeze(['流畅', 80])
        ]),

        qualityAttrs: Object.freeze([
            'data-qn',
            'data-quality',
            'data-value',
            'data-key',
            'qn',
            'quality',
            'value'
        ]),

        knownQn: new Set([80, 150, 250, 400, 10000, 15000, 20000, 30000]),
        actionDebounceMs: 800,
        menuRetryCount: 8,
        menuRetryDelayMs: 150,
        initIntervalMs: 1000,
        initMaxAttempts: 120,

        init() {
            if (this.initialized) return;
            this.initialized = true;

            D.addEventListener('visibilitychange', () => {
                if (D.hidden) this.handleHide();
                else this.handleShow();
            });

            W.addEventListener('blur', () => {
                this.pageFocused = false;
                this.handleHide();
            });

            W.addEventListener('focus', () => {
                this.pageFocused = true;
                this.handleShow();
            });

            this.initTimer = setInterval(() => {
                this.initAttempts += 1;
                this.ensureInit();

                if (this.ready) {
                    this.sync(false);
                    clearInterval(this.initTimer);
                    this.initTimer = null;
                } else if (this.initAttempts >= this.initMaxAttempts) {
                    clearInterval(this.initTimer);
                    this.initTimer = null;
                }
            }, this.initIntervalMs);

            this.ensureInit();
            if (this.ready) this.sync(false);
        },

        now() {
            return Date.now();
        },

        normalizeText(text) {
            return String(text || '').replace(/\s+/g, '').trim();
        },

        getElementText(el) {
            return this.normalizeText(el && (el.innerText || el.textContent));
        },

        getItems() {
            return SafeDOM.queryAll(this.selectors.qualityItems);
        },

        getCurrent() {
            const active = SafeDOM.query(this.selectors.activeQuality);
            return active ? this.getElementText(active) : null;
        },

        openMenu() {
            const btn = SafeDOM.query(this.selectors.qualityWrap);
            if (!btn) return false;

            btn.click();
            return true;
        },

        parseKnownQn(value) {
            const text = this.normalizeText(value);
            const match = text.match(/(?:^|[^\d])(30000|20000|15000|10000|400|250|150|80)(?:[^\d]|$)/);
            if (!match) return null;

            const qn = Number(match[1]);
            return this.knownQn.has(qn) ? qn : null;
        },

        readAttributeQn(el) {
            if (!el) return null;

            if (el.dataset) {
                for (const value of Object.values(el.dataset)) {
                    const qn = this.parseKnownQn(value);
                    if (qn) return qn;
                }
            }

            if (typeof el.getAttribute === 'function') {
                for (const attr of this.qualityAttrs) {
                    const qn = this.parseKnownQn(el.getAttribute(attr));
                    if (qn) return qn;
                }
            }

            return null;
        },

        getQualityQn(el) {
            const attrQn = this.readAttributeQn(el);
            if (attrQn) return attrQn;

            const text = this.getElementText(el);
            const textQn = this.parseKnownQn(text);
            if (textQn) return textQn;

            for (const [keyword, qn] of this.qualityRanks) {
                if (text.includes(keyword)) return qn;
            }

            return null;
        },

        getLowestItem(items) {
            let bestItem = null;
            let bestRank = Number.POSITIVE_INFINITY;

            for (const item of items) {
                const rank = this.getQualityQn(item);
                if (!rank) continue;

                if (rank < bestRank) {
                    bestItem = item;
                    bestRank = rank;
                }
            }

            return bestItem || items[items.length - 1] || null;
        },

        getHighestItem(items) {
            let bestItem = null;
            let bestRank = Number.NEGATIVE_INFINITY;

            for (const item of items) {
                const rank = this.getQualityQn(item);
                if (!rank) continue;

                if (rank > bestRank) {
                    bestItem = item;
                    bestRank = rank;
                }
            }

            return bestItem || items[0] || null;
        },

        waitForItems(callback, retries = this.menuRetryCount) {
            const items = this.getItems();

            if (items.length > 0 || retries <= 0) {
                callback(items);
                return;
            }

            setTimeout(
                () => this.waitForItems(callback, retries - 1),
                this.menuRetryDelayMs
            );
        },

        shouldSkip(action) {
            return this.lastAction === action
                && this.now() - this.lastActionTime < this.actionDebounceMs;
        },

        markAction(action) {
            this.lastAction = action;
            this.lastActionTime = this.now();
        },

        clickPlayerRefresh() {
            for (const selector of this.selectors.refreshButton) {
                const refreshBtn = SafeDOM.query(selector);
                if (refreshBtn) {
                    refreshBtn.click();
                    Logger.log('live player refreshed');
                    return true;
                }
            }

            Logger.log('live player refresh button not found');
            return false;
        },

        ensureInit() {
            if (this.ready) return;

            const current = this.getCurrent();
            if (!current) return;

            this.ready = true;
            Logger.log('live quality initialized:', current);
        },

        sync(refreshAfterSwitch) {
            if (D.hidden || !this.pageFocused) {
                this.switchToLow();
            } else {
                this.switchToHigh(refreshAfterSwitch);
            }
        },

        selectQuality(mode, refreshAfterSwitch) {
            if (mode === 'high' && !LiveFailureGuard.canAutoHigh()) return;

            this.ensureInit();

            if (this.switching) {
                this.pendingSelection = { mode, refreshAfterSwitch };
                return;
            }

            if (!this.ready || this.shouldSkip(mode)) return;

            const currentOperation = ++this.operationId;
            this.switching = true;
            this.markAction(mode);

            if (!this.openMenu()) {
                this.switching = false;
                Logger.warn('live quality menu not found');
                return;
            }

            this.waitForItems((items) => {
                if (currentOperation !== this.operationId) return;

                if (this.pendingSelection) {
                    mode = this.pendingSelection.mode;
                    refreshAfterSwitch = this.pendingSelection.refreshAfterSwitch;
                    this.pendingSelection = null;
                    this.markAction(mode);
                }

                if (mode === 'high' && !LiveFailureGuard.canAutoHigh()) {
                    this.switching = false;
                    return;
                }

                const target = mode === 'low'
                    ? this.getLowestItem(items)
                    : this.getHighestItem(items);

                const active = SafeDOM.query(this.selectors.activeQuality);
                const targetQn = this.getQualityQn(target);
                const activeQn = this.getQualityQn(active);
                const alreadySelected = Boolean(
                    target
                    && active
                    && (
                        target === active
                        || (targetQn && activeQn && targetQn === activeQn)
                        || this.getElementText(target) === this.getElementText(active)
                    )
                );

                if (target && !alreadySelected) {
                    target.click();
                    Logger.log(
                        mode === 'low' ? 'live quality -> low:' : 'live quality -> high:',
                        this.getElementText(target)
                    );
                } else if (!target) {
                    Logger.warn('live quality option not found');
                }

                if (target && !alreadySelected && refreshAfterSwitch) {
                    setTimeout(() => {
                        if (currentOperation === this.operationId) {
                            this.clickPlayerRefresh();
                        }
                    }, 300);
                }

                this.switching = false;
            });
        },

        switchToLow() {
            this.selectQuality('low', false);
        },

        switchToHigh(refreshAfterSwitch = false) {
            this.selectQuality('high', refreshAfterSwitch);
        },

        handleHide() {
            this.switchToLow();
        },

        handleShow() {
            this.switchToHigh(true);
        },

        suppressHigh() {
            if (this.pendingSelection?.mode === 'high') {
                this.pendingSelection = null;
            }

            this.operationId += 1;
            this.switching = false;
        },

        onFailureRecovery() {
            if (!Router.isLive() || D.hidden || !this.pageFocused) return;
            this.switchToHigh(false);
        }
    };

    const LiveOptimizer = {
        initialized: false,

        init() {
            if (!CONFIG.features.liveOptimizer || !Router.isLive()) return;

            StyleManager.initLive();

            if (this.initialized) return;
            this.initialized = true;

            LiveCDNOptimizer.init();
            LiveFailureGuard.init();
            LiveQualityController.init();
        }
    };

    const App = {
        started: false,
        routeTimer: null,

        init() {
            if (this.started) return;
            this.started = true;

            const api = {
                version: '3.3.1',
                config: CONFIG,
                hooks: HookManager,
                live: Object.freeze({
                    optimizer: LiveOptimizer,
                    cdn: LiveCDNOptimizer,
                    quality: LiveQualityController,
                    failureGuard: LiveFailureGuard
                }),
                restoreAll: () => HookManager.restoreAll(),
                restore: (owner) => HookManager.restore(owner)
            };

            W.__BILIFORGE__ = api;
            W.__MBGA_PROMAX__ = api;
            W.__MBGA__ = api;

            if (CONFIG.features.removeGrayFilter || CONFIG.features.hideAds || CONFIG.features.cleanFont) {
                StyleManager.initBase();
            }

            NetworkManager.init();

            TrackerBlocker.init();
            PrivacyGuard.init();
            P2PBlocker.init();
            CDNReplacer.init();
            StatePatcher.init();
            FontCleanup.init();
            URLCleaner.init();

            this.initRouteModules();

            SafeDOM.ready(() => {
                this.initRouteModules();
            });

            SafeDOM.loaded(() => {
                this.initRouteModules();
            });

            Logger.log('initialized');
        },

        onRouteChange() {
            clearTimeout(this.routeTimer);

            this.routeTimer = setTimeout(() => {
                URLCleaner.cleanCurrentUrl();
                this.initRouteModules();
            }, 80);
        },

        initRouteModules() {
            try {
                DynamicWide.init();
                ArticleFix.init();
                VideoFit.init();

                if (Router.isLive()) {
                    LiveOptimizer.init();
                }
            } catch (e) {
                Logger.error('route module init failed', e);
            }
        }
    };

    App.init();

})(typeof unsafeWindow !== 'undefined' ? unsafeWindow : window, document);
