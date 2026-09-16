// ==UserScript==
// @name         Steam 补充包工具箱
// @namespace    toolbox.steam-booster-tool
// @version      0.2.4
// @description  按利润筛选补充包，支持拉黑/收藏/做包队列，队列游戏每日自动做包。价格全部走市场搜索接口（普通卡 cardborder_0 / 补充包 item_class_5，精确分值），每游戏 2 个请求；逐卡单独计税后取平均，手续费按卖家到手价精确反解（2025-12 新规最低手续费）；无自动查询，点「查询当前列表」全量实时重查。
// @author       toolbox
// @match        https://steamcommunity.com/tradingcards/boostercreator*
// @match        https://steamcommunity.com/tradingcards/boostercreator/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
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

    const DEFAULT_CONFIG = {
        autoCreate: false,          // 进页面自动做包
        profitThreshold: 0.10,      // 利润阈值（默认 10%）
        gemPriceSource: 'market',   // 'market' | 'custom'
        customGemPrice: 270,        // 自定义一袋宝石价（分，按钱包币种）
        reqInterval: 250,           // 请求间隔 ms（防风控）
        maxRetries: 3,              // 单请求失败/限流重试次数
        priceCacheTTL_min: 30,      // 价格缓存有效期（分钟）：卡牌/补充包/宝石价统一 30 分钟
        forceList: {}               // 逐游戏强制制作 {appid: 1}
    };

    let config;
    let lists;    // { queue:[], collect:[], black:[] } 元素为 appid 字符串
    let cache;    // { cardInfo, boosterInfo, history }

    function loadState() {
        const c = GM_getValue(KEY_CONFIG, null);
        config = Object.assign({}, DEFAULT_CONFIG, c || {});
        if (!config.forceList) { config.forceList = {}; }
        lists = GM_getValue(KEY_LISTS, { queue: [], collect: [], black: [] });
        lists.queue = lists.queue || [];
        lists.collect = lists.collect || [];
        lists.black = lists.black || [];
        cache = GM_getValue(KEY_CACHE, null);
        if (!cache) {
            cache = { cardInfo: {}, boosterInfo: {}, history: {} };
        }
        cache.cardInfo = cache.cardInfo || {};
        cache.boosterInfo = cache.boosterInfo || {};
        cache.history = cache.history || {};
        cache.gemPrice = cache.gemPrice || {};
    }
    function saveConfig() { GM_setValue(KEY_CONFIG, config); }
    function saveLists() { GM_setValue(KEY_LISTS, lists); }
    function saveCache() { GM_setValue(KEY_CACHE, cache); }

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
        if (sel) { sel.style.display = 'none'; } // 隐藏原生下拉
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
        switch (type) {
            case 'outToQueue': if (lists.queue.indexOf(a) === -1) { lists.queue.push(a); } break;
            case 'outToCollect': if (lists.collect.indexOf(a) === -1) { lists.collect.push(a); } break;
            case 'outToBlack': if (lists.black.indexOf(a) === -1) { lists.black.push(a); } break;
            case 'collectToQueue': arrRemove(lists.collect, a); if (lists.queue.indexOf(a) === -1) { lists.queue.push(a); } break;
            case 'collectToOut': arrRemove(lists.collect, a); break;
            case 'queueToCollect': arrRemove(lists.queue, a); if (lists.collect.indexOf(a) === -1) { lists.collect.push(a); } break;
            case 'queueToOut': arrRemove(lists.queue, a); break;
            case 'blackToOut': arrRemove(lists.black, a); break;
            case 'reset': cache.cardInfo[a] = undefined; saveCache(); break;
            default: return;
        }
        if (type !== 'reset') { saveLists(); }
        render();
    }

    function oneKeyBlack() {
        let added = 0;
        allGames.forEach((g) => {
            const a = String(g.appid);
            const inQueue = lists.queue.indexOf(a) > -1;
            const inCollect = lists.collect.indexOf(a) > -1;
            const inBlack = lists.black.indexOf(a) > -1;
            if (!inQueue && !inCollect && !inBlack) { lists.black.push(a); added++; }
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
        const res = await request('POST', url, {
            data: body,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Referer': 'https://steamcommunity.com/tradingcards/boostercreator/',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': 'https://steamcommunity.com'
            }
        });
        // 非 200 或触及限流/失败页 → 抛错，供调用方计入失败
        if (!res || res.status >= 400) { throw new Error('HTTP ' + (res && res.status)); }
        // 成功响应带 purchaseid；Steam 也可能 200 + 错误 JSON（如冷却中/宝石不足），一并视为失败
        const j = safeJSON(res.responseText);
        if (!j || !j.purchaseid) {
            throw new Error('响应异常: ' + describeRes(res));
        }
    }

    async function runCraft(scope) {
        // scope: 'manual' | 'auto'
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
                h.madeCount = (Number.isNaN(h.madeCount) ? 0 : h.madeCount) + 1;
                h.lastMade = today();
                cache.history[g.appid] = h;
                saveCache();
                g.available_at_time = '已完成';
            } catch (e) {
                stat.fail++;
                g.available_at_time = '制作失败';
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
        else if (filter === 'black') { arr = arr.filter((g) => lists.black.indexOf(String(g.appid)) > -1); }
        else if (filter === 'out') { arr = arr.filter((g) => lists.queue.indexOf(String(g.appid)) === -1 && lists.collect.indexOf(String(g.appid)) === -1 && lists.black.indexOf(String(g.appid)) === -1); }
        return arr;
    }

    function el(tag, attrs, text) {
        const e = document.createElement(tag);
        if (attrs) { Object.assign(e, attrs); if (attrs.style) { e.style.cssText = attrs.style; } }
        if (text) { e.textContent = text; }
        return e;
    }

    function statusOf(g) {
        if (g.available_at_time === '已完成' || g.available_at_time === '制作失败') { return g.available_at_time; }
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
        const ctrl = el('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;column-gap:14px;row-gap:8px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.15);margin-bottom:8px;' });
        ctrl.appendChild(grp(`一袋宝石(市场)：${marketGemPrice ? fmtNum(marketGemPrice) : '…'}`, null));

        // 自动作包开关
        const autoWrap = el('label', { style: 'display:inline-flex;align-items:center;white-space:nowrap;color:#8f98a0;font-size:12px;cursor:pointer;' });
        const autoChk = el('input', { type: 'checkbox', checked: config.autoCreate });
        autoChk.addEventListener('change', () => { config.autoCreate = autoChk.checked; saveConfig(); });
        autoWrap.appendChild(autoChk);
        autoWrap.appendChild(el('span', { style: 'margin-left:4px;' }, '自动做包'));
        ctrl.appendChild(autoWrap);

        // 利润阈值
        const thr = el('input', { type: 'number', min: 0, max: 100, step: 0.5, value: (config.profitThreshold * 100).toFixed(1), style: 'width:48px;' });
        thr.addEventListener('change', () => {
            const v = parseFloat(thr.value);
            if (!Number.isNaN(v)) { config.profitThreshold = v / 100; saveConfig(); }
        });
        ctrl.appendChild(grp('利润≥', thr, '%'));

        // 宝石价来源
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
        ctrl.appendChild(grp('宝石价:', src));
        ctrl.appendChild(customGrp);

        // 请求间隔
        const itv = el('input', { type: 'number', min: 300, value: config.reqInterval, style: 'width:60px;' });
        itv.addEventListener('change', () => {
            const v = parseInt(itv.value, 10);
            if (!Number.isNaN(v) && v >= 300) { config.reqInterval = v; saveConfig(); }
        });
        ctrl.appendChild(grp('间隔ms:', itv));

        // 展示范围
        const listSel = el('select', {});
        [{ v: 'all', t: '全部' }, { v: 'queue', t: '队列' }, { v: 'collect', t: '收藏' }, { v: 'out', t: '未分类' }, { v: 'black', t: '黑名单' }].forEach((o) => {
            listSel.appendChild(el('option', { value: o.v, selected: currentList === o.v }, o.t));
        });
        listSel.addEventListener('change', () => { currentList = listSel.value; currentPage = 1; render(); });
        ctrl.appendChild(grp('列表:', listSel));

        // 一键拉黑（次操作，Steam 原生灰按钮）
        const blackBtn = steamBtn('一键拉黑未分类', true);
        blackBtn.addEventListener('click', oneKeyBlack);
        ctrl.appendChild(blackBtn);

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
        ctrl.appendChild(queryBtn);

        root.appendChild(ctrl);
        root.appendChild(el('div', { style: 'color:#8f98a0;font-size:11px;margin:2px 0 4px;' }, '※队列里勾选"强制"可绕过利润阈值'));

        // ----- 一键做包按钮（仅在"全部"或"队列"时展示常见按钮） -----
        const qLen = allGames.filter((g) => lists.queue.indexOf(String(g.appid)) > -1).filter((g) => isAvailable(g)).length;
        const craftBtn = steamBtn(`一键制作（队列可做 ${qLen}）`, false);
        craftBtn.id = 'sbt_craft_btn';
        craftBtn.style.margin = '8px 0 0';
        craftBtn.addEventListener('click', () => { runCraft('manual'); });
        const ctrl2 = el('div', { style: 'margin:6px 0;' });
        ctrl2.appendChild(craftBtn);
        // 进度/状态行（供串行查询反馈，避免"看起来卡死"）
        statusEl = el('div', { id: 'sbt_status', style: 'color:#67c1f5;font-size:12px;margin:4px 0;' }, '');
        ctrl2.appendChild(statusEl);
        root.appendChild(ctrl2);

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

            // 游戏缩略图
            const imgTd = el('td', { style: 'padding:4px;' });
            const a = el('a', { href: `https://steamcommunity.com/market/search?q=${encodeURIComponent(g.name)}`, target: '_blank' });
            const img = el('img', { src: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/capsule_sm_120.jpg`, style: 'height:34px;width:60px;object-fit:cover;' });
            a.appendChild(img); imgTd.appendChild(a); tr.appendChild(imgTd);

            // 名称
            const nameTd = el('td', { style: 'padding:4px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8f98a0;' }, g.name);
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
            const inBlack = lists.black.indexOf(aKey) > -1;
            if (inQueue) {
                opTd.appendChild(mkBtn('收藏', '#3a3', () => operate(g.appid, 'queueToCollect')));
                opTd.appendChild(mkBtn('移出', '#a80', () => operate(g.appid, 'queueToOut')));
            } else if (inCollect) {
                opTd.appendChild(mkBtn('队列', '#285c28', () => operate(g.appid, 'collectToQueue')));
                opTd.appendChild(mkBtn('移出', '#a80', () => operate(g.appid, 'collectToOut')));
            } else if (inBlack) {
                opTd.appendChild(mkBtn('移出', '#444', () => operate(g.appid, 'blackToOut')));
            } else {
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
        if (config.autoCreate && !autoDone) {
            autoDone = true;
            await runCraft('auto');
        }
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

    let autoDone = false;

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
    // 初始化
    // --------------------------------------------------------------------------------
    function init() {
        if (!initDom()) { console.warn('[sbt] 未找到补充包制作区'); return; }
        loadState();
        allGames = loadBoosterData();
        if (!allGames.length) {
            // 页面数据可能异步加载，稍后重试
            setTimeout(init, 1500);
            return;
        }
        // 注入根容器
        const root = el('div', { id: 'sbt_root' });
        gameSelectorArea.appendChild(root);

        render();

        // 先取宝石价格（决定成本；30 分钟缓存，页面打开不产生多余请求）
        loadGemPrice(false).then((p) => {
            marketGemPrice = p;
            console.info('[sbt] 宝石价(1/100)=' + p);
            render();
        }).catch((e) => {
            console.error('[sbt] 获取宝石价格失败', (e && e.message) || e);
            toast('获取宝石价格失败: ' + ((e && e.message) || ''), 6000);
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