// ==UserScript==
// @name         Steam 补充包制作助手
// @namespace    https://github.com/awakaze/
// @version      0.3.0
// @description  按宝石做包利润筛选 Steam 补充包，支持拉黑/收藏/做包队列/自动做包列表。自动列表由「自动做包」开关控制，轮询盯冷却到点自动制作（可配置间隔）：到点实时查价过利润闸门（"强制"可绕过）后制作，成功/失败按批次系统通知，宝石不足立即通知，可恢复错误退避重试。价格全部走市场搜索接口（普通卡 cardborder_0 / 补充包 item_class_5，精确分值），每游戏 2 个请求；逐卡单独计税后取平均，手续费按卖家到手价精确反解（2025-12 手续费新规）。商店游戏详情页同步显示利润条。
// @author       awakaze
// @match        https://steamcommunity.com/tradingcards/boostercreator*
// @match        https://steamcommunity.com/tradingcards/boostercreator/*
// @match        https://steamcommunity.com//tradingcards/boostercreator/*
// @match        https://store.steampowered.com/app/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      steamcommunity.com
// @connect      store.steampowered.com
// @noframes
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    if (window.__sbtLoaded) { return; }
    window.__sbtLoaded = true;

    // --------------------------------------------------------------------------------
    // 通用工具
    // --------------------------------------------------------------------------------
    const $ = (sel, root) => (root || document).querySelector(sel);

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function safeJSON(str) {
        try { return JSON.parse(str); } catch (e) { return null; }
    }

    function fmtNum(cents) {
        if (!Number.isFinite(cents)) return '未知';
        return (cents / 100).toFixed(2);
    }

    function today() {
        const d = new Date();
        const p = (n) => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    // --------------------------------------------------------------------------------
    // Steam 手续费模型（尽可能真实）
    // 规则：卖家设定"到手价 R"，买家支付 P = R + fee(R)；
    //       fee(R) = max(minFee, floor(R*5%)) + max(minFee, floor(R*10%))，向下取整到分
    // 【2025年12月起】单笔手续费最低额提高到 $0.01 等值：国区 = ¥0.07（旧值 ¥0.01 已失效）。
    // 实测校验（真实挂单数据）：到手 60 分 → 买方 74（60+7+7）；到手 85 → 买方 100（85+7+8）；
    // 国区最低挂单价因此为 ¥0.21（7+7+7）。
    // 注意：7 仅对人民币区实测成立；其他币种为各自 $0.01 等值，换钱包币种需改此处。
    // --------------------------------------------------------------------------------
    const DEFAULT_FEE = {
        txRate: 0.05,    // Steam 交易费 5%
        gameRate: 0.10,  // 游戏分成费（卡牌/补充包属 Steam 本体）10%
        minFee: 7        // 单笔最低 7 分（人民币区，2025-12 起 $0.01 等值）
    };
    // 按卖家到手价 R 计算总手续费（分）
    function feeOf(receiveCents, f) {
        return Math.max(f.minFee, Math.floor(receiveCents * f.txRate))
             + Math.max(f.minFee, Math.floor(receiveCents * f.gameRate));
    }
    // 输入买家支付价 P（即市场 sell_price），反解卖家到手价 R（分）
    // 迭代求解 R + fee(R) = P；兜底保证 R + fee(R) <= P（宁可少算不多算）
    function sellerNet(buyerPriceCents, fee) {
        const f = fee || DEFAULT_FEE;
        if (!Number.isFinite(buyerPriceCents) || buyerPriceCents < 0) { return 0; }
        let r = Math.max(0, buyerPriceCents - 2 * f.minFee);
        for (let i = 0; i < 8; i++) {
            const nr = buyerPriceCents - feeOf(r, f);
            if (nr === r) { break; }
            r = nr;
            if (r < 0) { return 0; }
        }
        while (r > 0 && r + feeOf(r, f) > buyerPriceCents) { r--; }
        return r;
    }

    // --------------------------------------------------------------------------------
    // 卡牌数量 <-> 所需宝石数 映射（官方对应关系）
    // --------------------------------------------------------------------------------
    const CARDCOUNT_TO_GEMS = { 5: 1200, 6: 1000, 7: 857, 8: 750, 9: 667, 10: 600, 11: 545, 12: 500, 13: 462, 14: 429, 15: 400 };
    const GEMS_TO_CARDCOUNT = {};
    Object.keys(CARDCOUNT_TO_GEMS).forEach((k) => { GEMS_TO_CARDCOUNT[CARDCOUNT_TO_GEMS[k]] = Number(k); });

    // --------------------------------------------------------------------------------
    // GM 存储（跨页面持久化）
    // --------------------------------------------------------------------------------
    const KEY_CONFIG = 'sbt_config';
    const KEY_LISTS = 'sbt_lists';
    const KEY_CACHE = 'sbt_cache';
    const KEY_RETRY = 'sbt_auto_retry';

    const DEFAULT_CONFIG = {
        autoPoll: false,            // 自动做包轮询总开关（盯自动列表，到 CD 自动制作）
        pollInterval_min: 10,       // 轮询间隔（分钟）：本地定时检查，无网络请求开销
        profitThreshold: 0.10,      // 利润阈值（默认 10%）
        gemPriceSource: 'market',   // 'market' | 'custom'
        customGemPrice: 270,        // 自定义一袋宝石价（分，按钱包币种）
        reqInterval: 250,           // 请求间隔 ms（防风控）
        maxRetries: 3,              // 单请求失败/限流重试次数
        priceCacheTTL_min: 30,      // 价格缓存有效期（分钟）：卡牌/补充包/宝石价统一 30 分钟
        forceList: {}               // 逐游戏强制制作 {appid: 1}
    };

    let config;
    let lists;    // { queue:[], collect:[], auto:[], black:[] } 元素为 appid 字符串
    let cache;    // { cardInfo, boosterInfo, history }
    let retryState;  // { appid: { attempts, nextTry, reason, givenUp } } 自动做包退避状态（持久化）
    const doneSession = new Set();  // 本会话已处理完（做成/跳过/放弃）的游戏，防同会话反复触发

    function loadState() {
        const c = GM_getValue(KEY_CONFIG, null);
        config = Object.assign({}, DEFAULT_CONFIG, c || {});
        if (!config.forceList) { config.forceList = {}; }
        lists = GM_getValue(KEY_LISTS, { queue: [], collect: [], black: [] });
        lists.queue = lists.queue || [];
        lists.collect = lists.collect || [];
        lists.auto = lists.auto || [];
        lists.black = lists.black || [];
        cache = GM_getValue(KEY_CACHE, null);
        if (!cache) {
            cache = { cardInfo: {}, boosterInfo: {}, history: {} };
        }
        cache.cardInfo = cache.cardInfo || {};
        cache.boosterInfo = cache.boosterInfo || {};
        cache.history = cache.history || {};
        cache.gemPrice = cache.gemPrice || {};
        retryState = GM_getValue(KEY_RETRY, {}) || {};
    }
    function saveConfig() { GM_setValue(KEY_CONFIG, config); }
    function saveLists() { GM_setValue(KEY_LISTS, lists); }
    function saveCache() { GM_setValue(KEY_CACHE, cache); }
    function saveRetry() { GM_setValue(KEY_RETRY, retryState); }

    // 删除单个游戏的退避状态：先删内存，再基于存储最新快照删键回写（防多标签页用旧快照覆盖新状态）
    function dropRetryKey(appid) {
        delete retryState[appid];
        try {
            const fresh = GM_getValue(KEY_RETRY, {});
            if (fresh && typeof fresh === 'object') {
                delete fresh[appid];
                GM_setValue(KEY_RETRY, fresh);
                retryState = fresh;   // 内存同步到存储最新快照，防后续 saveRetry 用旧内存整包回写
            } else { saveRetry(); }
        } catch (e) { saveRetry(); }
    }

    // --------------------------------------------------------------------------------
    // 请求管线：严格串行 + 限速 + 风控识别 + 指数退避重试（修复旧脚本"查询卡死"）
    // --------------------------------------------------------------------------------
    const q = {
        chain: Promise.resolve(),
        curDelay: DEFAULT_CONFIG.reqInterval,
        pending: 0,
        // 将任务排入串行队列；fn 返回原始 response
        run(fn) {
            const task = this.chain.then(() => this._exec(fn));
            this.chain = task.then(() => { this.curDelay = config.reqInterval; }, () => { this.curDelay = config.reqInterval; });
            return task;
        },
        async _exec(fn) {
            let attempt = 0;
            for (;;) {
                await sleep(this.curDelay);
                this.pending++;
                let res;
                try { res = await fn(); } catch (e) { res = null; }
                this.pending--;
                const limited = res ? isRateLimited(res) : true;
                const blocked = res ? (res.status === 401 || res.status === 403 || res.status === 418) : false;
                // 登录墙/风控拦截不会靠"再等下重试"恢复，直接交回调用方，避免整轮磨时间
                if (blocked || res === null) { return res; }
                if (res.status === 429 || limited) {
                    // 限流时最多自动重试 1 次；否则单个请求会烧掉十几秒退避，一个游戏就"卡几分钟"
                    if (attempt >= 1) { return res; }
                    attempt++;
                    this.curDelay = Math.max(this.curDelay, 3000); // 遇限流先放慢节奏
                    await sleep(this.curDelay);
                    continue;
                }
                return res; // 正常 / 其他状态码 直接返回
            }
        }
    };

    function gmFetch(method, url, opts) {
        return new Promise((resolve, reject) => {
            const baseHeaders = {
                'Accept': 'application/json, text/html, application/xhtml+xml, */*;q=0.8',
                'Accept-Language': (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN',
                'Referer': 'https://steamcommunity.com/tradingcards/boostercreator/'
            };
            const headers = Object.assign(baseHeaders, (opts && opts.headers) || {});
            const reqOpts = {
                method,
                url,
                headers,
                cookie: document.cookie,
                timeout: 30000,
                onload: (res) => { res.__url = url; resolve(res); },
                onerror: (e) => reject(e),
                ontimeout: () => reject(new Error('timeout'))
            };
            // POST 等请求的 body（表单字符串）；缺失会导致 Steam 收到空 body 而报错
            if (opts && opts.data) { reqOpts.data = opts.data; }
            try {
                GM_xmlhttpRequest(reqOpts);
            } catch (e) { reject(e); }
        });
    }

    // 风控识别：429 / 限流文案 / 空响应 / 不符合预期的登录跳转
    function isRateLimited(res) {
        if (!res) { return true; }
        if (res.status === 429 || res.status === 0) { return true; }
        const body = typeof res.responseText === 'string' ? res.responseText : (res.response || '');
        if (typeof body === 'string') {
            if (/please try again later|rate limit|too many requests|restricted|rate-limit/i.test(body)) { return true; }
            if (res.status === 302 || /login/i.test(body.slice(0, 400))) { return true; }
        }
        return false;
    }

    // 一个请求返回内容的简短诊断（状态码 + 首段文本），用于把"为什么失败"打出来
    function describeRes(res) {
        if (!res) { return 'ERR(no response)'; }
        const st = res.status != null ? 'HTTP ' + res.status : 'ERR';
        const body = typeof res.responseText === 'string' ? res.responseText : '';
        const m = body.replace(/[\n\r\t]+/g, ' ').slice(0, 100).trim();
        return m ? `${st} | ${m}` : `${st}`;
    }

    async function request(method, url, opts) {
        const res = await q.run(() => gmFetch(method, url, opts));
        // 敏感失败（限流耗尽 / 登录墙 / 拦截）打日志，帮助定位，不影响流程继续
        if (res && (res.status === 429 || res.status === 401 || res.status === 403 || res.status === 418 || res.status === 0)) {
            console.warn('[sbt] 请求受阻', method, describeRes(res));
        }
        return res;
    }

    // --------------------------------------------------------------------------------
    // 价格查询：全部走官方 search/render 接口（norender=1 返回 JSON，sell_price 为
    // 钱包币种精确分值，无需解析本地化价格字符串）。查询语义与以下页面链接完全一致：
    //   普通卡:  /market/search?appid=753&category_Game=app_X&category_cardborder=cardborder_0
    //   补充包:  /market/search?appid=753&category_Game=app_X&category_item_class=item_class_5
    // （新版页面参数在 render 接口上会被忽略，故用等价的老式 category_753_* 参数）
    // --------------------------------------------------------------------------------

    // 通用搜索：按筛选条件取全部结果（服务端把 pagesize 钳到 10，自动翻页）
    async function marketSearch(opts) {
        const items = [];
        let total = 0;
        for (let start = 0, page = 0; page < 6; page++, start = items.length) {
            const up = new URLSearchParams();
            up.set('start', String(start));
            up.set('count', '10');
            up.set('appid', '753');
            up.set('norender', '1');
            if (opts.query) { up.set('query', opts.query); }
            (opts.categories || []).forEach((c) => up.append(c.key, c.value));
            const res = await request('GET', 'https://steamcommunity.com/market/search/render/?' + up.toString(), {
                headers: { 'Referer': 'https://steamcommunity.com/market/search' }
            });
            const j = safeJSON(res && res.responseText);
            if (!j || !j.success || !Array.isArray(j.results)) {
                throw new Error('搜索接口失败: ' + describeRes(res));
            }
            total = Number(j.total_count) || 0;
            for (const r of j.results) {
                items.push({
                    hashName: r.hash_name,
                    name: r.name,
                    sellPrice: Number(r.sell_price) > 0 ? Number(r.sell_price) : null,
                    listings: Number(r.sell_listings) || 0
                });
            }
            if (items.length >= total || !j.results.length) { break; }
        }
        return { total, items };
    }

    // 某游戏全部普通卡（cardborder_0 天然排除闪卡，无需按名字过滤）
    async function fetchGameCards(appid) {
        const { total, items } = await marketSearch({
            categories: [
                { key: 'category_753_Game[]', value: 'tag_app_' + appid },
                { key: 'category_753_cardborder[]', value: 'tag_cardborder_0' }
            ]
        });
        const priced = items.filter((c) => c.sellPrice != null);
        return { total, items, priced };
    }

    // 某游戏补充包（无在售时返回 null）
    async function fetchGameBooster(appid) {
        const { items } = await marketSearch({
            categories: [
                { key: 'category_753_Game[]', value: 'tag_app_' + appid },
                { key: 'category_753_item_class[]', value: 'tag_item_class_5' }
            ]
        });
        return items.length ? items[0] : null;
    }

    // 一袋宝石（1000 宝石）市场最低价（分）
    async function fetchGemSackPrice() {
        const { items } = await marketSearch({ query: 'Sack of Gems' });
        const sack = items.find((it) => /^753-Sack of Gems$/i.test(it.hashName || ''));
        if (!sack || sack.sellPrice == null) { throw new Error('搜索结果中无一袋宝石'); }
        return sack.sellPrice;
    }

    // 宝石价读取（30 分钟缓存；force=true 立即失效重查）
    async function loadGemPrice(force) {
        const ttl = config.priceCacheTTL_min * 60 * 1000;
        const gp = cache.gemPrice;
        if (!force && gp && gp.price != null && gp.orgAt && (Date.now() - gp.orgAt < ttl)) {
            return gp.price;
        }
        const p = await fetchGemSackPrice();
        cache.gemPrice = { price: p, orgAt: Date.now() };
        saveCache();
        return p;
    }

    // --------------------------------------------------------------------------------
    // 卡片数据内存态（由 CBoosterCreatorPage.sm_rgBoosterData 构造）
    // --------------------------------------------------------------------------------
    let allGames = [];   // [{appid,name,price(宝石),series,available_at_time, state}]
    let state = {};      // appid -> { querying:bool, revenue, booster, err }

    function loadBoosterData() {
        const data = (typeof CBoosterCreatorPage !== 'undefined' && CBoosterCreatorPage.sm_rgBoosterData) || {};
        // 统一把 appid 规范为字符串，避免 state/cache/lists/forceList 用 String(appid) 作键时对不上
        return Object.values(data).map((g) => {
            if (g && g.appid !== undefined) { return Object.assign({}, g, { appid: String(g.appid) }); }
            return g;
        });
    }

    // 页面元素引用与工具
    // ------------------------------------------------

    // 全局市场一袋宝石价格（分）——仅用于展示与市场价成本
    let marketGemPrice = null;

    // 做包成本所用的有效宝石价（分）：自定义用了自定义值，否则用市场价
    function effectiveGemPrice() {
        if (config.gemPriceSource === 'custom' && Number.isFinite(config.customGemPrice)) {
            return config.customGemPrice;
        }
        return marketGemPrice;
    }

    function costPerBooster(gems) {
        const p = effectiveGemPrice();
        if (!Number.isFinite(p) || !gems) { return null; }
        return Math.round(gems / 1000 * p);
    }

    // --------------------------------------------------------------------------------
    // 页面元素引用与工具
    // --------------------------------------------------------------------------------
    let boosterPage, gameSelectorArea;

    function initDom() {
        const area = document.querySelector('.booster_creator_area');
        if (!area) { return false; }
        boosterPage = area;
        const sel = document.getElementById('booster_game_selector');
        const selWrap = sel ? sel.closest('div') : null;
        gameSelectorArea = selWrap || area;
        // 保留 Steam 原生「选择一款游戏 + 制作」表单；脚本面板挂到制作区之后的整行宽度处
        return true;
    }

    function toast(msg, ms) {
        let el = document.getElementById('sbt_toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'sbt_toast';
            el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);'
                + 'background:#17212b;color:#67c1f5;border:1px solid #67c1f5;border-radius:6px;'
                + 'padding:14px 22px;z-index:9999;font-size:14px;display:none;box-shadow:0 4px 16px rgba(0,0,0,.5);';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.display = 'block';
        clearTimeout(el._t);
        el._t = setTimeout(() => { el.style.display = 'none'; }, ms || 2500);
    }

    // --------------------------------------------------------------------------------
    // 列表操作
    // --------------------------------------------------------------------------------
    function arrRemove(arr, item) { const i = arr.indexOf(item); if (i > -1) { arr.splice(i, 1); } }

    function operate(appid, type) {
        const a = String(appid);
        // 加入自动列表的公共动作：从其他列表移出 + 清退避/会话标记（重新加入 = 重新开始盯）
        const toAuto = () => {
            arrRemove(lists.queue, a); arrRemove(lists.collect, a); arrRemove(lists.black, a);
            if (lists.auto.indexOf(a) === -1) { lists.auto.push(a); }
            dropRetryKey(a); doneSession.delete(a);
            const gg = allGames.find((x) => String(x.appid) === a);
            if (gg) { gg._craftFail = false; gg._craftDone = false; }   // 清旧制作结果标记，防状态列显示过期信息
        };
        const leaveAuto = (target) => {
            arrRemove(lists.auto, a);
            if (target && lists[target].indexOf(a) === -1) { lists[target].push(a); }
            dropRetryKey(a); doneSession.delete(a);   // 移出自动列表即清退避/放弃状态（防已移出游戏残留"已放弃"提示）
            const gg = allGames.find((x) => String(x.appid) === a);
            if (gg) { gg._craftFail = false; gg._craftDone = false; }
        };
        switch (type) {
            case 'outToQueue': if (lists.queue.indexOf(a) === -1) { lists.queue.push(a); } break;
            case 'outToCollect': if (lists.collect.indexOf(a) === -1) { lists.collect.push(a); } break;
            case 'outToBlack': if (lists.black.indexOf(a) === -1) { lists.black.push(a); } break;
            case 'outToAuto': toAuto(); break;
            case 'collectToQueue': arrRemove(lists.collect, a); if (lists.queue.indexOf(a) === -1) { lists.queue.push(a); } break;
            case 'collectToOut': arrRemove(lists.collect, a); break;
            case 'collectToAuto': arrRemove(lists.collect, a); toAuto(); break;
            case 'queueToCollect': arrRemove(lists.queue, a); if (lists.collect.indexOf(a) === -1) { lists.collect.push(a); } break;
            case 'queueToOut': arrRemove(lists.queue, a); break;
            case 'queueToAuto': arrRemove(lists.queue, a); toAuto(); break;
            case 'autoToOut': leaveAuto(null); break;
            case 'autoToQueue': leaveAuto('queue'); break;
            case 'autoToCollect': leaveAuto('collect'); break;
            case 'blackToOut': arrRemove(lists.black, a); break;
            case 'blackToAuto': arrRemove(lists.black, a); toAuto(); break;
            case 'reset': cache.cardInfo[a] = undefined; saveCache(); break;
            default: return;
        }
        if (type !== 'reset') { saveLists(); }
        if (/ToAuto$/.test(type)) { tryImmediateCraft(a); }   // 加入自动列表 → 立即尝试做一次
        render();
    }

    function oneKeyBlack() {
        let added = 0;
        allGames.forEach((g) => {
            const a = String(g.appid);
            const inQueue = lists.queue.indexOf(a) > -1;
            const inCollect = lists.collect.indexOf(a) > -1;
            const inAuto = lists.auto.indexOf(a) > -1;
            const inBlack = lists.black.indexOf(a) > -1;
            if (!inQueue && !inCollect && !inAuto && !inBlack) { lists.black.push(a); added++; }
        });
        saveLists();
        toast(`已拉黑 ${added} 个未分类游戏`);
        render();
    }

    // --------------------------------------------------------------------------------
    // 做包（自动 + 手动）
    // --------------------------------------------------------------------------------
    function getSessionId() {
        const m = document.cookie.match(/sessionid=([^;]*)/);
        return m ? m[1] : '';
    }

    function isAvailable(g) {
        if (!g.available_at_time) { return true; }          // 无冷却字段 → 可做
        if (typeof g.available_at_time === 'string' && g.available_at_time.match(/[0-9]/)) {
            return Date.now() >= new Date(g.available_at_time).getTime(); // 时间戳 → 看是否已过
        }
        return false;                                        // 文本状态（冷却中/不可做）
    }

    function isBannable(g) {
        const unit = cache.cardInfo[g.appid];
        return !(unit && unit.marketable === false); // 不可交易 → 跳过
    }

    // 利润闸门：< 阈值且未强制 → 跳过
    function shouldCraft(g) {
        if (config.forceList[String(g.appid)]) { return { ok: true, reason: '强制' }; }
        const c = costPerBooster(g.price);
        const rev = getRevenue(g.appid);
        if (rev === null || c === null || c <= 0) { return { ok: false, reason: '无法计算利润' }; }
        const rate = (rev - c) / c;
        if (rate < config.profitThreshold) { return { ok: false, reason: `利润不足(${(rate * 100).toFixed(1)}%)` }; }
        return { ok: true, reason: '' };
    }

    function getRevenue(appid) {
        const st = state[appid];
        if (st && Number.isFinite(st.netPerCard)) { return st.netPerCard * 3; }
        return null;
    }

    async function craftOne(g) {
        const url = 'https://steamcommunity.com/tradingcards/ajaxcreatebooster/';
        const body = new URLSearchParams({
            sessionid: getSessionId(),
            appid: String(g.appid),
            series: String(g.series),
            tradability_preference: '1'
        }).toString();
        let res;
        try {
            res = await request('POST', url, {
                data: body,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'Referer': 'https://steamcommunity.com/tradingcards/boostercreator/',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Origin': 'https://steamcommunity.com'
                }
            });
        } catch (e) {
            const err = new Error('网络错误: ' + String(e && e.message || e));
            err.kind = 'net';
            throw err;
        }
        // 非 200 或触及限流/失败页 → 抛错，供调用方计入失败
        if (!res || res.status >= 400) {
            const text = res && typeof res.responseText === 'string' ? res.responseText : '';
            const err = new Error('HTTP ' + (res && res.status));
            // 实测：宝石不足返回 HTTP 500 + {"purchase_eresult":78,"goo_amount":"112",...}
            // EResult 78 = 余额不足，响应中无文字提示，只能按错误码判定（终态，重试无意义）
            const m = text.match(/"purchase_eresult"\s*:\s*(\d+)/);
            if (m && Number(m[1]) === 78) {
                err.kind = 'gems';
                err.detail = '需 ' + g.price + ' 宝石/包，现有 ' + ((safeJSON(text) || {}).goo_amount || '?') + ' 宝石';
            } else {
                err.kind = 'craft';   // 其余 HTTP 层失败（限流/冷却/服务等）→ 可退避重试
            }
            throw err;
        }
        // 成功响应带 purchaseid；Steam 也可能返回错误 JSON（如冷却中/宝石不足），一并视为失败
        const j = safeJSON(res.responseText);
        if (!j || !j.purchaseid) {
            const text = typeof res.responseText === 'string' ? res.responseText : '';
            const err = new Error('响应异常: ' + describeRes(res));
            // 实测：宝石不足返回 HTTP 500 + {"purchase_eresult":78,"goo_amount":"112",...}
            // EResult 78 = 余额不足，响应中无文字提示，只能按错误码判定（终态，重试无意义）
            const m = text.match(/"purchase_eresult"\s*:\s*(\d+)/);
            const ecode = m ? Number(m[1]) : (j && j.purchase_eresult);
            if (ecode === 78) {
                err.kind = 'gems';
                err.detail = '需 ' + g.price + ' 宝石/包，现有 ' + ((j && j.goo_amount) || '?') + ' 宝石';
            } else {
                err.kind = 'craft';   // 其余错误码（限流/冷却/服务等）→ 可退避重试
            }
            throw err;
        }
    }

    // 队列手动一键制作（与自动列表无关，保持原行为）
    async function runCraft() {
        const target = allGames.filter((g) =>
            lists.queue.indexOf(String(g.appid)) > -1 && isAvailable(g) && isBannable(g)
        );
        const manualBtn = document.getElementById('sbt_craft_btn');
        const setCraftBtn = (text, disabled) => {
            if (!manualBtn) { return; }
            manualBtn.disabled = disabled;
            const sp = manualBtn.querySelector('span');
            if (sp) { sp.textContent = text; } else { manualBtn.textContent = text; }
        };
        if (manualBtn) { setCraftBtn('制作中…', true); }
        const stat = { ok: 0, skip: 0, fail: 0 };
        const items = target.map((g) => ({ g, r: shouldCraft(g) }));
        // 先做被允许的
        for (const { g, r } of items) {
            if (!r.ok) { stat.skip++; continue; }
            try {
                await craftOne(g);
                stat.ok++;
                const h = cache.history[g.appid] || { madeCount: 0 };
                h.madeCount = (Number.isFinite(h.madeCount) ? h.madeCount : 0) + 1;
                h.lastMade = today();
                cache.history[g.appid] = h;
                saveCache();
                g._craftDone = true; g._craftFail = false;
            } catch (e) {
                stat.fail++;
                g._craftFail = true; g._craftDone = false;
            }
        }
        // 汇总（跳过项给出原因）
        const skipReasons = new Map();
        items.filter((x) => !x.r.ok).forEach((x) => {
            skipReasons.set(x.r.reason, (skipReasons.get(x.r.reason) || 0) + 1);
        });
        const skipDesc = Array.from(skipReasons).map(([k, v]) => `${k}×${v}`).join('，');
        const msg = `制作完成：成功 ${stat.ok}，失败 ${stat.fail}，跳过 ${stat.skip}${skipDesc ? '（' + skipDesc + '）' : ''}`;
        if (stat.ok) { toast(msg, 4000); }
        else if (stat.skip) { toast('无新增制作：' + skipDesc, 4000); }
        else { toast(msg, 4000); }
        if (manualBtn) {
            setCraftBtn('一键制作', false);
        }
        render();
    }

    // --------------------------------------------------------------------------------
    // 自动作包引擎：盯「自动做包列表」，零请求轮询本地冷却时间
    // 到点 → 实时查价 → 利润闸门（"强制"绕过）→ 制作
    // 通知语义（按 tick 实际发生的制作批次）：
    //   成功 → tick 末尾汇总一条系统通知；没到 CD → 完全静默；
    //   宝石不足 → 通知一次并自动取消总开关（手动勾选恢复轮询）；可恢复失败 → 退避重试不通知，放弃后通知一次；两者 24 小时后自动恢复盯守
    // --------------------------------------------------------------------------------
    const BACKOFF_MIN = [5, 15, 30];   // 可恢复失败的退避阶梯（分钟）
    const RESUME_AFTER_H = 24;         // 放弃/宝石不足后自动恢复监控的间隔（小时）
    // TODO: 接入第三方通知渠道（如 Telegram / Server酱 / Bark），成功/失败/恢复事件推送到手机
    let autoTickRunning = false;

    function sysNotify(title, text) {
        try { GM_notification({ title: 'Steam 补充包助手', text: (title ? title + '\n' : '') + text, silent: false }); } catch (e) { /* 通知失败不影响主流程 */ }
        toast(title + ' ' + text, 6000);
    }

    // 记一次可恢复失败并安排退避；返回 true 表示已到上限放弃
    function scheduleRetry(appid, err) {
        const r = retryState[appid] || { attempts: 0 };
        r.attempts = (r.attempts || 0) + 1;
        r.reason = String(err && err.message || err).slice(0, 100);
        if (r.attempts > BACKOFF_MIN.length) {
            delete r.nextTry;
            r.givenUp = true;
            r.at = Date.now();   // 24 小时后自动恢复监控
            retryState[appid] = r;
            saveRetry();
            doneSession.add(appid);
            return true;
        }
        r.nextTry = Date.now() + BACKOFF_MIN[r.attempts - 1] * 60 * 1000;
        retryState[appid] = r;
        saveRetry();
        return false;
    }

    // 本 tick 可制作候选：在自动列表 ∩ 已到 CD ∩ 未处理完 ∩ 不在退避等待/放弃状态
    // 放弃/宝石不足的游戏超过 RESUME_AFTER_H 小时后自动恢复监控（无需人工移出重加）
    function autoCandidates() {
        return allGames.filter((g) => {
            const a = String(g.appid);
            if (lists.auto.indexOf(a) === -1) { return false; }
            const r = retryState[a];
            let forceTry = false;
            if (r && r.givenUp) {
                if (Date.now() - (r.at || 0) < RESUME_AFTER_H * 3600 * 1000) { return false; }
                dropRetryKey(a); doneSession.delete(a);
                g._craftFail = false;
            } else if (r && r.nextTry && Date.now() < r.nextTry) {
                return false;
            } else if (r && r.nextTry) {
                forceTry = true;   // 退避到期：绕过本地 CD 判定直接重试（实际仍在冷却会被 Steam 拒绝并再次记退避）
            }
            if (doneSession.has(a)) { return false; }
            return forceTry || isAvailable(g);
        });
    }

    // 对单个自动列表游戏执行一次「查价→判定→制作」，返回 {kind:'ok'|'skip'|'fail'|'gems', msg}
    const inFlightCraft = new Set();   // 正在执行 autoCraftOne 的 appid：防「加入即试做」与轮询/手动触发并发对同一游戏双做
    async function autoCraftOne(g) {
        const a = String(g.appid);
        if (inFlightCraft.has(a)) { return { kind: 'skip', msg: `${g.name} 制作流程进行中` }; }
        inFlightCraft.add(a);
        try {
            // 到点实时查价（每游戏 2+ 请求，只在制作时刻发生），保证利润闸门用最新数据
            await analyzeGame(g, true);
            if (cache.cardInfo[a] && cache.cardInfo[a].marketable === false) {
                doneSession.add(a);   // 不可交易（无在售）：非错误，会话内不再反复查
                return { kind: 'skip', msg: `${g.name} 不可交易（无在售）` };
            }
            const gate = shouldCraft(g);
            if (!gate.ok) {
                if (gate.reason === '无法计算利润') {
                    scheduleRetry(a, new Error('无法计算利润（查价失败）'));   // 查价失败可恢复 → 退避
                    return { kind: 'fail', msg: `${g.name} 查价失败退避中` };
                }
                doneSession.add(a);   // 利润不足是闸门判定，非错误
                return { kind: 'skip', msg: `${g.name} ${gate.reason}` };
            }
            await craftOne(g);
            const h = cache.history[a] || { madeCount: 0 };
            h.madeCount = (Number.isFinite(h.madeCount) ? h.madeCount : 0) + 1;
            h.lastMade = today();
            cache.history[a] = h;
            saveCache();
            g._craftDone = true; g._craftFail = false;
            doneSession.add(a);
            dropRetryKey(a);
            return { kind: 'ok', msg: g.name };
        } catch (e) {
            g._craftFail = true; g._craftDone = false;
            if (e.kind === 'gems') {
                // 无宝石：通知一次 + 自动取消总开关（只有手动勾选才恢复轮询）
                retryState[a] = { givenUp: true, reason: '宝石不足', at: Date.now() }; saveRetry();
                doneSession.add(a);
                config.autoPoll = false; saveConfig();
                render();
                sysNotify('自动做包失败', `${g.name} 宝石不足（${e.detail || '需 ' + g.price + ' 宝石/包'}）。自动做包已暂停，补宝石后请手动勾选恢复`);
                return { kind: 'gems', msg: `${g.name} 宝石不足` };
            }
            const gave = scheduleRetry(a, e);
            if (gave) {
                // 退避等待期间不通知；退避用尽（放弃）只通知这一次
                sysNotify('自动做包失败', `${g.name} 连续失败 ${BACKOFF_MIN.length + 1} 次（${String(e.message || e).slice(0, 80)}）。${RESUME_AFTER_H} 小时后自动恢复监控`);
            }
            return { kind: 'fail', msg: `${g.name} ${gave ? '失败放弃' : '失败（退避中）'}` };
        } finally {
            inFlightCraft.delete(a);
        }
    }

    // 单 tick 最多处理的游戏数：防长时间挂机后批量到点造成连续请求
    const MAX_BATCH = 5;

    // 一次轮询 tick：只处理到点候选；没候选直接返回（零请求、零通知）
    async function autoTick() {
        if (autoTickRunning) { return; }
        const cands = autoCandidates();
        if (!cands.length) { return; }
        autoTickRunning = true;
        const batch = cands.slice(0, MAX_BATCH);
        setStatus(`自动做包：${cands.length} 个游戏到点，开始处理${cands.length > MAX_BATCH ? `（本批 ${batch.length}，其余下轮）` : '…'}`);
        const res = { ok: [], skip: [] };
        let failHidden = 0;   // 退避中的失败不在通知里出现（终态失败已各自立即通知）
        let gemHalt = false;  // 宝石不足 → 熔断本 tick 剩余候选（已自动取消总开关）
        let doneMsg = '';
        try {
            for (const g of batch) {
                const r = await autoCraftOne(g);
                if (r.kind === 'ok') { res.ok.push(r.msg); }
                else if (r.kind === 'skip') { res.skip.push(r.msg); }
                else if (r.kind === 'gems') { gemHalt = true; failHidden++; break; }
                else { failHidden++; }
            }
            doneMsg = `自动做包：完成（成功 ${res.ok.length}，跳过 ${res.skip.length}，失败退避 ${failHidden}${gemHalt ? '，宝石不足已暂停' : ''}）`;
            // 汇总系统通知仅当本 tick 真的做成了包；纯跳过只页内提示
            if (res.ok.length) {
                const lines = ['✓ ' + res.ok.join('、')];
                if (res.skip.length) { lines.push('－ ' + res.skip.join('、')); }
                sysNotify(`自动做包：成功 ${res.ok.length} 个`, lines.join('\n'));
            } else if (res.skip.length) {
                toast('自动做包跳过：' + res.skip.join('、'), 5000);
            }
        } catch (e) {
            doneMsg = `自动做包：异常 ${String((e && e.message) || e).slice(0, 80)}`;
        } finally {
            autoTickRunning = false;
            render();            // 先重建面板，再写状态行（render 会清空 statusEl）
            setStatus(doneMsg);
        }
    }

    // 加入自动列表时的立即尝试（做包页有数据时）；失败按引擎规则处理
    function tryImmediateCraft(appid) {
        const g = allGames.find((x) => String(x.appid) === String(appid));
        if (!g) { return; }   // 商店页无游戏数据，交给做包页轮询盯守
        if (!isAvailable(g)) { toast(`${g.name} 冷却中，已交给轮询盯守`, 3000); return; }   // 冷却中不白烧查价/退避额度
        autoCraftOne(g).then((r) => {
            if (r.kind === 'fail') { toast(`自动做包：${r.msg}`, 4000); }
            render();
        });
    }

    function startAutoPoll() {
        const min = Math.max(1, Number(config.pollInterval_min) || 10);
        setInterval(() => { if (config.autoPoll) { autoTick(); } }, min * 60 * 1000);
    }

    // --------------------------------------------------------------------------------
    // 渲染控制条 + 表格
    // --------------------------------------------------------------------------------
    let currentList = 'all';
    let currentPage = 1;
    let pageSize = 10;
    let statusEl = null;
    let rowCache = {};   // appid -> { rev, cost, profit, booster } 单元格引用，用于增量刷新
    let recalcRunning = false;
    let queryBtnEl = null;

    function listGames() {
        let arr = allGames;
        const filter = currentList;
        if (filter === 'queue') { arr = arr.filter((g) => lists.queue.indexOf(String(g.appid)) > -1); }
        else if (filter === 'collect') { arr = arr.filter((g) => lists.collect.indexOf(String(g.appid)) > -1); }
        else if (filter === 'auto') { arr = arr.filter((g) => lists.auto.indexOf(String(g.appid)) > -1); }
        else if (filter === 'black') { arr = arr.filter((g) => lists.black.indexOf(String(g.appid)) > -1); }
        else if (filter === 'out') { arr = arr.filter((g) => lists.queue.indexOf(String(g.appid)) === -1 && lists.collect.indexOf(String(g.appid)) === -1 && lists.auto.indexOf(String(g.appid)) === -1 && lists.black.indexOf(String(g.appid)) === -1); }
        return arr;
    }

    function el(tag, attrs, text) {
        const e = document.createElement(tag);
        if (attrs) { Object.assign(e, attrs); if (attrs.style) { e.style.cssText = attrs.style; } }
        if (text) { e.textContent = text; }
        return e;
    }

    function statusOf(g) {
        // 制作结果用会话标记展示，不写入 available_at_time（保住真实冷却时间戳，退避重试依赖它）
        if (g._craftFail) { return '制作失败'; }
        if (g._craftDone) { return '已完成'; }
        if (g.available_at_time === '已完成' || g.available_at_time === '制作失败') { return g.available_at_time; }   // 旧版本写入的数据
        if (!isAvailable(g)) { return '冷却中'; }
        if (g.available_at_time === undefined || g.available_at_time === null || g.available_at_time === '') { return '可制作'; }
        return String(g.available_at_time);
    }

    function render() {
        if (!gameSelectorArea) { return; }
        const root = document.getElementById('sbt_root');
        if (!root) { return; }
        root.innerHTML = '';

        // 加载状态兜底（若未就绪则给提示）
        if (!allGames.length) {
            root.appendChild(el('div', { style: 'padding:12px;color:#8f98a0;' }, '正在读取补充包数据…'));
            return;
        }

        // ----- 控制条 -----
        // Steam 原生按钮样式（页面已加载对应 CSS，实测可用）：主操作=蓝色，次操作=深灰
        const steamBtn = (text, secondary) => {
            const b = document.createElement('button');
            b.className = secondary ? 'btnv6_grey_black btn_medium' : 'btnv6_blue_blue_innerfade btn_medium';
            const span = document.createElement('span');
            span.textContent = text;
            b.appendChild(span);
            return b;
        };
        // 控件组：label + 控件 + 后缀 绑定为整体，换行时不会拆散（修复"10.0 / %"被拆行）
        const grp = (label, ctrlEl, suffix) => {
            const g = el('span', { style: 'display:inline-flex;align-items:center;white-space:nowrap;color:#8f98a0;font-size:12px;' });
            if (label) { g.appendChild(el('span', {}, label)); }
            if (ctrlEl) { ctrlEl.style.marginLeft = '4px'; g.appendChild(ctrlEl); }
            if (suffix) { const s = el('span', {}, suffix); s.style.marginLeft = '2px'; g.appendChild(s); }
            return g;
        };
        // 分组面板：带标题的圆角卡片，控件按用途分区显示
        const section = (title) => {
            const box = el('div', { style: 'border:1px solid rgba(255,255,255,0.08);background:rgba(0,0,0,0.18);border-radius:5px;padding:8px 12px 7px;margin-bottom:8px;' });
            box.appendChild(el('div', { style: 'color:#8f98a0;font-size:11px;letter-spacing:2px;margin-bottom:6px;' }, title));
            return box;
        };
        const row = (children) => {
            const r = el('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;column-gap:18px;row-gap:7px;' });
            children.forEach((c) => r.appendChild(c));
            return r;
        };

        // ① 制作：手动按钮 + 状态行
        const qLen = allGames.filter((g) => lists.queue.indexOf(String(g.appid)) > -1).filter((g) => isAvailable(g)).length;
        const craftBtn = steamBtn(`一键制作（队列可做 ${qLen}）`, false);
        craftBtn.id = 'sbt_craft_btn';
        craftBtn.addEventListener('click', () => { runCraft(); });
        // 自动列表手动触发：无视总开关，立即按引擎规则跑一轮
        const aLen = autoCandidates().length;
        const autoCraftBtn = steamBtn(`制作自动列表（可做 ${aLen}）`, true);
        autoCraftBtn.addEventListener('click', () => { autoTick(); });
        const secCraft = section('制 作');
        secCraft.appendChild(row([craftBtn, autoCraftBtn]));
        // 进度/状态行（供串行查询反馈，避免"看起来卡死"）
        statusEl = el('div', { id: 'sbt_status', style: 'color:#67c1f5;font-size:12px;margin-top:5px;' }, '');
        secCraft.appendChild(statusEl);
        root.appendChild(secCraft);

        // ② 自动作包：总开关 + 轮询间隔
        const autoWrap = el('label', { style: 'display:inline-flex;align-items:center;white-space:nowrap;color:#c6d4df;font-size:12px;cursor:pointer;font-weight:600;' });
        const autoChk = el('input', { type: 'checkbox', checked: config.autoPoll });
        // 红字提示仅在失败时显示：宝石不足 → 提示需手动勾选恢复；放弃 → 提示 24 小时自动恢复
        const gemsStopped = Object.keys(retryState).some((k) => retryState[k] && retryState[k].givenUp && retryState[k].reason === '宝石不足' && lists.auto.indexOf(k) !== -1);
        const gaveUpNames = Object.keys(retryState)
            .filter((k) => retryState[k] && retryState[k].givenUp && retryState[k].reason !== '宝石不足' && lists.auto.indexOf(k) !== -1)
            .map((k) => { const gg = allGames.find((x) => String(x.appid) === String(k)); return gg ? gg.name : ('appid ' + k); });
        const autoWarn = el('span', { style: 'color:#e05c5c;font-size:11px;font-weight:600;display:' + (config.autoPoll ? 'none' : '') + ';' },
            gemsStopped ? '无宝石，自动做包已暂停：补宝石后手动勾选恢复' : '已停用自动做包：到冷却点不会自动制作');
        autoChk.addEventListener('change', () => {
            config.autoPoll = autoChk.checked; saveConfig();
            autoWarn.textContent = '已停用自动做包：到冷却点不会自动制作';
            autoWarn.style.display = autoChk.checked ? 'none' : '';
            if (config.autoPoll) {
                // 手动勾选恢复：立即解除宝石不足游戏的暂停（兑现"补宝石后手动勾选恢复"承诺，不等 24h）
                Object.keys(retryState).forEach((k) => {
                    if (retryState[k] && retryState[k].givenUp && retryState[k].reason === '宝石不足') {
                        dropRetryKey(k); doneSession.delete(k);
                    }
                });
                autoTick();   // 打开开关立即检查一次已到点的
            }
        });
        autoWrap.appendChild(autoChk);
        autoWrap.appendChild(el('span', { style: 'margin-left:4px;' }, '开启自动做包'));
        const pollItv = el('input', { type: 'number', min: 1, value: config.pollInterval_min, style: 'width:40px;' });
        pollItv.addEventListener('change', () => {
            const v = parseInt(pollItv.value, 10);
            if (!Number.isNaN(v) && v >= 1) { config.pollInterval_min = v; saveConfig(); }
        });
        const secAuto = section('自动做包');
        secAuto.appendChild(row([
            autoWrap,
            grp('轮询间隔', pollItv, '分钟'),
            autoWarn,
            el('span', { style: 'color:#8f98a0;font-size:11px;' }, '盯「自动做包」列表，到冷却点自动制作（需保持本页打开）')
        ]));
        if (gemsStopped && !config.autoPoll) {
            secAuto.appendChild(el('div', { style: 'color:#e05c5c;font-size:11px;margin-top:5px;' },
                '※宝石不足已自动取消勾选，只有手动重新勾选才会恢复自动做包'));
        } else if (gaveUpNames.length) {
            secAuto.appendChild(el('div', { style: 'color:#e05c5c;font-size:11px;margin-top:5px;' },
                `※${gaveUpNames.join('、')} 制作失败已放弃，24 小时后自动恢复监控`));
        }
        root.appendChild(secAuto);

        // ③ 价格与利润
        const thr = el('input', { type: 'number', min: 0, max: 100, step: 0.5, value: (config.profitThreshold * 100).toFixed(1), style: 'width:48px;' });
        thr.addEventListener('change', () => {
            const v = parseFloat(thr.value);
            if (!Number.isNaN(v)) { config.profitThreshold = v / 100; saveConfig(); }
        });
        const src = el('select', {});
        [{ v: 'market', t: '市场' }, { v: 'custom', t: '自定义' }].forEach((o) => {
            src.appendChild(el('option', { value: o.v, selected: config.gemPriceSource === o.v }, o.t));
        });
        const custom = el('input', { type: 'number', step: 0.01, value: (config.customGemPrice / 100).toFixed(2), style: 'width:56px;' });
        const customGrp = grp('自定义价', custom);
        customGrp.style.display = config.gemPriceSource === 'custom' ? '' : 'none';
        custom.addEventListener('change', () => {
            const v = parseFloat(custom.value);
            if (!Number.isNaN(v)) { config.customGemPrice = Math.round(v * 100); saveConfig(); recalcAll(true); }
        });
        src.addEventListener('change', () => { config.gemPriceSource = src.value; saveConfig(); customGrp.style.display = config.gemPriceSource === 'custom' ? '' : 'none'; recalcAll(true); });
        const secPrice = section('价格与利润');
        secPrice.appendChild(row([
            grp('一袋宝石(市场)', null, marketGemPrice ? fmtNum(marketGemPrice) : '…'),
            grp('利润阈值 ≥', thr, '%'),
            grp('宝石价', src),
            customGrp,
            el('span', { style: 'color:#8f98a0;font-size:11px;' }, '队列/自动列表里勾选"强制"可绕过利润阈值')
        ]));
        root.appendChild(secPrice);

        // ④ 列表与查询
        const itv = el('input', { type: 'number', min: 300, value: config.reqInterval, style: 'width:60px;' });
        itv.addEventListener('change', () => {
            const v = parseInt(itv.value, 10);
            if (!Number.isNaN(v) && v >= 300) { config.reqInterval = v; saveConfig(); }
        });
        const listSel = el('select', {});
        [{ v: 'all', t: '全部' }, { v: 'queue', t: '队列' }, { v: 'auto', t: '自动做包' }, { v: 'collect', t: '收藏' }, { v: 'out', t: '未分类' }, { v: 'black', t: '黑名单' }].forEach((o) => {
            listSel.appendChild(el('option', { value: o.v, selected: currentList === o.v }, o.t));
        });
        listSel.addEventListener('change', () => { currentList = listSel.value; currentPage = 1; render(); });
        // 一键拉黑（次操作，Steam 原生灰按钮）
        const blackBtn = steamBtn('一键拉黑未分类', true);
        blackBtn.addEventListener('click', oneKeyBlack);
        // 查询当前列表（主操作，Steam 原生蓝按钮；点击 = 全部缓存立即失效，实时重查）
        const queryBtn = steamBtn(recalcRunning ? '查询中…' : '查询当前列表', false);
        queryBtn.id = 'sbt_query_btn';
        queryBtn.disabled = recalcRunning;
        queryBtn.addEventListener('click', async () => {
            // 点击查询 = 全部缓存立即失效（含宝石价），实时查询
            try { marketGemPrice = await loadGemPrice(true); } catch (e) { console.error('[sbt] 刷新宝石价失败', (e && e.message) || e); }
            recalcAll(true);
        });
        queryBtnEl = queryBtn;
        const secList = section('列表与查询');
        secList.appendChild(row([
            grp('展示列表', listSel),
            grp('请求间隔', itv, 'ms'),
            blackBtn,
            queryBtn
        ]));
        root.appendChild(secList);

        // ----- 表格 -----
        const arr = listGames();
        const totalPages = Math.max(1, Math.ceil(arr.length / pageSize));
        if (currentPage > totalPages) { currentPage = totalPages; }
        const start = (currentPage - 1) * pageSize;
        const page = arr.slice(start, start + pageSize);

        const table = el('table', { style: 'width:100%;border-collapse:collapse;font-size:13px;' });
        const headRow = el('tr');
        ['游戏', '名称', '状态', '宝石', '成本', '卡牌3张税后', '补充包卖价', '利润', '制作量', '上次', '强制', '操作'].forEach((t) => {
            headRow.appendChild(el('th', { style: 'border-bottom:1px solid #333;padding:6px;color:#8f98a0;text-align:left;' }, t));
        });
        table.appendChild(headRow);
        rowCache = {};

        for (const g of page) {
            const st = state[g.appid] || {};
            const tr = el('tr');

            // 游戏缩略图：点击 = 该游戏全部社区物品（卡牌/背景/补充包/表情等）
            const imgTd = el('td', { style: 'padding:4px;' });
            const a = el('a', { href: `https://steamcommunity.com/market/search?appid=753&category_Game=app_${g.appid}`, target: '_blank' });
            const img = el('img', { src: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/capsule_sm_120.jpg`, style: 'height:34px;width:60px;object-fit:cover;' });
            a.appendChild(img); imgTd.appendChild(a); tr.appendChild(imgTd);

            // 名称：游戏名整体为一个链接，同时筛出该游戏 普卡+补充包（同 facet 多值为 OR）
            const nameTd = el('td', { style: 'padding:4px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' });
            const nameLink = el('a', {
                href: 'https://steamcommunity.com/market/search?category_item_class=item_class_2&category_item_class=item_class_5'
                    + '&category_cardborder=cardborder_0&category_Game=app_' + g.appid + '&appid=753',
                target: '_blank', style: 'color:#8f98a0;', title: '查看该游戏的 普卡+补充包 市场'
            });
            nameLink.textContent = g.name;
            nameTd.appendChild(nameLink);
            tr.appendChild(nameTd);

            // 状态
            const statusTd = el('td', { style: 'padding:4px;' }, statusOf(g));
            if (statusOf(g) === '可制作') { statusTd.style.color = '#a4d007'; }
            else if (statusOf(g) === '冷却中') { statusTd.style.color = '#8f98a0'; }
            tr.appendChild(statusTd);

            // 所需宝石（=g.price），旁注卡牌数
            const gemsTd = el('td', { style: 'padding:4px;' }, `${g.price}(${GEMS_TO_CARDCOUNT[g.price] != null ? GEMS_TO_CARDCOUNT[g.price] : '?'})`);
            tr.appendChild(gemsTd);

            // 成本
            const cost = costPerBooster(g.price);
            const costTd = el('td', { style: 'padding:4px;' }, cost !== null ? fmtNum(cost) : '…');
            tr.appendChild(costTd);

            // 卡牌3张税后
            const rev = getRevenue(g.appid);
            const cardTd = el('td', { style: 'padding:4px;color:' + (rev !== null && cost !== null && rev > cost ? '#e44' : '#fff') + ';' }, rev !== null ? fmtNum(rev) : (st.querying ? '…' : '未查'));
            tr.appendChild(cardTd);

            // 补充包卖价（税后到账）
            let boosterNet = null;
            if (st.booster && Number.isFinite(st.booster.lowestSell)) { boosterNet = sellerNet(st.booster.lowestSell); }
            const bTd = el('td', { style: 'padding:4px;' }, boosterNet !== null ? fmtNum(boosterNet) : (st.querying ? '…' : '未查'));
            tr.appendChild(bTd);

            // 利润
            let rate = null;
            if (cost !== null && cost > 0 && rev !== null) { rate = (rev - cost) / cost; }
            const pTd = el('td', { style: 'padding:4px;color:' + (rate !== null && rate > 0 ? '#e44' : '#8f98a0') + ';' },
                rate !== null ? (rate * 100).toFixed(1) + '%' : '…');
            tr.appendChild(pTd);

            rowCache[String(g.appid)] = { rev: cardTd, cost: costTd, profit: pTd, booster: bTd };

            // 制作量 / 上次
            const h = cache.history[g.appid] || {};
            tr.appendChild(el('td', { style: 'padding:4px;' }, String(h.madeCount || 0)));
            tr.appendChild(el('td', { style: 'padding:4px;color:#8f98a0;' }, h.lastMade || '—'));

            // 强制制作勾选
            const aKey = String(g.appid);
            const forceTd = el('td', { style: 'padding:4px;text-align:center;' });
            const forceChk = el('input', { type: 'checkbox', checked: !!config.forceList[aKey] });
            forceChk.addEventListener('change', () => {
                if (forceChk.checked) { config.forceList[aKey] = 1; } else { delete config.forceList[aKey]; }
                saveConfig();
            });
            forceTd.appendChild(forceChk);
            tr.appendChild(forceTd);

            // 操作按钮
            const opTd = el('td', { style: 'padding:4px;white-space:nowrap;' });
            const mkBtn = (text, color, fn) => {
                const b = el('button', { style: 'margin-right:4px;background:' + (color || '#1a2332') + ';color:#fff;border:none;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:12px;' }, text);
                b.addEventListener('click', fn);
                return b;
            };
            const inQueue = lists.queue.indexOf(aKey) > -1;
            const inCollect = lists.collect.indexOf(aKey) > -1;
            const inAuto = lists.auto.indexOf(aKey) > -1;
            const inBlack = lists.black.indexOf(aKey) > -1;
            if (inAuto) {
                opTd.appendChild(mkBtn('移出', '#a80', () => operate(g.appid, 'autoToOut')));
                opTd.appendChild(mkBtn('队列', '#285c28', () => operate(g.appid, 'autoToQueue')));
                opTd.appendChild(mkBtn('收藏', '#3a3', () => operate(g.appid, 'autoToCollect')));
            } else if (inQueue) {
                opTd.appendChild(mkBtn('自动', '#c60', () => operate(g.appid, 'queueToAuto')));
                opTd.appendChild(mkBtn('收藏', '#3a3', () => operate(g.appid, 'queueToCollect')));
                opTd.appendChild(mkBtn('移出', '#a80', () => operate(g.appid, 'queueToOut')));
            } else if (inCollect) {
                opTd.appendChild(mkBtn('自动', '#c60', () => operate(g.appid, 'collectToAuto')));
                opTd.appendChild(mkBtn('队列', '#285c28', () => operate(g.appid, 'collectToQueue')));
                opTd.appendChild(mkBtn('移出', '#a80', () => operate(g.appid, 'collectToOut')));
            } else if (inBlack) {
                opTd.appendChild(mkBtn('自动', '#c60', () => operate(g.appid, 'blackToAuto')));
                opTd.appendChild(mkBtn('移出', '#444', () => operate(g.appid, 'blackToOut')));
            } else {
                opTd.appendChild(mkBtn('自动', '#c60', () => operate(g.appid, 'outToAuto')));
                opTd.appendChild(mkBtn('队列', '#285c28', () => operate(g.appid, 'outToQueue')));
                opTd.appendChild(mkBtn('收藏', '#3a3', () => operate(g.appid, 'outToCollect')));
                opTd.appendChild(mkBtn('拉黑', '#333', () => operate(g.appid, 'outToBlack')));
            }
            opTd.appendChild(mkBtn('重置缓存', '#650', () => operate(g.appid, 'reset')));
            tr.appendChild(opTd);

            table.appendChild(tr);
        }
        root.appendChild(table);

        // 分页（Steam 原生灰按钮）
        const pag = el('div', { style: 'margin-top:8px;display:flex;align-items:center;column-gap:8px;' });
        const prev = steamBtn('上一页', true);
        const next = steamBtn('下一页', true);
        prev.disabled = currentPage <= 1;
        next.disabled = currentPage >= totalPages;
        if (prev.disabled) { prev.classList.add('btn_disabled'); }
        if (next.disabled) { next.classList.add('btn_disabled'); }
        prev.addEventListener('click', () => { currentPage--; render(); });
        next.addEventListener('click', () => { currentPage++; render(); });
        pag.appendChild(prev);
        pag.appendChild(el('span', { style: 'color:#8f98a0;' }, `第 ${currentPage}/${totalPages} 页，共 ${arr.length} 个游戏`));
        pag.appendChild(next);
        root.appendChild(pag);
    }

    // --------------------------------------------------------------------------------
    // 查询当前列表内所有游戏的价格（串行，逐个，防风控）
    // --------------------------------------------------------------------------------
    async function recalcAll(force) {
        if (recalcRunning) { return; }   // 防止重复点击叠加多轮查询
        recalcRunning = true;
        if (queryBtnEl) {
            queryBtnEl.disabled = true;
            const sp = queryBtnEl.querySelector('span');
            if (sp) { sp.textContent = '查询中…'; } else { queryBtnEl.textContent = '查询中…'; }
        }
        const targets = listGames();
        const total = targets.length;
        const okStart = Date.now();
        if (!total) { setStatus('当前列表为空'); }
        for (let i = 0; i < total; i++) {
            const g = targets[i];
            setStatus(`查询 ${i + 1}/${total}：${g.name}`);
            await analyzeGame(g, force);
            const st = state[String(g.appid)];
            updateRow(g); // 每游戏查询完即增量刷新该行，避免"点了没反应"
            if (st && st.err) { console.error('[sbt] 查询失败', g.name, st.err); }
        }
        setStatus(`查询完成（${targets.length} 个游戏，${countValued()} 个可算利润，耗时 ${((Date.now() - okStart) / 1000).toFixed(0)}s）`);
        recalcRunning = false;
        render();
    }

    // 已有净利润可展示的游戏数（粗略统计用于查询完成提示）
    function countValued() {
        let n = 0;
        listGames().forEach((g) => { if (getRevenue(g.appid) !== null) { n++; } });
        return n;
    }

    // 增量更新某行已插回的单元格（成本/卡牌税后/补充包/利润）
    function updateRow(g) {
        const cells = rowCache[String(g.appid)];
        const st = state[String(g.appid)] || {};
        if (!cells) { return; }
        const cost = costPerBooster(g.price);
        const rev = getRevenue(g.appid);
        if (cost !== null) { cells.cost.textContent = fmtNum(cost); }
        if (rev !== null) {
            cells.rev.textContent = fmtNum(rev);
            cells.rev.style.color = cost !== null && rev > cost ? '#e44' : '#fff';
        } else if (!st.querying) {
            cells.rev.textContent = st.err ? '失败' : '未查';
            cells.rev.title = st.err || '';
        }
        // 补充包
        let bnet = null;
        if (st.booster && Number.isFinite(st.booster.lowestSell)) { bnet = sellerNet(st.booster.lowestSell); }
        if (bnet !== null) {
            cells.booster.textContent = fmtNum(bnet);
        } else if (!st.querying) {
            cells.booster.textContent = '未查';
        }
        // 利润
        let rate = null;
        if (cost !== null && cost > 0 && rev !== null) { rate = (rev - cost) / cost; }
        if (rate !== null) {
            cells.profit.textContent = (rate * 100).toFixed(1) + '%';
            cells.profit.style.color = rate > 0 ? '#e44' : '#8f98a0';
        } else if (!st.querying) {
            cells.profit.textContent = '…';
        }
    }

    function setStatus(msg) {
        if (statusEl) { statusEl.textContent = msg; }
    }

    // 分析单个游戏：普通卡 + 补充包各一次搜索（独立缓存，卡牌数 >10 时自动翻页），串行防风控
    async function analyzeGame(g, force) {
        const a = String(g.appid);
        const st = (state[a] = state[a] || {});
        if (st.querying) { return; }
        st.querying = true;
        st.err = null;
        try {
            const ttl = config.priceCacheTTL_min * 60 * 1000;
            const now = Date.now();

            // ---- 普通卡（逐卡单独计税后再平均：手续费按笔非线性计算，先平均再算税会失真）----
            const unit = cache.cardInfo[a] || (cache.cardInfo[a] = {});
            const cardFresh = !force && unit.cardAvgNet !== undefined && unit.orgAt && (now - unit.orgAt < ttl);
            if (!cardFresh) {
                const m = await fetchGameCards(a);
                unit.cardCount = m.total;
                if (m.priced.length) {
                    unit.cardAvgNet = Math.round(m.priced.reduce((s, c) => s + sellerNet(c.sellPrice), 0) / m.priced.length);
                    unit.cardAvgPrice = Math.round(m.priced.reduce((s, c) => s + c.sellPrice, 0) / m.priced.length); // 原始均价仅参考
                    unit.marketable = true;
                } else {
                    // 一张在售的都没有：不可交易（新卡未开放交易/空卡池都是这个表现）
                    unit.cardAvgNet = null;
                    unit.cardAvgPrice = null;
                    unit.marketable = false;
                }
                unit.orgAt = now;
                saveCache();
            }
            st.netPerCard = unit.cardAvgNet != null ? unit.cardAvgNet : null;
            st.cardCount = unit.cardCount;

            // ---- 补充包（最低卖价税后）----
            const boInfo = cache.boosterInfo[a];
            const boFresh = !force && boInfo && boInfo.orgAt && (now - boInfo.orgAt < ttl);
            if (!boFresh) {
                const b = await fetchGameBooster(a);
                cache.boosterInfo[a] = b
                    ? { lowestSell: b.sellPrice, volume: b.listings, hash: b.hashName, orgAt: now }
                    : { lowestSell: null, volume: 0, hash: null, orgAt: now };
                saveCache();
            }
            st.booster = (cache.boosterInfo[a] && cache.boosterInfo[a].lowestSell != null) ? cache.boosterInfo[a] : null;
        } catch (e) {
            st.err = String(e && e.message || e);
        } finally {
            st.querying = false;
        }
    }

    // --------------------------------------------------------------------------------
    // 商店页（store.steampowered.com/app/<id>）：复用同一套分析管线，在左栏顶部注入利润条
    // --------------------------------------------------------------------------------
    function storeAppName() {
        const t = document.querySelector('.apphub_AppName');
        if (t && t.textContent) { return t.textContent.trim(); }
        const m = (document.title || '').replace(/\s*::.*$/, '').match(/^(.*?)(?:\s*on Steam|\s*在 Steam 上)?$/);
        return m && m[1] ? m[1].trim() : '';
    }

    function initStorePage() {
        const m = location.pathname.match(/\/app\/(\d+)/);
        if (!m) { return; }
        const anchor = document.querySelector('.leftcol.game_description_column');
        if (!anchor) { setTimeout(initStorePage, 1500); return; }
        const appid = String(parseInt(m[1], 10));
        const name = storeAppName();
        if (document.getElementById('sbt_store_panel')) { return; }

        const panel = el('div', {
            id: 'sbt_store_panel',
            style: 'background:rgba(0,0,0,.2);border:1px solid rgba(255,255,255,.1);border-radius:4px;'
                + 'padding:10px 14px;margin-bottom:14px;font-size:13px;line-height:1.8;color:#c6d4df;'
        });
        panel.appendChild(el('div', { style: 'font-weight:600;color:#fff;margin-bottom:2px;' }, 'Steam 补充包制作助手'));
        const body = el('div', null, '查询中…');
        panel.appendChild(body);
        anchor.insertBefore(panel, anchor.firstChild);

        const done = (gemErr) => {
            const unit = cache.cardInfo[appid] || {};
            const bInfo = cache.boosterInfo[appid];
            const st = state[appid] || {};
            const gems = CARDCOUNT_TO_GEMS[unit.cardCount] || null;
            const cost = gems ? costPerBooster(gems) : null;
            const rev = Number.isFinite(unit.cardAvgNet) ? unit.cardAvgNet * 3 : null;
            const bnet = bInfo && bInfo.lowestSell != null ? sellerNet(bInfo.lowestSell) : null;
            const rate = (cost !== null && cost > 0 && rev !== null) ? (rev - cost) / cost : null;

            body.textContent = '';
            const mkVal = (txt, color, title) => {
                const s = el('span', null, txt);
                if (color) { s.style.color = color; }
                if (title) { s.title = title; }
                return s;
            };
            const addRow = (label, val) => {
                const r = el('div');
                r.appendChild(el('span', { style: 'color:#8f98a0;display:inline-block;width:110px;' }, label));
                r.appendChild(val);
                body.appendChild(r);
            };
            const errTip = st.err || '';
            addRow('卡牌', mkVal(unit.marketable === false ? '不可交易（无在售）' : ((unit.cardCount || '?') + ' 张'), '', errTip));
            addRow('3卡税后收入', mkVal(
                rev !== null ? fmtNum(rev) : (errTip ? '失败' : (unit.marketable === false ? '-' : '未查')),
                rev !== null && cost !== null && rev > cost ? '#e44' : '', errTip
            ));
            addRow('做包成本', mkVal(
                cost !== null ? fmtNum(cost) + '（' + gems + ' 宝石 × ' + fmtNum(effectiveGemPrice()) + '/袋）' : (gemErr ? '宝石价失败' : '-'),
                '', gemErr ? String(gemErr.message || gemErr) : ''
            ));
            addRow('补充包卖价(税后)', mkVal(bnet !== null ? fmtNum(bnet) : (bInfo ? '无在售' : '未查')));
            addRow('利润率', mkVal(rate !== null ? (rate * 100).toFixed(1) + '%' : '-',
                rate !== null && rate > 0 ? '#e44' : '#8f98a0'));

            // 链接（与主站查询同源）
            const links = el('div', { style: 'margin-top:4px;display:flex;gap:14px;flex-wrap:wrap;' });
            const mkLink = (txt, href) => {
                const a = el('a', { href, target: '_blank', style: 'color:#66c0f4;' }, txt);
                links.appendChild(a);
            };
            mkLink('卡牌市场', 'https://steamcommunity.com/market/search?category_cardborder=cardborder_0&category_Game=app_' + appid + '&appid=753');
            mkLink('补充包市场', 'https://steamcommunity.com/market/search?category_item_class=item_class_5&category_Game=app_' + appid + '&appid=753');
            mkLink('去做包', 'https://steamcommunity.com/tradingcards/boostercreator/');
            body.appendChild(links);

            // 列表操作（与做包页共用同一份 lists 存储）
            const actions = el('div', { style: 'margin-top:6px;' });
            const mkBtn = (span, onClick) => {
                const a = el('a', { style: 'margin-right:8px;' });
                a.className = 'btnv6_grey_black btn_medium';
                a.appendChild(span);
                a.addEventListener('click', onClick);
                return a;
            };
            const qSpan = el('span', null, '加入队列');
            const aSpan = el('span', null, '加入自动做包');
            const bSpan = el('span', null, '拉黑');
            const listState = () => {
                if (lists.queue.indexOf(appid) > -1) { return 'queue'; }
                if (lists.auto.indexOf(appid) > -1) { return 'auto'; }
                if (lists.black.indexOf(appid) > -1) { return 'black'; }
                return null;
            };
            const refresh = () => {
                const s = listState();
                qSpan.textContent = s === 'queue' ? '已在队列' : '加入队列';
                aSpan.textContent = s === 'auto' ? '已在自动列表' : '加入自动做包';
                bSpan.textContent = s === 'black' ? '已拉黑' : '拉黑';
            };
            actions.appendChild(mkBtn(qSpan, () => {
                if (listState() === 'queue') { return; }
                if (listState() === 'black') { operate(appid, 'blackToOut'); }
                if (listState() === 'auto') { operate(appid, 'autoToOut'); }
                operate(appid, 'outToQueue'); saveLists(); refresh(); toast('已加入做包队列');
            }));
            actions.appendChild(mkBtn(aSpan, () => {
                if (listState() === 'auto') { return; }
                if (listState() === 'black') { operate(appid, 'blackToOut'); }
                if (listState() === 'queue') { operate(appid, 'queueToOut'); }
                operate(appid, 'outToAuto'); saveLists(); refresh(); toast('已加入自动做包列表（到点自动制作，需做包页保持打开）');
            }));
            actions.appendChild(mkBtn(bSpan, () => {
                if (listState() === 'black') { return; }
                if (listState() === 'queue') { operate(appid, 'queueToOut'); }
                if (listState() === 'auto') { operate(appid, 'autoToOut'); }
                operate(appid, 'outToBlack'); saveLists(); refresh(); toast('已加入黑名单');
            }));
            refresh();
            body.appendChild(actions);
        };

        let gemErr = null;
        loadGemPrice(false).then((p) => { marketGemPrice = p; return p; }).catch((e) => { gemErr = e; return null; })
            .then(() => analyzeGame({ appid, name }, false))
            .then(() => done(gemErr))
            .catch((e) => {
                body.textContent = '';
                body.appendChild(el('span', { style: 'color:#e44;' }, '查询失败: ' + String(e && e.message || e)));
            });
    }

    // --------------------------------------------------------------------------------
    // 初始化
    // --------------------------------------------------------------------------------
    function init() {
        loadState();
        if (location.hostname === 'store.steampowered.com') { initStorePage(); return; }
        if (!initDom()) { console.warn('[sbt] 未找到补充包制作区'); return; }
        allGames = loadBoosterData();
        if (!allGames.length) {
            // 页面数据可能异步加载，稍后重试
            setTimeout(init, 1500);
            return;
        }
        // 注入根容器：插在制作表单之后、「或者为最近收集的卡牌…」推荐区之前（避免面板沉到页面底部）
        let anchor = null;
        const hint = Array.from(boosterPage.querySelectorAll('*')).find((n) => n.childElementCount === 0 && /或者为最近收集的卡牌/.test(n.textContent || ''));
        if (hint) {
            anchor = hint;
            while (anchor.parentElement && anchor.parentElement !== boosterPage) { anchor = anchor.parentElement; }
        }
        const root = el('div', { id: 'sbt_root', style: 'margin-top:10px;' });
        if (anchor && anchor.parentElement === boosterPage) { boosterPage.insertBefore(root, anchor); }
        else { boosterPage.insertAdjacentElement('afterend', root); }

        render();

        // 先取宝石价格（决定成本；30 分钟缓存，页面打开不产生多余请求）
        loadGemPrice(false).then((p) => {
            marketGemPrice = p;
            console.info('[sbt] 宝石价(1/100)=' + p);
        }).catch((e) => {
            // 失败回退缓存价：避免利润闸门全部"无法计算利润"引发级联退避
            const gp = cache.gemPrice;
            if (gp && gp.price != null) { marketGemPrice = gp.price; console.warn('[sbt] 宝石价获取失败，回退缓存价', (e && e.message) || e); }
            else { console.error('[sbt] 获取宝石价格失败', (e && e.message) || e); toast('获取宝石价格失败: ' + ((e && e.message) || ''), 6000); }
        }).then(() => {
            render();   // 宝石价就绪（或已回退缓存价）后刷新展示
            // 宝石价就绪后再启动自动做包：首次先补一轮已到点的，之后按间隔轮询
            if (config.autoPoll) { autoTick(); }
            startAutoPoll();
        });

        // 不再自动查询：价格仅在手动点「查询当前列表」时获取（缓存 30 分钟）
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // 页面对象可能在 DOMContentLoaded 后才有，稍作延迟
        setTimeout(init, 300);
    }
})();