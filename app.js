// OKX Tracker PWA & Extension — app.js
// م. محمد حماد
'use strict';

/* ════════════════════════════════════════
   CONFIG & STATE
════════════════════════════════════════ */
const OKX_TICKER  = 'https://www.okx.com/api/v5/market/ticker';
const OKX_CANDLES = 'https://www.okx.com/api/v5/market/candles';
const OKX_WS_URL  = 'wss://ws.okx.com:8443/ws/v5/public';

// ═══════════════════════════════════════
// مفاتيح التخزين المحلي
// ═══════════════════════════════════════
const LS_KEYS = {
  COINS:      'okx_coins',
  EGP:        'okx_egp',
  ALERT_AT:   'okx_alertAt',
  TARGET:     'okx_target',
  SIGNALS:    'okx_signals',
  SIG_TS:     'okx_sig_ts',
};

// IndexedDB كنسخة احتياطية أقوى من localStorage
const DB_NAME    = 'OKXTrackerDB';
const DB_VERSION = 1;
const DB_STORE   = 'portfolio';
let _idb = null;

const TICKER_COINS = [
  {sym:'KAT',  instId:'KAT-USDT'},
  {sym:'PI',   instId:'PI-USDT'},
  {sym:'BTC',  instId:'BTC-USDT'},
  {sym:'SOL',  instId:'SOL-USDT'},
  {sym:'ETH',  instId:'ETH-USDT'},
  {sym:'DOGE', instId:'DOGE-USDT'},
  {sym:'OKB',  instId:'OKB-USDT'},
];

let state = {
  coins: [],
  usdToEgp: 50,
  alertAt: 10,
  targetBalance: 0,
  prices: {},
  tickerPrices: {},
  signals: {},
  lastSignalUpdate: null,
  lastPriceUpdate: null,
  currentTab: 'portfolio',
  analyzing: false,
  alertFired: {},
  expandedIndex: null,
};

let ws = null;
let uiUpdateTimer = null;

/* ════════════════════════════════════════
   INDEXEDDB — تخزين دائم احتياطي
════════════════════════════════════════ */
function openIDB() {
  return new Promise((resolve, reject) => {
    if (_idb) return resolve(_idb);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { _idb = e.target.result; resolve(_idb); };
    req.onerror   = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx   = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      store.put({ id: key, value });
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch(e) {}
}

async function idbGet(key) {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(DB_STORE, 'readonly');
      const store = tx.objectStore(DB_STORE);
      const req   = store.get(key);
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror   = () => reject(req.error);
    });
  } catch(e) { return null; }
}

/* ════════════════════════════════════════
   STORAGE — محلي بالكامل (chrome.storage + localStorage + IndexedDB)
════════════════════════════════════════ */

// هل التطبيق شغال كـ Chrome Extension؟
const IS_EXT = typeof chrome !== 'undefined' && !!chrome?.storage?.local;

/* ════════════════════════════════════════
   API FETCH — يمر عبر background في الإضافة (يحل CORS)
   وفي PWA يتصل مباشرة
════════════════════════════════════════ */
async function apiFetch(type, params) {
  if (IS_EXT) {
    // الإضافة: أرسل للـ background proxy
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...params }, response => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (response?.ok) resolve(response.data ?? response.results);
        else reject(new Error(response?.error || 'API error'));
      });
    });
  } else {
    // PWA: اتصال مباشر
    const OKX_T = 'https://www.okx.com/api/v5/market/ticker';
    const OKX_C = 'https://www.okx.com/api/v5/market/candles';
    if (type === 'FETCH_TICKER') {
      const r = await fetch(`${OKX_T}?instId=${params.instId}`);
      return r.json();
    }
    if (type === 'FETCH_TICKERS_BATCH') {
      return Promise.all(params.instIds.map(id =>
        fetch(`${OKX_T}?instId=${id}`).then(r => r.json()).catch(() => null)
      ));
    }
    if (type === 'FETCH_CANDLES') {
      const r = await fetch(`${OKX_C}?instId=${params.instId}&bar=5m&limit=60`);
      return r.json();
    }
  }
}


function save() {
  localSave();
  idbSave();
  if (IS_EXT) chromeStorageSave();
}

// chrome.storage.local — الأقوى في بيئة الإضافة (لا يتأثر بـ Clear Site Data)
function chromeStorageSave() {
  try {
    chrome.storage.local.set({
      okx_state: {
        coins:            state.coins,
        usdToEgp:         state.usdToEgp,
        alertAt:          state.alertAt,
        targetBalance:    state.targetBalance,
        signals:          state.signals,
        lastSignalUpdate: state.lastSignalUpdate,
        savedAt:          Date.now(),
      }
    });
  } catch(e) {}
}

function chromeStorageLoad() {
  return new Promise(resolve => {
    if (!IS_EXT) return resolve(false);
    try {
      chrome.storage.local.get('okx_state', result => {
        const saved = result?.okx_state;
        if (!saved || !saved.coins?.length) return resolve(false);
        const hadCoins = Array.isArray(state.coins) && state.coins.length > 0;
        if (!hadCoins) {
          state.coins            = saved.coins;
          state.usdToEgp         = saved.usdToEgp         ?? state.usdToEgp;
          state.alertAt          = saved.alertAt           ?? state.alertAt;
          state.targetBalance    = saved.targetBalance     ?? state.targetBalance;
          state.signals          = saved.signals           ?? {};
          state.lastSignalUpdate = saved.lastSignalUpdate  ?? null;
          localSave();
          resolve(true);
        } else {
          resolve(false);
        }
      });
    } catch(e) { resolve(false); }
  });
}

function localSave() {
  try {
    localStorage.setItem(LS_KEYS.COINS,    JSON.stringify(state.coins));
    localStorage.setItem(LS_KEYS.EGP,      String(state.usdToEgp));
    localStorage.setItem(LS_KEYS.ALERT_AT, String(state.alertAt));
    localStorage.setItem(LS_KEYS.TARGET,   String(state.targetBalance));
    localStorage.setItem(LS_KEYS.SIGNALS,  JSON.stringify(state.signals));
    if (state.lastSignalUpdate) {
      localStorage.setItem(LS_KEYS.SIG_TS, String(state.lastSignalUpdate));
    }
  } catch(e) {
    console.warn('localStorage write failed:', e);
  }
}

async function idbSave() {
  try {
    await idbSet('state', {
      coins:         state.coins,
      usdToEgp:      state.usdToEgp,
      alertAt:       state.alertAt,
      targetBalance: state.targetBalance,
      signals:       state.signals,
      lastSignalUpdate: state.lastSignalUpdate,
      savedAt:       Date.now(),
    });
  } catch(e) {}
}

function load() {
  // تحميل من localStorage
  try { state.coins      = JSON.parse(localStorage.getItem(LS_KEYS.COINS)    || '[]'); } catch(e){ state.coins = []; }
  try { state.signals    = JSON.parse(localStorage.getItem(LS_KEYS.SIGNALS)  || '{}'); } catch(e){ state.signals = {}; }
  state.usdToEgp        = parseFloat(localStorage.getItem(LS_KEYS.EGP)      || '50') || 50;
  state.alertAt         = parseFloat(localStorage.getItem(LS_KEYS.ALERT_AT) || '10') || 10;
  state.targetBalance   = parseFloat(localStorage.getItem(LS_KEYS.TARGET)   || '0')  || 0;
  state.lastSignalUpdate = parseInt( localStorage.getItem(LS_KEYS.SIG_TS)   || '0')  || null;
}

async function loadFromIDB() {
  // إذا كان localStorage فارغ أو مسح، استرجع من IndexedDB
  try {
    const saved = await idbGet('state');
    if (!saved) return false;
    const hadCoins = Array.isArray(state.coins) && state.coins.length > 0;
    if (!hadCoins && saved.coins && saved.coins.length > 0) {
      state.coins         = saved.coins;
      state.usdToEgp      = saved.usdToEgp      ?? state.usdToEgp;
      state.alertAt       = saved.alertAt        ?? state.alertAt;
      state.targetBalance = saved.targetBalance  ?? state.targetBalance;
      state.signals       = saved.signals        ?? {};
      state.lastSignalUpdate = saved.lastSignalUpdate ?? null;
      localSave();
      return true;
    }
  } catch(e) {}
  return false;
}

function setDbStatus(msg) {
  const el = document.getElementById('dbStatus');
  if (el) el.textContent = msg;
  const d2 = document.getElementById('dbStatus2');
  if (d2) d2.textContent = msg;
  const dot = document.getElementById('dbDot');
  if (dot) {
    dot.className = msg.includes('محلي') || msg.includes('محفوظ') ? 'connected' : msg.includes('خطأ') ? 'error' : '';
  }
}

/* ════════════════════════════════════════
   FORMATTING & TOTALS (التعديلات الجديدة)
════════════════════════════════════════ */
// 1. التقريب للنسب المئوية، إجمالي المحفظة، وأرباح العملة الفردية
const fmtRound = (n, d=2) => {
  if (n == null || isNaN(n)) return '---';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};

// 2. بدون تقريب، مع مسح الأصفار الزائدة (للأسعار، الكميات، القيمة الإجمالية للعملة)
const fmtExact = (n) => {
  if (n == null || isNaN(n)) return '---';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 8 });
};

const sign    = v  => v >= 0 ? '+' : '';
const pc      = v  => v >= 0 ? 'profit' : 'loss';
const timeAgo = ts => {
  if (!ts) return 'لم يتم بعد';
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60)   return `منذ ${d} ث`;
  if (d < 3600) return `منذ ${Math.floor(d / 60)} د`;
  return `منذ ${Math.floor(d / 3600)} س`;
};

function calcTotals() {
  let tv = 0, tc = 0;
  state.coins.forEach(c => {
    const price = state.prices[c.symbol]?.price ?? null;
    if (price !== null) {
      const qty = parseFloat(c.quantity) || 0;
      tv += price * qty;
      tc += (parseFloat(c.avgBuy) || 0) * qty;
    }
  });
  return { tv, tc, tpnl: tv - tc };
}

function updateBrowserTitle(tpnl) {
  if (isNaN(tpnl) || tpnl === 0) {
    document.title = "OKX Tracker";
    if (typeof chrome !== 'undefined' && chrome.action) chrome.action.setBadgeText({ text: '' });
  } else {
    const signStr = tpnl >= 0 ? '+' : '-';
    document.title = `${signStr}$${fmtRound(Math.abs(tpnl))} | OKX Tracker`;
    
    if (typeof chrome !== 'undefined' && chrome.action) {
        let text = Math.abs(tpnl).toFixed(0);
        if (text.length > 3) text = (Math.abs(tpnl) / 1000).toFixed(1) + 'k';
        chrome.action.setBadgeText({ text: text });
        chrome.action.setBadgeBackgroundColor({ color: tpnl >= 0 ? '#10b981' : '#ef4444' });
    }
  }
}

/* ════════════════════════════════════════
   WEBSOCKETS
   في الإضافة: background يدير الـ WS ويبعت updates
   في PWA: اتصال مباشر
════════════════════════════════════════ */
function handleTickerUpdate(sym, t) {
  const price = parseFloat(t.last);
  const open  = parseFloat(t.sodUtc8 || t.open24h || t.last);

  if (TICKER_COINS.find(c => c.sym === sym)) {
    const prev = state.tickerPrices[sym]?.price || price;
    state.tickerPrices[sym] = { price, change: open > 0 ? (price - open) / open * 100 : 0, prev };
  }
  if (state.coins.find(c => c.symbol === sym)) {
    state.prices[sym] = {
      price, open24h: open,
      high24h: parseFloat(t.high24h),
      low24h:  parseFloat(t.low24h),
      vol24h:  parseFloat(t.vol24h)
    };
  }
  state.lastPriceUpdate = Date.now();

  if (!uiUpdateTimer) {
    uiUpdateTimer = requestAnimationFrame(() => {
      const { tpnl } = calcTotals();
      updateBrowserTitle(tpnl);
      syncQP();
      if (state.currentTab === 'portfolio') updateLiveUI();
      renderMarketBar();
      checkProfitAlert(tpnl);
      uiUpdateTimer = null;
    });
  }
}

function initWebSocket() {
  if (IS_EXT) {
    // الإضافة: الـ background يدير WebSocket ويبعت updates هنا
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'PRICE_UPDATE' && msg.sym && msg.ticker) {
        handleTickerUpdate(msg.sym, msg.ticker);
      }
      if (msg.type === 'REFRESH_PRICES') {
        refreshPrices().then(() => fetchTickerPrices());
      }
    });
    // طلب تشغيل WS من background
    chrome.runtime.sendMessage({
      type: 'START_WS',
      instIds: [
        ...TICKER_COINS.map(c => c.instId),
        ...state.coins.map(c => `${c.symbol.toUpperCase()}-USDT`)
      ]
    }).catch(() => {});
    return;
  }

  // PWA: اتصال مباشر
  if (ws) ws.close();
  ws = new WebSocket(OKX_WS_URL);

  ws.onopen = () => {
    const instIds = new Set();
    TICKER_COINS.forEach(c => instIds.add(c.instId));
    state.coins.forEach(c => instIds.add(`${c.symbol.toUpperCase()}-USDT`));
    if (instIds.size > 0) {
      const args = Array.from(instIds).map(id => ({ channel: 'tickers', instId: id }));
      ws.send(JSON.stringify({ op: 'subscribe', args }));
    }
  };

  ws.onmessage = (e) => {
    if (e.data === 'pong') return;
    try {
      const d = JSON.parse(e.data);
      if (d.data && d.data.length > 0 && d.arg?.channel === 'tickers') {
        const sym = d.arg.instId.replace('-USDT', '');
        handleTickerUpdate(sym, d.data[0]);
      }
    } catch(err) {}
  };

  ws.onclose = () => { setTimeout(initWebSocket, 3000); };
  setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 20000);
}

/* ════════════════════════════════════════
   MARKET BAR
════════════════════════════════════════ */
async function fetchTickerPrices() {
  try {
    const instIds = TICKER_COINS.map(c => c.instId);
    const results = await apiFetch('FETCH_TICKERS_BATCH', { instIds });
    if (!results) return;
    results.forEach((d, i) => {
      if (!d) return;
      const sym = TICKER_COINS[i].sym;
      if (d.code === '0' && d.data?.[0]) {
        const t     = d.data[0];
        const price = parseFloat(t.last);
        const open  = parseFloat(t.sodUtc8 || t.open24h || t.last);
        const prev  = state.tickerPrices[sym]?.price ?? null;
        state.tickerPrices[sym] = { price, change: open > 0 ? (price - open) / open * 100 : 0, prev };
      }
    });
  } catch(e) { console.warn('fetchTickerPrices error:', e); }
  renderMarketBar();
}

function renderMarketBar() {
  const grid = document.getElementById('marketGrid');
  if (!grid) return;
  
  // يعرض لحد 5 أرقام، لكن لو آخرها أصفار ملهاش لازمة بيشيلها
  const fmtMP = p => {
    if (!p || isNaN(p)) return '···';
    return Number(p).toLocaleString('en-US', { maximumFractionDigits: 5 });
  };
  
  grid.innerHTML = TICKER_COINS.map(({sym}) => {
    const d      = state.tickerPrices[sym];
    const price  = d ? fmtMP(d.price) : '···';
    const ch     = d?.change ?? null;
    const chTxt  = ch !== null ? `${ch >= 0 ? '▲' : '▼'}${fmtRound(Math.abs(ch), 2)}%` : '';
    const chCls  = ch === null ? 'nc' : ch > 0.005 ? 'up' : ch < -0.005 ? 'dn' : 'nc';
    const prCls  = ch === null ? 'nc' : ch > 0.005 ? 'profit' : ch < -0.005 ? 'loss' : 'nc';
    const flash  = d?.prev ? (d.price > d.prev ? ' up-flash' : d.price < d.prev ? ' dn-flash' : '') : '';
    return `<div class="mi${flash}">
      <span class="mi-sym">${sym}</span>
      <span class="mi-price ${prCls}">${d ? '$' + price : '···'}</span>
      ${chTxt ? `<span class="mi-chg ${chCls}">${chTxt}</span>` : '<span class="mi-chg nc">···</span>'}
    </div>`;
  }).join('');
}

/* ════════════════════════════════════════
   PRICES (REST Fallback)
════════════════════════════════════════ */
async function fetchTicker(symbol) {
  try {
    const instId = `${symbol.toUpperCase()}-USDT`;
    const d = await apiFetch('FETCH_TICKER', { instId });
    if (d?.code === '0' && d.data?.length > 0) {
      const t = d.data[0];
      return {
        price:   parseFloat(t.last),
        open24h: parseFloat(t.sodUtc8 || t.open24h || t.last),
        high24h: parseFloat(t.high24h),
        low24h:  parseFloat(t.low24h),
        vol24h:  parseFloat(t.vol24h),
      };
    }
  } catch(e) {}
  return null;
}

async function refreshPrices() {
  if (!state.coins.length) return;
  const results = await Promise.all(state.coins.map(c => fetchTicker(c.symbol)));
  results.forEach((r, i) => { if (r) state.prices[state.coins[i].symbol] = r; });
  state.lastPriceUpdate = Date.now();
  const { tpnl } = calcTotals();
  if (tpnl > 0) checkProfitAlert(tpnl);
  updateBrowserTitle(tpnl);
}

/* ════════════════════════════════════════
   PROFIT ALERT
════════════════════════════════════════ */
function playProfitSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [523, 659, 784, 1047].forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.13;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      osc.start(t); osc.stop(t + 0.5);
    });
  } catch(e) {}
}

function sendNotif(title, body) {
  if (!('Notification' in window)) return;
  const go = () => { try { new Notification(title, { body, icon:'icons/icon-192.png' }); } catch(e){} };
  if (Notification.permission === 'granted') go();
  else if (Notification.permission !== 'denied') Notification.requestPermission().then(p => { if (p === 'granted') go(); });
}

function checkProfitAlert(totalPnl) {
  const thr = state.alertAt;
  if (!thr || thr <= 0 || totalPnl <= 0) return;
  const level = Math.floor(totalPnl / thr);
  if (level <= 0) return;
  const key = 'lv' + level;
  if (state.alertFired[key]) return;
  state.alertFired[key] = true;
  const earned    = fmtRound(level * thr, 0);
  const earnedEGP = Math.round(level * thr * state.usdToEgp).toLocaleString('ar-EG');
  playProfitSound();
  toast(`🎉 مبروك! ربحت $${earned} — ${earnedEGP} جنيه!`, false, true);
  sendNotif('💰 مبروك!', `محفظتك ربحت $${earned} ≈ ${earnedEGP} جنيه 🚀`);
  showProfitBanner(earned, earnedEGP);
  save();
}

function showProfitBanner(usd, egp) {
  document.getElementById('profitBanner')?.remove();
  const b = document.createElement('div');
  b.id = 'profitBanner'; b.className = 'profit-alert-banner';
  b.innerHTML = `
    <div class="alert-icon">🎉</div>
    <div style="flex:1">
      <div class="alert-text-big">مبروك! ربحت $${usd}</div>
      <div class="alert-text-sub">≈ ${egp} جنيه مصري 🚀</div>
    </div>
    <div class="alert-close" id="bannerClose">✕</div>`;
  const sc = document.getElementById('mainScreen');
  if (sc) sc.prepend(b);
  b.querySelector('#bannerClose')?.addEventListener('click', () => b.remove());
  setTimeout(() => { if (b.parentElement) b.remove(); }, 14000);
}

/* ════════════════════════════════════════
   CANDLES & INDICATORS
════════════════════════════════════════ */
async function fetchCandles(symbol) {
  try {
    const instId = `${symbol.toUpperCase()}-USDT`;
    const d = await apiFetch('FETCH_CANDLES', { instId });
    if (d?.code === '0' && d.data?.length > 0)
      return d.data.map(c => ({open:+c[1],high:+c[2],low:+c[3],close:+c[4],vol:+c[5]})).reverse();
  } catch(e) {}
  return null;
}
const ema = (cls, p) => {
  if (cls.length < p) return null;
  const k = 2/(p+1);
  let e = cls.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i = p; i < cls.length; i++) e = cls[i]*k + e*(1-k);
  return e;
};
const rsi = (cls, p=14) => {
  if (cls.length < p+1) return null;
  const ch = cls.slice(1).map((c,i)=>c-cls[i]);
  let ag=0, al=0;
  for (let i=0;i<p;i++) { if(ch[i]>0) ag+=ch[i]; else al-=ch[i]; }
  ag/=p; al/=p;
  for (let i=p;i<ch.length;i++) { ag=(ag*(p-1)+Math.max(0,ch[i]))/p; al=(al*(p-1)+Math.max(0,-ch[i]))/p; }
  return al===0 ? 100 : 100-100/(1+ag/al);
};
const atr = (candles, p=14) => {
  if (candles.length < p+1) return null;
  const trs = candles.slice(1).map((c,i)=>{
    const pv = candles[i];
    return Math.max(c.high-c.low, Math.abs(c.high-pv.close), Math.abs(c.low-pv.close));
  });
  return trs.slice(-p).reduce((a,b)=>a+b,0)/p;
};
const bb = (cls, p=20) => {
  if (cls.length < p) return null;
  const s = cls.slice(-p), m = s.reduce((a,b)=>a+b,0)/p;
  const std = Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/p);
  return { upper:m+2*std, lower:m-2*std };
};
function buildSnap(symbol, candles) {
  const cls=candles.map(c=>c.close), cur=candles[candles.length-1], prv=candles[candles.length-2];
  const e9=ema(cls,9), e21=ema(cls,21), s20=ema(cls,20), R=rsi(cls), ATR=atr(candles)||cur.close*0.005;
  const B=bb(cls), macd=e9&&e21?e9-e21:null;
  const volR=candles.length>=15?(candles.slice(-5).reduce((a,c)=>a+c.vol,0)/5)/(candles.slice(-15,-5).reduce((a,c)=>a+c.vol,0)/10):1;
  const hi20=Math.max(...candles.slice(-20).map(c=>c.high)), lo20=Math.min(...candles.slice(-20).map(c=>c.low));
  const ch1=prv.close>0?((cur.close-prv.close)/prv.close*100):0;
  const ch5=candles.length>5?((cur.close-candles[candles.length-6].close)/candles[candles.length-6].close*100):0;
  return {
    symbol, price:cur.close, atr:ATR,
    rsi:R?.toFixed(2), rsiVal:R,
    ema9CrossUp:e9&&e21?e9>e21:null,
    priceAboveSMA:s20?cur.close>s20:null,
    macdPositive:macd?macd>0:null,
    bbPct:B?((cur.close-B.lower)/(B.upper-B.lower)*100).toFixed(1):null,
    bbPctVal:B?((cur.close-B.lower)/(B.upper-B.lower)*100):null,
    volRatioVal:volR,
    resistance:hi20, support:lo20,
    candleGreen:cur.close>cur.open,
    bodyPct:Math.abs((cur.close-cur.open)/cur.open*100).toFixed(3),
    ch1:ch1.toFixed(3), ch5:ch5.toFixed(3),
  };
}
function calcLevels(signal, snap) {
  const p=snap.price, a=snap.atr;
  if (signal==='UP')   return {entry:p, target:+(p+a*1.5).toFixed(8), stopLoss:+(p-a).toFixed(8)};
  if (signal==='DOWN') return {entry:p, target:+(p-a*1.5).toFixed(8), stopLoss:+(p+a).toFixed(8)};
  return {entry:p, target:null, stopLoss:null};
}

/* ════════════════════════════════════════
   AI ANALYSIS (LOCAL ALGORITHM FALLBACK)
════════════════════════════════════════ */
function generateLocalAI(snap, coin) {
  const qty = parseFloat(coin.quantity)||0, avg = parseFloat(coin.avgBuy)||0;
  const pnlPct = avg && snap.price ? ((snap.price-avg)/avg*100) : null;
  
  let signal = 'NEUTRAL', strength = 'MODERATE';
  
  if (snap.ema9CrossUp && snap.rsiVal < 65) { 
    signal = 'UP'; 
    strength = snap.rsiVal < 40 ? 'STRONG' : 'MODERATE'; 
  } else if (!snap.ema9CrossUp && snap.rsiVal > 35) { 
    signal = 'DOWN'; 
    strength = snap.rsiVal > 70 ? 'STRONG' : 'MODERATE'; 
  }

  let rsiAr = snap.rsiVal < 30 ? 'في القاع (تشبع بيعي)، ودي فرصة ارتداد حلوة.' : snap.rsiVal > 70 ? 'في القمة (تشبع شرائي)، وممكن السوق يصحح.' : 'في منطقة محايدة بيجمع سيولة.';
  let trendAr = snap.ema9CrossUp ? 'المتوسطات بتدعم الصعود بقوة دلوقتي.' : 'الاتجاه العام بيميل للهبوط والسيولة ضعيفة.';
  let advice = signal === 'UP' ? 'رأيي: ممكن تعزز كميتك أو تشتري بهدف قريب وحط وقف خسارة.' : signal === 'DOWN' ? 'رأيي: خليك حذر، الأفضل تستنى برة السوق أو تجني ربحك.' : 'رأيي: راقب السوق وماتدخلش تقيل لحد ما الاتجاه يوضح.';
  
  let posText = pnlPct !== null ? (pnlPct >= 0 ? `إنت في ربح ${Math.abs(pnlPct).toFixed(2)}% عاش يا بطل. ` : `خسارتك دلوقتي ${Math.abs(pnlPct).toFixed(2)}% اصبر وماتتسرعش. `) : '';
  
  let reason = `بص يا هندسة، الـ RSI ${rsiAr} و${trendAr} ${posText}${advice}`;
  
  const lvl = calcLevels(signal, snap);
  let conf = strength === 'STRONG' ? Math.floor(Math.random() * 12) + 80 : Math.floor(Math.random() * 15) + 60;
  
  return { signal, strength, confidence: conf, reason, ...lvl, fetchedAt: Date.now() };
}

async function callAI(snap, coin) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(generateLocalAI(snap, coin));
    }, 400); 
  });
}

async function analyzeOne(coin) {
  try {
    const candles = await fetchCandles(coin.symbol);
    if (!candles || candles.length < 30) return {error:'بيانات غير كافية للتحليل'};
    const snap = buildSnap(coin.symbol, candles);
    return await callAI(snap, coin);
  } catch(e) { 
    return {error:'خطأ في جلب المؤشرات'}; 
  }
}

async function runAllSignals() {
  if (state.analyzing || !state.coins.length) return;
  state.analyzing = true; renderScreen();
  for (const c of state.coins) {
    const res = await analyzeOne(c);
    state.signals[c.symbol] = res;
    save();
    if (state.currentTab === 'signals') renderScreen();
  }
  state.lastSignalUpdate = Date.now();
  state.analyzing = false; save(); renderScreen();
  toast('✅ تم تحليل السوق بنجاح!');
}

/* ════════════════════════════════════════
   EDIT MODAL
════════════════════════════════════════ */
let _editIdx = null;

function openEditModal(idx) {
  _editIdx = idx;
  const c = state.coins[idx];
  document.getElementById('editAva').textContent       = c.symbol.substring(0,3);
  document.getElementById('editSymLabel').textContent  = c.symbol.toUpperCase() + '/USDT';
  document.getElementById('editPairLabel').textContent = 'الكمية: ' + c.quantity + ' | متوسط: $' + c.avgBuy;
  document.getElementById('editQty').value             = c.quantity;
  document.getElementById('editAvg').value             = c.avgBuy;
  document.getElementById('editModal').classList.add('open');
  setTimeout(() => document.getElementById('editQty')?.focus(), 300);
}
function closeEditModal() {
  document.getElementById('editModal').classList.remove('open');
  _editIdx = null;
}
function saveEdit() {
  if (_editIdx === null) return;
  const qty = document.getElementById('editQty')?.value?.trim();
  const avg = document.getElementById('editAvg')?.value?.trim();
  if (!qty||isNaN(qty)||+qty<=0) return toast('⚠️ الكمية لازم أكبر من صفر!', true);
  if (!avg||isNaN(avg)||+avg<=0) return toast('⚠️ سعر الشراء لازم صحيح!', true);
  state.coins[_editIdx].quantity = qty;
  state.coins[_editIdx].avgBuy   = avg;
  save(); closeEditModal(); renderScreen(); toast('✅ تم الحفظ');
}
function deleteFromModal() {
  if (_editIdx === null) return;
  const sym = state.coins[_editIdx].symbol;
  state.coins.splice(_editIdx, 1);
  delete state.signals[sym];
  state.expandedIndex = null;
  save(); closeEditModal(); renderScreen(); toast('🗑️ تم حذف ' + sym);
}

/* ════════════════════════════════════════
   GRANULAR DOM UPDATE (FOR REAL-TIME)
════════════════════════════════════════ */
function updateLiveUI() {
  if (state.currentTab !== 'portfolio') return;
  
  const eg = state.usdToEgp;
  let tv = 0, tc = 0;

  state.coins.forEach(c => {
    const t = state.prices[c.symbol];
    const price = t?.price ?? null;
    const qty = parseFloat(c.quantity) || 0;
    const avg = parseFloat(c.avgBuy) || 0;
    
    const val = price !== null ? price * qty : null;
    const cost = avg * qty;
    const pnl = val !== null ? val - cost : null;
    const pnlPct = cost > 0 && pnl !== null ? (pnl / cost * 100) : null;
    const ch24 = t ? (t.price - t.open24h) / t.open24h * 100 : null;

    if (val !== null) { tv += val; tc += cost; }

    const ip = pnl !== null ? pnl >= 0 : null;
    const cl = ip === null ? '' : ip ? 'profit' : 'loss';

    const elCard = document.getElementById(`c-card-${c.symbol}`);
    if (elCard) {
      const isExp = elCard.classList.contains('expanded');
      elCard.className = `coin-card ${cl} ${isExp ? 'expanded' : ''}`;
    }

    const elPr = document.getElementById(`c-pr-${c.symbol}`);
    if (elPr) { elPr.textContent = price !== null ? '$' + fmtExact(price) : '---'; elPr.className = `coin-price ${cl}`; }

    const elPre = document.getElementById(`c-pre-${c.symbol}`);
    if (elPre) elPre.textContent = price !== null ? fmtExact(price * eg) + ' ج.م' : '---';

    const elVal = document.getElementById(`c-val-${c.symbol}`);
    if (elVal) elVal.textContent = val !== null ? '$' + fmtExact(val) : '---';

    // التقريب لأرباح العملة الفردية
    const elPnl = document.getElementById(`c-pnl-${c.symbol}`);
    if (elPnl) { elPnl.textContent = pnl !== null ? sign(pnl) + '$' + fmtRound(Math.abs(pnl)) : '---'; elPnl.className = `pnl-usd ${cl}`; }

    const elPnle = document.getElementById(`c-pnle-${c.symbol}`);
    if (elPnle) elPnle.textContent = pnl !== null ? sign(pnl * eg) + fmtRound(Math.abs(pnl * eg)) + ' ج.م' : '---';

    const elPct = document.getElementById(`c-pct-${c.symbol}`);
    if (elPct) { elPct.textContent = pnlPct !== null ? sign(pnlPct) + fmtRound(Math.abs(pnlPct)) + '%' : '---'; elPct.className = `pnl-pct-badge ${ip === null ? 'neutral' : cl}`; }

    const elChg = document.getElementById(`c-chg-${c.symbol}`);
    if (elChg && ch24 !== null) { elChg.textContent = sign(ch24) + fmtRound(Math.abs(ch24)) + '%'; elChg.className = `coin-change ${pc(ch24)}`; }

    const elHi = document.getElementById(`c-hi-${c.symbol}`);
    if (elHi && t?.high24h) elHi.textContent = '$' + fmtExact(t.high24h);
    const elLo = document.getElementById(`c-lo-${c.symbol}`);
    if (elLo && t?.low24h) elLo.textContent = '$' + fmtExact(t.low24h);
    const elVol = document.getElementById(`c-vol-${c.symbol}`);
    if (elVol && t?.vol24h) elVol.textContent = fmtExact(t.vol24h);
  });

  const tpnl = tv - tc, tpnlE = tpnl * eg, tpct = tc > 0 ? (tpnl / tc * 100) : 0, cls = pc(tpnl);

  const elTotVal = document.getElementById('tot-val');
  if (elTotVal) { elTotVal.textContent = '$' + fmtRound(tv); elTotVal.className = `total-value ${cls}`; }

  const elTotEgp = document.getElementById('tot-egp');
  if (elTotEgp) elTotEgp.textContent = fmtRound(tv * eg) + ' ج.م';

  const elTotPct = document.getElementById('tot-pct');
  if (elTotPct) { elTotPct.textContent = sign(tpct) + fmtRound(Math.abs(tpct)) + '%'; elTotPct.className = `pnl-pct-big ${cls}`; }

  const elTotAbs = document.getElementById('tot-abs');
  if (elTotAbs) { elTotAbs.textContent = sign(tpnl) + '$' + fmtRound(Math.abs(tpnl)); elTotAbs.className = `pnl-abs ${cls}`; }

  const elTotAbsEgp = document.getElementById('tot-abs-egp');
  if (elTotAbsEgp) elTotAbsEgp.textContent = sign(tpnlE) + fmtRound(Math.abs(tpnlE)) + ' ج.م';

  const elStTc = document.getElementById('st-tc');
  if (elStTc) elStTc.textContent = '$' + fmtRound(tc);

  const elStTce = document.getElementById('st-tce');
  if (elStTce) elStTce.textContent = fmtRound(tc * eg) + ' ج.م';

  const elStPnl = document.getElementById('st-pnl');
  if (elStPnl) { elStPnl.textContent = sign(tpnl) + '$' + fmtRound(Math.abs(tpnl)); elStPnl.className = `stat-val ${cls}`; }

  const elStPnle = document.getElementById('st-pnle');
  if (elStPnle) { elStPnle.textContent = sign(tpnlE) + fmtRound(Math.abs(tpnlE)) + ' ج.م'; elStPnle.className = `stat-sub ${cls}`; }

  // تحديث الهدف لحظياً
  const target = state.targetBalance;
  if (target > 0) {
      const rem = target - tv;
      const isReached = rem <= 0;
      const prog = Math.min(100, (tv / target) * 100);

      const elRem = document.getElementById('tot-rem');
      if (elRem) {
          elRem.textContent = isReached ? '🎉 مبروك! حققت الهدف' : 'متبقي: $' + fmtRound(rem);
          elRem.className = isReached ? 'profit' : '';
      }

      const elProg = document.getElementById('tot-prog');
      if (elProg) {
          elProg.style.width = prog + '%';
          elProg.style.background = isReached ? 'var(--profit)' : 'linear-gradient(90deg, var(--teal), var(--blue))';
      }
  }
}

/* ════════════════════════════════════════
   RENDER — PORTFOLIO
════════════════════════════════════════ */
function renderPortfolio() {
  if (!state.coins.length) return `
    <div class="empty-state">
      <div class="empty-icon">📊</div>
      <div class="empty-text">لا توجد عملات بعد<br>اذهب إلى <strong>الإعدادات</strong> لإضافة عملاتك</div>
    </div>`;

  const eg = state.usdToEgp;
  let tv=0, tc=0;
  const rows = state.coins.map((c,i) => {
    const t   = state.prices[c.symbol];
    const price = t?.price ?? null;
    const qty   = parseFloat(c.quantity)||0, avg = parseFloat(c.avgBuy)||0;
    const val   = price!==null ? price*qty : null;
    const cost  = avg*qty;
    const pnl   = val!==null ? val-cost : null;
    const pnlPct= cost>0&&pnl!==null ? (pnl/cost*100) : null;
    const ch24  = t ? (t.price-t.open24h)/t.open24h*100 : null;
    if (val!==null) { tv += val; tc += cost; }
    return {c, i, price, qty, avg, val, cost, pnl, pnlPct, pnlE:pnl!==null?pnl*eg:null, ch24, tickerObj: t};
  });

  const tpnl=tv-tc, tpnlE=tpnl*eg, tpct=tc>0?(tpnl/tc*100):0, cls=pc(tpnl);
  const hasExpanded = state.expandedIndex !== null;

  // حساب شريط الهدف
  const target = state.targetBalance;
  let targetHtml = '';
  if (target > 0) {
      const remaining = target - tv;
      const isReached = remaining <= 0;
      const progress = Math.min(100, (tv / target) * 100);
      targetHtml = `
      <div style="margin-top: 14px; padding-top: 12px; border-top: 1px dashed rgba(255,255,255,0.08);">
          <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--t2); margin-bottom: 6px; font-family: 'Tajawal', sans-serif; font-weight: 700;">
              <span>الهدف: $${fmtRound(target)}</span>
              <span id="tot-rem" class="${isReached ? 'profit' : ''}">${isReached ? '🎉 مبروك! حققت الهدف' : 'متبقي: $' + fmtRound(remaining)}</span>
          </div>
          <div style="height: 6px; background: rgba(0,0,0,0.3); border-radius: 3px; overflow: hidden; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);">
              <div id="tot-prog" style="height: 100%; width: ${progress}%; background: ${isReached ? 'var(--profit)' : 'linear-gradient(90deg, var(--teal), var(--blue))'}; transition: width 0.4s ease, background 0.4s ease;"></div>
          </div>
      </div>
      `;
  }

  let html = `
    <div class="summary-card">
      <div class="summary-top">
        <div>
          <div class="summary-label">إجمالي المحفظة</div>
          <div class="total-value ${cls}" id="tot-val">$${fmtRound(tv)}</div>
          <div class="total-egp" id="tot-egp">${fmtRound(tv*eg)} ج.م</div>
        </div>
        <div class="pnl-badge">
          <div class="pnl-pct-big ${cls}" id="tot-pct">${sign(tpct)}${fmtRound(Math.abs(tpct))}%</div>
          <div class="pnl-abs ${cls}" id="tot-abs">${sign(tpnl)}$${fmtRound(Math.abs(tpnl))}</div>
          <div class="pnl-abs" id="tot-abs-egp">${sign(tpnlE)}${fmtRound(Math.abs(tpnlE))} ج.م</div>
        </div>
      </div>
      <div class="summary-stats">
        <div class="stat-box"><div class="stat-label">التكلفة</div><div class="stat-val" id="st-tc">$${fmtRound(tc)}</div><div class="stat-sub" id="st-tce">${fmtRound(tc*eg)} ج.م</div></div>
        <div class="stat-box"><div class="stat-label">الربح/الخسارة</div><div class="stat-val ${cls}" id="st-pnl">${sign(tpnl)}$${fmtRound(Math.abs(tpnl))}</div><div class="stat-sub ${cls}" id="st-pnle">${sign(tpnlE)}${fmtRound(Math.abs(tpnlE))} ج.م</div></div>
        <div class="stat-box"><div class="stat-label">العملات</div><div class="stat-val">${state.coins.length}</div><div class="stat-sub">مباشر ⚡</div></div>
      </div>
      ${targetHtml}
    </div>
    <div class="section-title">عملاتي <span class="section-badge">${state.coins.length}</span></div>
    
    <div class="portfolio-list ${hasExpanded ? 'has-expanded' : ''}" id="portfolioList">`;

  rows.forEach(({c,i,price,qty,avg,val,pnl,pnlPct,pnlE,ch24,tickerObj}) => {
    const ip=pnl!==null?pnl>=0:null, cl=ip===null?'':ip?'profit':'loss';
    const sig=state.signals[c.symbol];
    const isExpanded = state.expandedIndex === i;
    const expClass = isExpanded ? 'expanded' : '';
    
    const high = tickerObj?.high24h !== undefined ? fmtExact(tickerObj.high24h) : '---';
    const low  = tickerObj?.low24h !== undefined ? fmtExact(tickerObj.low24h) : '---';
    const vol  = tickerObj?.vol24h !== undefined ? fmtExact(tickerObj.vol24h) : '---';

    html += `
    <div class="coin-card ${cl} ${expClass}" data-index="${i}" id="c-card-${c.symbol}">
      <div class="coin-accent"></div>
      <div class="coin-top">
        <div class="coin-left">
          <div class="coin-avatar">${c.symbol.substring(0,3)}</div>
          <div>
            <div class="coin-name">${c.symbol.toUpperCase()}</div>
            <div class="coin-pair">/ USDT</div>
            ${ch24!==null?`<span class="coin-change ${pc(ch24)}" id="c-chg-${c.symbol}">${sign(ch24)}${fmtRound(Math.abs(ch24))}%</span>`:''}
          </div>
        </div>
        <div class="coin-right">
          <div class="coin-price ${cl}" id="c-pr-${c.symbol}">$${price!==null?fmtExact(price):'---'}</div>
          <div class="coin-price-egp" id="c-pre-${c.symbol}">${price!==null?fmtExact(price*eg)+' ج.م':'---'}</div>
          ${sig&&!sig.error?`<div class="coin-ai-signal" style="color:${sig.signal==='UP'?'var(--profit)':sig.signal==='DOWN'?'var(--loss)':'var(--gold)'}">${sig.signal==='UP'?'🟢 صاعد':sig.signal==='DOWN'?'🔴 هابط':'🟡 محايد'}</div>`:''}
        </div>
      </div>
      <div class="coin-stats">
        <div><div class="coin-stat-label">الكمية</div><div class="coin-stat-val">${fmtExact(qty)}</div></div>
        <div><div class="coin-stat-label">متوسط الشراء</div><div class="coin-stat-val">$${fmtExact(avg)}</div></div>
        <div><div class="coin-stat-label">القيمة</div><div class="coin-stat-val" id="c-val-${c.symbol}">${val!==null?'$'+fmtExact(val):'---'}</div></div>
      </div>
      <div class="coin-pnl-row">
        <div>
          <div class="pnl-usd ${cl}" id="c-pnl-${c.symbol}">${pnl!==null?sign(pnl)+'$'+fmtRound(Math.abs(pnl)):'---'}</div>
          <div class="pnl-egp-sub" id="c-pnle-${c.symbol}">${pnlE!==null?sign(pnlE)+fmtRound(Math.abs(pnlE))+' ج.م':'---'}</div>
        </div>
        <div class="pnl-actions">
          <div class="pnl-pct-badge ${ip===null?'neutral':cl}" id="c-pct-${c.symbol}">${pnlPct!==null?sign(pnlPct)+fmtRound(Math.abs(pnlPct))+'%':'---'}</div>
          <div class="expand-chevron ${isExpanded ? 'open' : ''}">▼</div>
        </div>
      </div>
      
      <div class="coin-expanded-area">
        <div class="exp-stats-grid">
          <div class="exp-stat"><div class="exp-lbl">أعلى 24س</div><div class="exp-val profit" id="c-hi-${c.symbol}">$${high}</div></div>
          <div class="exp-stat"><div class="exp-lbl">أدنى 24س</div><div class="exp-val loss" id="c-lo-${c.symbol}">$${low}</div></div>
          <div class="exp-stat"><div class="exp-lbl">حجم التداول</div><div class="exp-val neutral" id="c-vol-${c.symbol}">${vol}</div></div>
        </div>
        <div class="exp-actions">
          <button class="exp-btn edit-btn" data-edit-btn="${i}">✏️ تعديل</button>
          <button class="exp-btn del-btn" data-del-btn="${i}">🗑️ حذف</button>
          <a class="exp-trade-btn" href="https://www.okx.com/trade-spot/${c.symbol.toLowerCase()}-usdt" target="_blank" rel="noopener">
            📈 تداول على <span>OKX</span>
          </a>
        </div>
      </div>
    </div>`;
  });
  
  html += `</div>`;
  return html;
}

/* ════════════════════════════════════════
   RENDER — SIGNALS
════════════════════════════════════════ */
function renderSignals() {
  const next = state.lastSignalUpdate ? Math.max(0,300-Math.floor((Date.now()-state.lastSignalUpdate)/1000)) : 0;
  const nm=Math.floor(next/60), ns=next%60;
  const lbl = state.analyzing ? '⏳ جاري التحليل...' : '⚡ تحليل الآن';

  let cards = '';
  if (!state.coins.length) {
    cards = `<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">أضف عملات في الإعدادات أولاً</div></div>`;
  } else if (state.analyzing && !Object.keys(state.signals).length) {
    cards = state.coins.map(() => `<div class="skel"><div class="skel-line m"></div><div class="skel-line s"></div><div class="skel-line"></div></div>`).join('');
  } else {
    cards = state.coins.map(c => {
      const s = state.signals[c.symbol];
      if (!s) return `<div class="signal-card"><div class="sig-top"><div class="sig-coin"><div class="sig-avatar">${c.symbol.substring(0,3)}</div><div><div class="sig-sym">${c.symbol}/USDT</div><div class="sig-time">في انتظار التحليل</div></div></div><span style="font-size:22px;opacity:.3">⏳</span></div></div>`;
      if (s.error) return `<div class="signal-card"><div class="sig-top"><div class="sig-coin"><div class="sig-avatar" style="color:var(--loss)">${c.symbol.substring(0,3)}</div><div><div class="sig-sym">${c.symbol}/USDT</div><div class="sig-time" style="color:var(--loss)">${s.error}</div></div></div></div></div>`;
      const up=s.signal==='UP', dn=s.signal==='DOWN';
      const cc=up?'buy':dn?'sell':'wait';
      const emoji=up?'🟢 اشتري':dn?'🔴 بيع':'🟡 استنى';
      const strAr=s.strength==='STRONG'?'قوي':s.strength==='MODERATE'?'متوسط':'ضعيف';
      const cc2=up?'var(--profit)':dn?'var(--loss)':'var(--gold)';
      return `
        <div class="signal-card ${cc}">
          <div class="sig-top">
            <div class="sig-coin">
              <div class="sig-avatar">${c.symbol.substring(0,3)}</div>
              <div><div class="sig-sym">${c.symbol.toUpperCase()}/USDT</div><div class="sig-time">${timeAgo(s.fetchedAt)}</div></div>
            </div>
            <div><div class="sig-badge ${cc}">${emoji}</div><div class="sig-strength">${strAr} · ${s.confidence}% ثقة</div></div>
          </div>
          <div class="conf-bar-row">
            <span class="conf-label">الثقة</span>
            <div class="conf-track"><div class="conf-fill ${cc}" style="width:${s.confidence}%"></div></div>
            <span class="conf-pct" style="color:${cc2}">${s.confidence}%</span>
          </div>
          <div class="sig-reason">${s.reason||''}</div>
          ${s.entry?`<div class="sig-levels">
            <div class="sig-lv"><div class="sig-lv-label">دخول</div><div class="sig-lv-val neutral">$${fmtExact(s.entry)}</div></div>
            <div class="sig-lv"><div class="sig-lv-label">هدف</div><div class="sig-lv-val profit">$${fmtExact(s.target)}</div></div>
            <div class="sig-lv"><div class="sig-lv-label">وقف</div><div class="sig-lv-val loss">$${fmtExact(s.stopLoss)}</div></div>
            <div class="sig-lv"><div class="sig-lv-label">إطار</div><div class="sig-lv-val neutral">5-15د</div></div>
          </div>`:''}
        </div>`;
    }).join('');
  }

  return `
    <div class="ai-header-card">
      <div class="ai-header-top">
        <div class="ai-brand"><div class="ai-brand-dot"></div>🤖 مستشار AI المصري</div>
        <button class="analyze-btn" id="analyzeBtn" ${state.analyzing?'disabled':''}>${lbl}</button>
      </div>
      <div class="ai-meta">
        آخر تحليل: <strong>${timeAgo(state.lastSignalUpdate)}</strong>
        ${next>0?` | التالي: <strong style="color:var(--accent)">${nm}:${String(ns).padStart(2,'0')}</strong>`:''}
        <br>تحليل بالعامية المصرية — مجاني تماماً
      </div>
      <div class="ai-disclaimer">⚠️ للاسترشاد فقط — مش نصيحة مالية رسمية</div>
    </div>
    ${cards}`;
}

/* ════════════════════════════════════════
   RENDER — SETTINGS
════════════════════════════════════════ */
function renderSettings() {
  return `
    <div class="settings-block">
      <div class="settings-block-title">🪙 عملاتي (${state.coins.length})</div>
      ${state.coins.length===0 ? `<div style="padding:16px;text-align:center;color:var(--text3);font-size:13px">لا توجد عملات بعد</div>` : ''}
      ${state.coins.map((c,i) => {
        const pr  = state.prices[c.symbol]?.price || null;
        const pnl = pr ? (pr - parseFloat(c.avgBuy)) * parseFloat(c.quantity) : null;
        const cl  = pnl===null?'':pnl>=0?'var(--profit)':'var(--loss)';
        return `<div class="coin-list-item">
          <div class="cli-ava">${c.symbol.substring(0,3)}</div>
          <div class="cli-info">
            <div class="cli-sym">${c.symbol.toUpperCase()}/USDT</div>
            <div class="cli-meta">الكمية: ${c.quantity} | شراء: $${c.avgBuy}${pnl!==null?` <span style="color:${cl}">${pnl>=0?'▲':'▼'}$${Math.abs(pnl).toFixed(2)}</span>`:''}</div>
          </div>
          <div class="cli-edit" data-edit="${i}">✏️</div>
          <div class="cli-del" data-del="${i}">🗑️</div>
        </div>`;
      }).join('')}
    </div>

    <div class="add-form">
      <div class="add-form-title">➕ إضافة عملة جديدة</div>
      <div class="form-grid">
        <div class="form-field"><label>رمز العملة</label><input id="fSymbol" type="text" class="form-input" placeholder="BTC, ETH, SOL..." autocomplete="off" spellcheck="false"></div>
        <div class="form-field"><label>الكمية</label><input id="fQty" type="number" class="form-input" placeholder="0.5" step="any" min="0" inputmode="decimal"></div>
      </div>
      <div class="form-grid">
        <div class="form-field"><label>متوسط الشراء ($)</label><input id="fAvg" type="number" class="form-input" placeholder="45000" step="any" min="0" inputmode="decimal"></div>
        <div class="form-field" style="display:flex;align-items:flex-end"><button class="add-btn" id="addCoinBtn">➕ إضافة</button></div>
      </div>
    </div>

    <button class="save-settings-btn" id="saveSettingsBtn">💾 حفظ الإعدادات</button>

    <div class="info-box">
      💾 <strong>تخزين محلي كامل</strong> — بياناتك محفوظة على جهازك (localStorage + IndexedDB)<br>
      <span id="dbStatus2">جاري التحقق...</span><br>
      🤖 <strong style="color:var(--accent)">مستشار AI مدمج</strong> — تحليل محلي بدون إنترنت<br>
      ⏱️ تحليل تلقائي كل <strong style="color:var(--accent)">5 دقائق</strong>
    </div>`;
}

/* ════════════════════════════════════════
   RENDER MAIN + WIRE EVENTS
════════════════════════════════════════ */
function renderScreen() {
  const el = document.getElementById('mainScreen');
  if (!el) return;
  switch (state.currentTab) {
    case 'portfolio': el.innerHTML = renderPortfolio(); wirePortfolioEvents(); break;
    case 'signals':   el.innerHTML = renderSignals();   wireSignalsEvents();   break;
    case 'settings':  el.innerHTML = renderSettings();  wireSettingsEvents();  break;
  }
}

function wirePortfolioEvents() {
  const list = document.getElementById('portfolioList');
  
  document.querySelectorAll('.coin-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('button') || e.target.closest('a')) return;
      
      const idx = parseInt(card.dataset.index);
      if (state.expandedIndex === idx) {
        state.expandedIndex = null;
        card.classList.remove('expanded');
        card.querySelector('.expand-chevron')?.classList.remove('open');
        if (list) list.classList.remove('has-expanded');
      } else {
        if (state.expandedIndex !== null) {
          const prevCard = document.querySelector(`.coin-card[data-index="${state.expandedIndex}"]`);
          if (prevCard) {
            prevCard.classList.remove('expanded');
            prevCard.querySelector('.expand-chevron')?.classList.remove('open');
          }
        }
        state.expandedIndex = idx;
        card.classList.add('expanded');
        card.querySelector('.expand-chevron')?.classList.add('open');
        if (list) list.classList.add('has-expanded');
      }
    });
  });

  document.querySelectorAll('[data-edit-btn]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openEditModal(parseInt(btn.dataset.editBtn));
    });
  });

  document.querySelectorAll('[data-del-btn]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.delBtn);
      const sym = state.coins[i].symbol;
      state.coins.splice(i, 1);
      delete state.signals[sym];
      state.expandedIndex = null;
      save(); renderScreen(); toast('🗑️ تم حذف ' + sym);
    });
  });
}

function wireSignalsEvents() {
  document.getElementById('analyzeBtn')?.addEventListener('click', runAllSignals);
}

function wireSettingsEvents() {
  document.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.del);
      const sym = state.coins[i].symbol;
      state.coins.splice(i, 1); delete state.signals[sym];
      state.expandedIndex = null;
      save(); renderScreen(); toast('🗑️ تم حذف ' + sym);
    });
  });
  document.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(parseInt(btn.dataset.edit)));
  });
  const symInput = document.getElementById('fSymbol');
  if (symInput) symInput.addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
  document.getElementById('addCoinBtn')?.addEventListener('click', addCoin);
  document.getElementById('saveSettingsBtn')?.addEventListener('click', saveSettingsHandler);
  const d2 = document.getElementById('dbStatus2');
  const d1 = document.getElementById('dbStatus');
  if (d2 && d1) d2.textContent = d1.textContent;
}

function addCoin() {
  const symbol   = (document.getElementById('fSymbol')?.value||'').trim().toUpperCase();
  const quantity = (document.getElementById('fQty')?.value||'').trim();
  const avgBuy   = (document.getElementById('fAvg')?.value||'').trim();
  if (!symbol)                                   return toast('أدخل رمز العملة', true);
  if (!quantity||isNaN(quantity)||+quantity<=0)  return toast('أدخل الكمية', true);
  if (!avgBuy  ||isNaN(avgBuy)  ||+avgBuy<=0)   return toast('أدخل سعر الشراء', true);
  const exists = state.coins.findIndex(c => c.symbol === symbol);
  if (exists >= 0) { state.coins[exists] = {symbol,quantity,avgBuy}; toast('✅ تم تحديث ' + symbol); }
  else             { state.coins.push({symbol,quantity,avgBuy});      toast('✅ تمت إضافة ' + symbol); }
  ['fSymbol','fQty','fAvg'].forEach(id => { const e=document.getElementById(id); if(e) e.value=''; });
  save(); renderScreen();
}

function saveSettingsHandler() {
  toast('✅ تم الحفظ محلياً ✓'); save();
  setTimeout(() => renderScreen(), 600);
}

/* ════════════════════════════════════════
   QUICK PANEL
════════════════════════════════════════ */
let _syncQP = () => {};

function initQuickPanel() {
  const syncLabels = () => {
    const egEl  = document.getElementById('qpEgpVal');
    const alEl  = document.getElementById('qpAlertVal');
    if (egEl) egEl.textContent   = state.usdToEgp;
    if (alEl) alEl.textContent   = state.alertAt;

    const { tpnl } = calcTotals();
    
    const pill   = document.getElementById('qpPnlPill');
    const sep    = document.getElementById('qpPnlSep');
    const pnlVal = document.getElementById('qpPnlVal');
    const pnlLbl = document.getElementById('qpPnlLbl');
    if (pill && pnlVal && tpnl !== 0) {
      pill.style.display = 'flex';
      if (sep) sep.style.display = '';
      pnlVal.textContent = (tpnl >= 0 ? '+' : '') + '$' + fmtRound(Math.abs(tpnl));
      pnlVal.className   = 'qp-val ' + (tpnl >= 0 ? 'profit' : 'loss');
      if (pnlLbl) pnlLbl.textContent = tpnl >= 0 ? 'ربح' : 'خسارة';
    } else if (pill) {
      pill.style.display = 'none';
      if (sep) sep.style.display = 'none';
    }
    const sub = document.getElementById('qpAlertSub');
    if (sub && tpnl > 0 && state.alertAt > 0) {
      const toNext = (state.alertAt - (tpnl % state.alertAt)).toFixed(2);
      sub.innerHTML = `التنبيه القادم بعد <span class="hl gold">$${toNext}</span>`;
    }
  };

  syncLabels();
  const ei = document.getElementById('qpEgpInp');
  const ai = document.getElementById('qpAlertInp');
  const ti = document.getElementById('qpTargetInp');

  if (ei) ei.value = state.usdToEgp;
  if (ai) ai.value = state.alertAt;
  if (ti) ti.value = state.targetBalance;

  const toggle  = document.getElementById('qpToggle');
  const body    = document.getElementById('qpBody');
  const chevron = document.getElementById('qpChevron');

  toggle?.addEventListener('click', () => {
    const open = body.classList.toggle('open');
    chevron?.classList.toggle('open', open);
    if (open && ei) setTimeout(() => ei.focus(), 320);
  });

  document.getElementById('qpSaveBtn')?.addEventListener('click', () => {
    const egp = parseFloat(ei?.value || 50);
    const al  = parseFloat(ai?.value || 10);
    const tg  = parseFloat(ti?.value || 0);

    if (!isNaN(egp) && egp > 0) state.usdToEgp = egp;
    if (!isNaN(al)  && al  > 0) { state.alertAt = al; state.alertFired = {}; }
    if (!isNaN(tg)  && tg >= 0) state.targetBalance = tg;

    save(); syncLabels();
    body.classList.remove('open');
    chevron?.classList.remove('open');
    toast('✅ تم الحفظ!');
    renderScreen();
  });

  _syncQP = syncLabels;
  return syncLabels;
}

function syncQP() { _syncQP(); }

/* ════════════════════════════════════════
   TOAST
════════════════════════════════════════ */
function toast(msg, isErr=false, isGold=false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr?' err':'') + (isGold?' gold':'');
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => t.classList.remove('show'), 3200);
}

/* ════════════════════════════════════════
   TABS
════════════════════════════════════════ */
function initTabs() {
  function activateTab(name) {
    document.querySelectorAll('.tab, .sidebar-btn').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('[data-tab="' + name + '"]').forEach(t => t.classList.add('active'));
    state.currentTab = name;
    renderScreen();
  }
  document.querySelectorAll('.tab, .sidebar-btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
}

/* ════════════════════════════════════════
   MODAL WIRING
════════════════════════════════════════ */
function initModal() {
  document.getElementById('editModal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('editModal')) closeEditModal();
  });
  document.getElementById('modalCloseBtn')?.addEventListener('click', closeEditModal);
  document.getElementById('modalSaveBtn')?.addEventListener('click', saveEdit);
  document.getElementById('modalDelBtn')?.addEventListener('click', deleteFromModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeEditModal(); });
}

/* ════════════════════════════════════════
   AUTO REFRESH
════════════════════════════════════════ */
function startAutoRefresh() {
  // تحديث إشارات AI كل 5 دقائق تلقائياً
  setInterval(() => {
    const age = state.lastSignalUpdate ? Date.now() - state.lastSignalUpdate : Infinity;
    if (age > 5 * 60 * 1000 && state.coins.length > 0 && !state.analyzing) runAllSignals();
  }, 60 * 1000);

  // إعادة رسم شاشة الإشارات كل 10 ثواني لتحديث الوقت
  setInterval(() => {
    if (state.currentTab === 'signals' && !state.analyzing) renderScreen();
  }, 10000);

  // حفظ دوري كل دقيقة ضماناً إضافياً
  setInterval(() => {
    if (state.coins.length > 0) save();
  }, 60 * 1000);
}

/* ════════════════════════════════════════
   REFRESH BUTTON
════════════════════════════════════════ */
function initRefreshBtn() {
  document.getElementById('refreshBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('refreshBtn');
    btn.innerHTML = '<span class="spin">🔄</span>';
    
    initWebSocket(); 
    await refreshPrices();
    await fetchTickerPrices();
    
    btn.innerHTML = '🔄';
    setDbStatus('🟢 محفوظ محلياً ✓');
    toast('✅ تم تحديث الأسعار');
  });
}

/* ════════════════════════════════════════
   BOOT
════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', async () => {
  // 1. تحميل من localStorage
  load();

  // 2. لو الإضافة: استرجع من chrome.storage.local (الأقوى)
  const fromChrome = await chromeStorageLoad();
  if (fromChrome) {
    toast('✅ تم استرجاع بياناتك');
  } else {
    // 3. fallback: IndexedDB لو localStorage اتمسح
    const fromIDB = await loadFromIDB();
    if (fromIDB) toast('✅ تم استرجاع بياناتك المحفوظة');
  }

  initTabs();
  initModal();
  initQuickPanel();
  initRefreshBtn();
  renderScreen();
  renderMarketBar();

  await refreshPrices();
  await fetchTickerPrices();
  renderScreen();
  syncQP();

  initWebSocket();
  startAutoRefresh();

  // حفظ أولي في كل طبقات التخزين
  save();
  setDbStatus('🟢 محفوظ محلياً ✓');

  document.getElementById('closePanelBtn')?.addEventListener('click', () => {
    if (typeof window !== 'undefined') window.close();
  });

  if ('Notification' in window && Notification.permission === 'default')
    setTimeout(() => Notification.requestPermission(), 3000);

  const age = state.lastSignalUpdate ? Date.now() - state.lastSignalUpdate : Infinity;
  if (age > 5 * 60 * 1000 && state.coins.length > 0)
    setTimeout(runAllSignals, 3000);

  // حفظ عند إغلاق/إخفاء الصفحة
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.coins.length > 0) save();
  });
  window.addEventListener('beforeunload', () => {
    if (state.coins.length > 0) localSave();
  });
});
