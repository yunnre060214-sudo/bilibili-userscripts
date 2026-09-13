// ==UserScript==
// @name         B站直播 自动最高/最低画质（前台最高 后台最低）
// @namespace    http://tampermonkey.net/
// @version      2.4.1
// @updateURL    https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-live-auto-quality.user.js
// @downloadURL  https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-live-auto-quality.user.js
// @match        https://live.bilibili.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SELECTORS = {
        qualityWrap: '.quality-wrap',
        qualityItems: '.quality-wrap .quality-item',
        activeQuality: '.quality-wrap .quality-item.active',
        refreshButton: [
            '.bilibili-player-video-refresh, .video-refresh',
            '[title*="刷新"]',
            '[aria-label*="刷新"]',
        ],
    };

    const QUALITY_QN = [
        ['杜比', 30000],
        ['4K', 20000],
        ['2160P', 20000],
        ['2K', 15000],
        ['1440P', 15000],
        ['原画', 10000],
        ['蓝光', 400],
        ['1080P', 400],
        ['超清', 250],
        ['720P', 250],
        ['高清', 150],
        ['480P', 150],
        ['流畅', 80],
    ];

    const KNOWN_QN = new Set([80, 150, 250, 400, 10000, 15000, 20000, 30000]);
    const QUALITY_ATTRS = [
        'data-qn',
        'data-quality',
        'data-value',
        'data-key',
        'qn',
        'quality',
        'value',
    ];

    const ACTION_DEBOUNCE = 800;
    const MENU_RETRY_COUNT = 8;
    const MENU_RETRY_DELAY = 150;
    const INIT_INTERVAL = 1000;
    const INIT_MAX_ATTEMPTS = 120;

    let ready = false;
    let switching = false;
    let lastAction = null;
    let lastActionTime = 0;
    let initAttempts = 0;
    let operationId = 0;

    function now() {
        return Date.now();
    }

    function normalizeText(text) {
        return String(text || '').replace(/\s+/g, '').trim();
    }

    function getElementText(el) {
        return normalizeText(el && (el.innerText || el.textContent));
    }

    function log(...args) {
        console.log('[画质]', ...args);
    }

    function warn(...args) {
        console.warn('[画质]', ...args);
    }

    function getItems() {
        return Array.from(document.querySelectorAll(SELECTORS.qualityItems));
    }

    function getCurrent() {
        const active = document.querySelector(SELECTORS.activeQuality);
        return active ? getElementText(active) : null;
    }

    function openMenu() {
        const btn = document.querySelector(SELECTORS.qualityWrap);
        if (!btn) return false;

        btn.click();
        return true;
    }

    function parseKnownQn(value) {
        const text = normalizeText(value);
        const match = text.match(/(?:^|[^\d])(30000|20000|15000|10000|400|250|150|80)(?:[^\d]|$)/);
        if (!match) return null;

        const qn = Number(match[1]);
        return KNOWN_QN.has(qn) ? qn : null;
    }

    function readAttributeQn(el) {
        if (!el) return null;

        if (el.dataset) {
            for (const value of Object.values(el.dataset)) {
                const qn = parseKnownQn(value);
                if (qn) return qn;
            }
        }

        if (typeof el.getAttribute === 'function') {
            for (const attr of QUALITY_ATTRS) {
                const qn = parseKnownQn(el.getAttribute(attr));
                if (qn) return qn;
            }
        }

        return null;
    }

    function getQualityQn(el) {
        const attrQn = readAttributeQn(el);
        if (attrQn) return attrQn;

        const text = getElementText(el);
        const textQn = parseKnownQn(text);
        if (textQn) return textQn;

        for (const [keyword, qn] of QUALITY_QN) {
            if (text.includes(keyword)) return qn;
        }

        return null;
    }

    function getLowestItem(items) {
        let bestItem = null;
        let bestRank = Number.POSITIVE_INFINITY;

        for (const item of items) {
            const rank = getQualityQn(item);
            if (!rank) continue;

            if (rank < bestRank) {
                bestItem = item;
                bestRank = rank;
            }
        }

        return bestItem || items[items.length - 1] || null;
    }

    function getHighestItem(items) {
        let bestItem = null;
        let bestRank = Number.NEGATIVE_INFINITY;

        for (const item of items) {
            const rank = getQualityQn(item);
            if (!rank) continue;

            if (rank > bestRank) {
                bestItem = item;
                bestRank = rank;
            }
        }

        return bestItem || items[0] || null;
    }

    function waitForItems(callback, retries = MENU_RETRY_COUNT) {
        const items = getItems();
        if (items.length > 0 || retries <= 0) {
            callback(items);
            return;
        }

        setTimeout(() => waitForItems(callback, retries - 1), MENU_RETRY_DELAY);
    }

    function shouldSkip(action) {
        return lastAction === action && now() - lastActionTime < ACTION_DEBOUNCE;
    }

    function markAction(action) {
        lastAction = action;
        lastActionTime = now();
    }

    function clickPlayerRefresh() {
        for (const selector of SELECTORS.refreshButton) {
            const refreshBtn = document.querySelector(selector);
            if (refreshBtn) {
                refreshBtn.click();
                log('已点击播放器刷新');
                return true;
            }
        }

        warn('未找到播放器刷新按钮');
        return false;
    }

    function ensureInit() {
        if (ready) return;

        const q = getCurrent();
        if (!q) return;

        ready = true;
        log('初始:', q);
    }

    function selectQuality(mode, refreshAfterSwitch) {
        ensureInit();
        if (!ready || switching || shouldSkip(mode)) return;

        const currentOperation = ++operationId;
        switching = true;
        markAction(mode);

        if (!openMenu()) {
            switching = false;
            warn('未找到画质菜单');
            return;
        }

        waitForItems((items) => {
            if (currentOperation !== operationId) return;

            const target = mode === 'low' ? getLowestItem(items) : getHighestItem(items);
            if (target) {
                target.click();
                log(mode === 'low' ? '已切换到低画质:' : '已切换到最高画质:', getElementText(target));
            } else {
                warn('未找到可选画质');
            }

            if (refreshAfterSwitch) {
                setTimeout(() => {
                    if (currentOperation === operationId) clickPlayerRefresh();
                }, 300);
            }

            switching = false;
        });
    }

    function switchToLow() {
        selectQuality('low', false);
    }

    function switchToHigh(refreshAfterSwitch) {
        selectQuality('high', refreshAfterSwitch);
    }

    function handleHide() {
        switchToLow();
    }

    function handleShow() {
        switchToHigh(true);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) handleHide();
        else handleShow();
    });

    window.addEventListener('blur', handleHide);
    window.addEventListener('focus', handleShow);

    const timer = setInterval(() => {
        initAttempts += 1;
        ensureInit();
        if (ready) {
            if (document.hidden) switchToLow();
            else switchToHigh(false);
            clearInterval(timer);
        } else if (initAttempts >= INIT_MAX_ATTEMPTS) {
            clearInterval(timer);
        }
    }, INIT_INTERVAL);
})();
