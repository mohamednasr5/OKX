// OKX Tracker PWA — app.js
// م. محمد حماد
'use strict';

/* ════════════════════════════════════════
   CONFIG & STATE
════════════════════════════════════════ */
const OKX_TICKER  = 'https://www.okx.com/api/v5/market/ticker';
const OKX_CANDLES = 'https://www.okx.com/api/v5/market/candles';

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
  prices: {},
  tickerPrices: {},
  signals: {},
  lastSignalUpdate: null,
  lastPriceUpdate: null,
  currentTab: 'portfolio',
  analyzing: false,
  alertFired: {},
  expandedCard: null,
};

/* ════════════════════════════════════════
   FIREBASE
════════════════════════════════════════ */
const FB_CFG = {
  apiKey:            'AIzaSyAbkjK3I1OmNi4FLHBBjvd19bwQ74y4Dpk',
  authDomain:        'okx01-3c8d1.firebaseapp.com',
  databaseURL:       'https://okx01-3c8d1-default-rtdb.firebaseio.com',
  projectId:         'okx01-3c8d1',
  storageBucket:     'okx01-3c8d1.firebasestorage.app',
  messagingSenderId: '472089731731',
  appId:             '1:472089731731:web:1206305ca415b5e8056366',
};
let dbRef    = null;
let isSaving = false;

function initFirebase() {
  try {
    if (!firebase.apps.length) firebase.initializeApp(FB_CFG);
    dbRef = firebase.database().ref('settings');
    dbRef.on('value', snap => {
      const d = snap.val();
      if (!d || isSaving) return;
      if (Array.isArray(d.coins))  state.coins            = d.coins;
      if (d.usdToEgp)              state.usdToEgp         = parseFloat(d.usdToEgp) || 50;
      if (d.alertAt != null)       state.alertAt          = parseFloat(d.alertAt)  || 10;
      if (d.signals)               state.signals          = d.signals;
      if (d.lastSignalUpdate)      state.lastSignalUpdate = d.lastSignalUpdate;
      localSave();
      renderScreen();
      syncQP();
    });
    setDbStatus('🟢 متصل بقاعدة البيانات');
  } catch(e) {
    setDbStatus('🟡 وضع عدم الاتصال');
  }
}

async function save() {
  localSave();
  if (!dbRef) return;
  try {
    isSaving = true;
    await dbRef.set({
      coins: state.coins, usdToEgp: state.usdToEgp, alertAt: state.alertAt,
      signals: state.signals, lastSignalUpdate: state.lastSignalUpdate || null,
      updatedAt: Date.now(),
    });
  } catch(e) { setDbStatus('🔴 خطأ في الحفظ'); }
  finally { setTimeout(() => { isSaving = false; }, 1500); }
}

function localSave() {
  try {
    localStorage.setItem('okx_coins',   JSON.stringify(state.coins));
    localStorage.setItem('okx_egp',     state.usdToEgp);
    localStorage.setItem('okx_alertAt', state.alertAt);
    localStorage.setItem('okx_signals', JSON.stringify(state.signals));
    if (state.lastSignalUpdate) localStorage.setItem('okx_sig_ts', state.lastSignalUpdate);
    if (state.alertFired) localStorage.setItem('okx_alert_fired', JSON.stringify(state.alertFired));
  } catch(e) {}
}

function load() {
  try { state.coins      = JSON.parse(localStorage.getItem('okx_coins')        || '[]'); } catch(e){}
  try { state.signals    = JSON.parse(localStorage.getItem('okx_signals')      || '{}'); } catch(e){}
  try { state.alertFired = JSON.parse(localStorage.getItem('okx_alert_fired')  || '{}'); } catch(e){}
  state.usdToEgp        = parseFloat(localStorage.getItem('okx_egp')     || '50') || 50;
  state.alertAt         = parseFloat(localStorage.getItem('okx_alertAt') || '10') || 10;
  state.lastSignalUpdate = parseInt(localStorage.getItem('okx_sig_ts')   || '0')  || null;
}

function setDbStatus(msg) {
  const el = document.getElementById('dbStatus');
  if (el) el.textContent = msg;
  const dot = document.getElementById('dbDot');
  if (dot) {
    if (msg.includes('متصل')) dot.className = 'connected';
    else if (msg.includes('خطأ')) dot.className = 'error';
    else dot.className = '';
  }
}

/* ════════════════════════════════════════
   FORMATTING
════════════════════════════════════════ */
const fmt  = (n, d=2) => n==null||isNaN(n) ? '---' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtP = p => {
  if (!p || isNaN(p)) return '---';
  if (p >= 10000) return fmt(p, 0);
  if (p >= 1000)  return fmt(p, 2);
  if (p >= 1)     return fmt(p, 4);
  if (p >= 0.01)  return fmt(p, 5);
  return fmt(p, 8);
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

/* ════════════════════════════════════════
   MARKET BAR — ticker coins
════════════════════════════════════════ */
async function fetchTickerPrices() {
  await Promise.allSettled(TICKER_COINS.map(async ({sym, instId}) => {
    const r = await fetch(`${OKX_TICKER}?instId=${instId}`);
    const d = await r.json();
    if (d.code === '0' && d.data?.[0]) {
      const t     = d.data[0];
      const price = parseFloat(t.last);
      const open  = parseFloat(t.sodUtc8 || t.open24h || t.last);
      const prev  = state.tickerPrices[sym]?.price ?? null;
      state.tickerPrices[sym] = { price, change: open > 0 ? (price - open) / open * 100 : 0, prev };
    }
  }));
  renderMarketBar();
}

function renderMarketBar() {
  const grid = document.getElementById('marketGrid');
  if (!grid) return;
  const fmtMP = p => {
    if (!p || isNaN(p)) return '···';
    if (p >= 10000) return p.toLocaleString('en-US',{maximumFractionDigits:0});
    if (p >= 1000)  return p.toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1});
    if (p >= 1)     return p.toFixed(3);
    if (p >= 0.01)  return p.toFixed(4);
    return p.toFixed(6);
  };
  grid.innerHTML = TICKER_COINS.map(({sym}) => {
    const d      = state.tickerPrices[sym];
    const price  = d ? fmtMP(d.price) : '···';
    const ch     = d?.change ?? null;
    const chTxt  = ch !== null ? `${ch >= 0 ? '▲' : '▼'}${Math.abs(ch).toFixed(2)}%` : '';
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
   PRICES
════════════════════════════════════════ */
async function fetchTicker(symbol) {
  try {
    const r = await fetch(`${OKX_TICKER}?instId=${symbol.toUpperCase()}-USDT`);
    const d = await r.json();
    if (d.code === '0' && d.data?.length > 0) {
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
  let totalPnl = 0;
  state.coins.forEach(c => {
    const price = state.prices[c.symbol]?.price ?? 0;
    totalPnl += (price - parseFloat(c.avgBuy)) * parseFloat(c.quantity);
  });
  if (totalPnl > 0) checkProfitAlert(totalPnl);
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
  const earned    = (level * thr).toFixed(0);
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
    const r = await fetch(`${OKX_CANDLES}?instId=${symbol.toUpperCase()}-USDT&bar=5m&limit=60`);
    const d = await r.json();
    if (d.code === '0' && d.data?.length > 0)
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
   AI ANALYSIS
════════════════════════════════════════ */
function buildCtx(snap, coin) {
  const qty=parseFloat(coin.quantity)||0, avg=parseFloat(coin.avgBuy)||0;
  const pnlUSD=snap.price?(snap.price-avg)*qty:null;
  const pnlPct=avg&&snap.price?((snap.price-avg)/avg*100):null;
  const pnlEGP=pnlUSD?(pnlUSD*state.usdToEgp):null;
  const rsiDesc=snap.rsiVal!=null?(snap.rsiVal<30?`RSI عند ${snap.rsi} — تشبع بيعي`:snap.rsiVal>70?`RSI عند ${snap.rsi} — تشبع شرائي`:`RSI عند ${snap.rsi} — محايد`):'';
  const trendDesc=snap.ema9CrossUp!=null?(snap.ema9CrossUp?'المتوسطات: إشارة صعود':'المتوسطات: إشارة هبوط'):'';
  const posDesc=pnlUSD!=null?(pnlPct>=0?`المستخدم في ربح ${Math.abs(pnlPct).toFixed(2)}% يعني $${Math.abs(pnlUSD).toFixed(2)} ≈ ${Math.abs(pnlEGP).toFixed(0)} جنيه`:`المستخدم في خسارة ${Math.abs(pnlPct).toFixed(2)}% يعني $${Math.abs(pnlUSD).toFixed(2)} ≈ ${Math.abs(pnlEGP).toFixed(0)} جنيه`):'';
  return `العملة: ${snap.symbol}/USDT | السعر: $${fmtP(snap.price)} | التغيير: ${snap.ch1}% (شمعة) ${snap.ch5}% (5 شمعات)
${rsiDesc} | ${trendDesc} | MACD: ${snap.macdPositive?'صاعد':'هابط'}
${snap.bbPctVal!=null?(snap.bbPctVal<20?'قرب الدعم (Bollinger)':snap.bbPctVal>80?'قرب المقاومة (Bollinger)':'في المنتصف'):''}
حجم التداول: ${snap.volRatioVal>1.5?'مرتفع جداً':snap.volRatioVal<0.7?'منخفض':'طبيعي'}
الشمعة ${snap.candleGreen?'خضرا':'حمرا'} — مقاومة: $${fmtP(snap.resistance)} — دعم: $${fmtP(snap.support)}
${posDesc} | الدولار: ${state.usdToEgp} جنيه`.trim();
}

function buildFallback(snap, coin, signal) {
  const qty=parseFloat(coin.quantity)||0, avg=parseFloat(coin.avgBuy)||0;
  const pnlPct=avg&&snap.price?((snap.price-avg)/avg*100):null;
  const pnlUSD=snap.price?(snap.price-avg)*qty:null;
  const pnlEGP=pnlUSD?(pnlUSD*state.usdToEgp):null;
  const rsiDesc=snap.rsiVal!=null?(snap.rsiVal<30?`الـ RSI عند ${snap.rsi} في منطقة تشبع بيعي، فرصة شراء محتملة.`:snap.rsiVal>70?`الـ RSI عند ${snap.rsi} في منطقة تشبع شرائي.`:`الـ RSI عند ${snap.rsi} محايد.`):'';
  const trendDesc=snap.ema9CrossUp?'المتوسطات المتحركة بتقول اتجاه صاعد.':'المتوسطات بتقول اتجاه هابط.';
  const posDesc=pnlUSD!=null?(pnlPct>=0?`إنت في ربح ${Math.abs(pnlPct).toFixed(2)}% يعني $${Math.abs(pnlUSD).toFixed(2)} ≈ ${Math.abs(pnlEGP).toFixed(0)} جنيه.`:`إنت في خسارة ${Math.abs(pnlPct).toFixed(2)}% يعني $${Math.abs(pnlUSD).toFixed(2)} ≈ ${Math.abs(pnlEGP).toFixed(0)} جنيه.`):'';
  const advice=signal==='UP'?'التوصية: ممكن تزيد مركزك بحذر مع وقف خسارة تحت الدعم.':signal==='DOWN'?'التوصية: استنى أو قلل المركز.':'التوصية: استنى لحد ما السوق يتضح.';
  return [rsiDesc, trendDesc, posDesc, advice].filter(Boolean).join(' ');
}

async function callAI(snap, coin) {
  const ctx = buildCtx(snap, coin);
  const sys = `أنت "أستاذ كريبتو" — مستشار عملات رقمية مصري خبير وصريح.
قواعد: عامية مصرية 100% — ممنوع إنجليزي في الشرح — JSON فقط.`;
  const usr = `${ctx}

اشرح بالعامية المصرية: إيه اللي بيحصل، وضع المستخدم بالأرقام، توصيتك الصريحة.

JSON فقط:
{"signal":"UP","strength":"STRONG","confidence":78,"reason":"عامية مصرية 100%"}
signal=UP|DOWN|NEUTRAL — strength=STRONG|MODERATE|WEAK — confidence 55-92`;

  const apis = [
    {
      url:'https://api.anthropic.com/v1/messages',
      body:()=>JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:250,system:sys,messages:[{role:'user',content:usr}]}),
      headers:{'Content-Type':'application/json'},
      parse:async r=>{const d=await r.json();const t=(d.content||[]).map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();return JSON.parse(t.match(/\{[\s\S]*?\}/)[0]);}
    },
    {
      url:'https://api.llm7.io/v1/chat/completions',
      body:()=>JSON.stringify({model:'gpt-4o-mini-2024-07-18',max_tokens:250,temperature:.2,messages:[{role:'system',content:sys},{role:'user',content:usr}]}),
      headers:{'Content-Type':'application/json'},
      parse:async r=>{const d=await r.json();const t=(d.choices?.[0]?.message?.content||'').replace(/```json|```/g,'').trim();return JSON.parse(t.match(/\{[\s\S]*?\}/)[0]);}
    },
  ];
  for (const api of apis) {
    try {
      const r = await fetch(api.url,{method:'POST',headers:api.headers,body:api.body()});
      if (!r.ok) continue;
      const p = await api.parse(r);
      const sig = ['UP','DOWN','NEUTRAL'].includes(p.signal) ? p.signal : 'NEUTRAL';
      const str = ['STRONG','MODERATE','WEAK'].includes(p.strength) ? p.strength : 'MODERATE';
      const con = Math.min(92, Math.max(55, parseInt(p.confidence)||65));
      const rsn = (typeof p.reason==='string' && p.reason.trim().length>15 && !/no reason|N\/A/i.test(p.reason))
        ? p.reason.trim() : buildFallback(snap, coin, sig);
      const lvl = calcLevels(sig, snap);
      return {signal:sig, strength:str, confidence:con, reason:rsn, ...lvl, fetchedAt:Date.now()};
    } catch(e){continue;}
  }
  throw new Error('فشل الاتصال بالـ AI');
}

async function analyzeOne(coin) {
  try {
    const candles = await fetchCandles(coin.symbol);
    if (!candles || candles.length < 30) return {error:'بيانات غير كافية'};
    const snap = buildSnap(coin.symbol, candles);
    return await callAI(snap, coin);
  } catch(e) { return {error:'خطأ في التحليل'}; }
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
  toast('✅ التحليل اتحدّث!');
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
  save(); closeEditModal(); renderScreen(); toast('🗑️ تم حذف ' + sym);
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
    if (val!==null) tv += val; tc += cost;
    return {c, i, price, qty, avg, val, cost, pnl, pnlPct, pnlE:pnl!==null?pnl*eg:null, ch24};
  });

  const tpnl=tv-tc, tpnlE=tpnl*eg, tpct=tc>0?(tpnl/tc*100):0, cls=pc(tpnl);

  let html = `
    <div class="summary-card">
      <div class="summary-top">
        <div>
          <div class="summary-label">إجمالي المحفظة</div>
          <div class="total-value ${cls}">$${fmt(tv)}</div>
          <div class="total-egp">${fmt(tv*eg)} ج.م</div>
        </div>
        <div class="pnl-badge">
          <div class="pnl-pct-big ${cls}">${sign(tpct)}${fmt(tpct,2)}%</div>
          <div class="pnl-abs ${cls}">${sign(tpnl)}$${fmt(Math.abs(tpnl))}</div>
          <div class="pnl-abs">${sign(tpnlE)}${fmt(Math.abs(tpnlE))} ج.م</div>
        </div>
      </div>
      <div class="summary-stats">
        <div class="stat-box"><div class="stat-label">التكلفة</div><div class="stat-val">$${fmt(tc,0)}</div><div class="stat-sub">${fmt(tc*eg,0)} ج.م</div></div>
        <div class="stat-box"><div class="stat-label">الربح/الخسارة</div><div class="stat-val ${cls}">${sign(tpnl)}$${fmt(Math.abs(tpnl))}</div><div class="sum-stat-sub ${cls}">${sign(tpnlE)}${fmt(Math.abs(tpnlE))} ج.م</div></div>
        <div class="stat-box"><div class="stat-label">العملات</div><div class="stat-val">${state.coins.length}</div><div class="stat-sub">${state.lastPriceUpdate?'محدّث':'جاري...'}</div></div>
      </div>
    </div>
    <div class="section-title">عملاتي <span class="section-badge">${state.coins.length}</span></div>`;

  rows.forEach(({c,i,price,qty,avg,val,pnl,pnlPct,pnlE,ch24}) => {
    const ip=pnl!==null?pnl>=0:null, cl=ip===null?'':ip?'profit':'loss';
    const sig=state.signals[c.symbol];
    const isExpanded = state.expandedCard === i;
    const t = state.prices[c.symbol];
    const high24h = t?.high24h ?? null;
    const low24h  = t?.low24h  ?? null;
    const vol24h  = t?.vol24h  ?? null;
    const sigColor = sig&&!sig.error?(sig.signal==='UP'?'var(--profit)':sig.signal==='DOWN'?'var(--loss)':'var(--gold)'):'';
    const sigLabel = sig&&!sig.error?(sig.signal==='UP'?'🟢 صاعد':sig.signal==='DOWN'?'🔴 هابط':'🟡 محايد'):'';
    const okxInstId = `${c.symbol.toUpperCase()}-USDT`;
    const okxDeepLink = `okx://web/spot?instId=${okxInstId}`;
    const okxFallback = `https://www.okx.com/trade-spot/${c.symbol.toLowerCase()}-usdt`;

    // Collapsed card (shown when another card is expanded)
    if (state.expandedCard !== null && !isExpanded) {
      html += `
      <div class="coin-card-mini ${cl}" data-expand="${i}">
        <div class="coin-accent"></div>
        <div class="ccm-inner">
          <div class="coin-avatar ccm-ava">${c.symbol.substring(0,3)}</div>
          <div class="ccm-name">${c.symbol.toUpperCase()}</div>
          <div class="ccm-price ${cl}">$${price!==null?fmtP(price):'---'}</div>
          ${sig&&!sig.error?`<div class="ccm-sig" style="color:${sigColor}">${sigLabel}</div>`:''}
          <div class="ccm-pnl ${ip===null?'neutral':cl}">${pnlPct!==null?sign(pnlPct)+fmt(Math.abs(pnlPct),2)+'%':'---'}</div>
        </div>
      </div>`;
      return;
    }

    html += `
    <div class="coin-card ${cl}${isExpanded?' expanded':''}" data-expand="${i}">
      <div class="coin-accent"></div>
      <div class="coin-top">
        <div class="coin-left">
          <div class="coin-avatar">${c.symbol.substring(0,3)}</div>
          <div>
            <div class="coin-name">${c.symbol.toUpperCase()}</div>
            <div class="coin-pair">/ USDT</div>
            ${ch24!==null?`<span class="coin-change ${pc(ch24)}">${sign(ch24)}${fmt(Math.abs(ch24),2)}%</span>`:''}
          </div>
        </div>
        <div class="coin-right">
          <div class="coin-price ${cl}">$${price!==null?fmtP(price):'---'}</div>
          <div class="coin-price-egp">${price!==null?fmt(price*eg,2)+' ج.م':'---'}</div>
          ${sig&&!sig.error?`<div class="coin-ai-signal" style="color:${sigColor}">${sigLabel}</div>`:''}
        </div>
        <div class="coin-expand-arrow ${isExpanded?'open':''}">▼</div>
      </div>
      <div class="coin-stats">
        <div><div class="coin-stat-label">الكمية</div><div class="coin-stat-val">${fmt(qty,4)}</div></div>
        <div><div class="coin-stat-label">متوسط الشراء</div><div class="coin-stat-val">$${fmtP(avg)}</div></div>
        <div><div class="coin-stat-label">القيمة</div><div class="coin-stat-val">${val!==null?'$'+fmt(val):'---'}</div></div>
      </div>
      <div class="coin-pnl-row">
        <div>
          <div class="pnl-usd ${cl}">${pnl!==null?sign(pnl)+'$'+fmt(Math.abs(pnl)):'---'}</div>
          <div class="pnl-egp-sub">${pnlE!==null?sign(pnlE)+fmt(Math.abs(pnlE))+' ج.م':'---'}</div>
        </div>
        <div class="pnl-actions">
          <div class="pnl-pct-badge ${ip===null?'neutral':cl}">${pnlPct!==null?sign(pnlPct)+fmt(Math.abs(pnlPct),2)+'%':'---'}</div>
        </div>
      </div>
      ${isExpanded ? `
      <div class="coin-expanded-body">
        <div class="cex-divider"></div>
        <div class="cex-details-grid">
          <div class="cex-detail-box">
            <div class="cex-detail-label">أعلى 24 ساعة</div>
            <div class="cex-detail-val profit">$${high24h!==null?fmtP(high24h):'---'}</div>
          </div>
          <div class="cex-detail-box">
            <div class="cex-detail-label">أدنى 24 ساعة</div>
            <div class="cex-detail-val loss">$${low24h!==null?fmtP(low24h):'---'}</div>
          </div>
          <div class="cex-detail-box">
            <div class="cex-detail-label">حجم التداول</div>
            <div class="cex-detail-val">${vol24h!==null?fmt(vol24h,0):'---'}</div>
          </div>
          <div class="cex-detail-box">
            <div class="cex-detail-label">التكلفة الكلية</div>
            <div class="cex-detail-val">$${fmt(avg*qty)}</div>
          </div>
          <div class="cex-detail-box">
            <div class="cex-detail-label">الربح بالجنيه</div>
            <div class="cex-detail-val ${cl}">${pnlE!==null?sign(pnlE)+fmt(Math.abs(pnlE))+' ج.م':'---'}</div>
          </div>
          <div class="cex-detail-box">
            <div class="cex-detail-label">نسبة الربح</div>
            <div class="cex-detail-val ${ip===null?'':cl}">${pnlPct!==null?sign(pnlPct)+fmt(Math.abs(pnlPct),2)+'%':'---'}</div>
          </div>
        </div>
        ${sig&&!sig.error?`
        <div class="cex-signal-row">
          <div class="cex-sig-badge" style="background:${sig.signal==='UP'?'rgba(16,185,129,.12)':sig.signal==='DOWN'?'rgba(239,68,68,.1)':'rgba(245,158,11,.09)'};color:${sigColor};border:1px solid ${sigColor}30">
            ${sigLabel} — ${sig.strength==='STRONG'?'إشارة قوية':sig.strength==='MODERATE'?'إشارة متوسطة':'إشارة ضعيفة'} · ${sig.confidence}%
          </div>
        </div>`:''}
        <div class="cex-actions">
          <button class="cex-btn cex-btn-edit" data-edit="${i}">✏️ تعديل</button>
          <button class="cex-btn cex-btn-del"  data-del="${i}">🗑️ حذف</button>
          <a class="cex-btn cex-btn-trade" href="${okxDeepLink}" onclick="if(!navigator.userAgent.includes('Android')&&!navigator.userAgent.includes('iPhone')){this.href='${okxFallback}'}">
            📈 تداول على OKX
          </a>
        </div>
      </div>` : ''}
    </div>`;
  });
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
            <div class="sig-lv"><div class="sig-lv-label">دخول</div><div class="sig-lv-val neutral">$${fmtP(s.entry)}</div></div>
            <div class="sig-lv"><div class="sig-lv-label">هدف</div><div class="sig-lv-val profit">$${fmtP(s.target)}</div></div>
            <div class="sig-lv"><div class="sig-lv-label">وقف</div><div class="sig-lv-val loss">$${fmtP(s.stopLoss)}</div></div>
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
        <br>تحليل بالعامية المصرية — مجاني بلا تسجيل
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
          <div class="edit-coin-btn" data-edit="${i}">✏️</div>
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
      🔥 <strong style="color:#ff6d00">Firebase</strong> Realtime Database — بياناتك محفوظة على السحابة<br>
      <span id="dbStatus2">جاري الاتصال...</span><br>
      🤖 <strong style="color:var(--accent)">AI مجاني</strong> — تحليل بالعامية المصرية<br>
      ⏱️ تحليل تلقائي كل <strong style="color:var(--accent)">5 دقائق</strong><br>
      📱 أضف التطبيق للشاشة الرئيسية لتجربة أفضل
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
  // Expand/collapse on card click
  document.querySelectorAll('.coin-card[data-expand], .coin-card-mini[data-expand]').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('[data-edit],[data-del],.cex-btn-trade,.cex-btn-edit,.cex-btn-del')) return;
      const idx = parseInt(card.dataset.expand);
      state.expandedCard = state.expandedCard === idx ? null : idx;
      renderScreen();
    });
  });
  // Edit buttons inside expanded card
  document.querySelectorAll('.cex-btn-edit[data-edit]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openEditModal(parseInt(btn.dataset.edit));
    });
  });
  // Delete buttons inside expanded card
  document.querySelectorAll('.cex-btn-del[data-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.del);
      const sym = state.coins[i].symbol;
      state.coins.splice(i, 1);
      delete state.signals[sym];
      state.expandedCard = null;
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
  // sync db status
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
  toast('✅ تم الحفظ'); save();
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

    let curPnl = 0;
    state.coins.forEach(c => {
      const pr = state.prices[c.symbol]?.price || 0;
      curPnl += (pr - parseFloat(c.avgBuy)) * parseFloat(c.quantity);
    });
    const pill   = document.getElementById('qpPnlPill');
    const sep    = document.getElementById('qpPnlSep');
    const pnlVal = document.getElementById('qpPnlVal');
    const pnlLbl = document.getElementById('qpPnlLbl');
    if (pill && pnlVal && curPnl !== 0) {
      pill.style.display = 'flex';
      if (sep) sep.style.display = '';
      pnlVal.textContent = (curPnl >= 0 ? '+' : '') + '$' + Math.abs(curPnl).toFixed(2);
      pnlVal.className   = 'qp-val ' + (curPnl >= 0 ? 'profit' : 'loss');
      if (pnlLbl) pnlLbl.textContent = curPnl >= 0 ? 'ربح' : 'خسارة';
    } else if (pill) {
      pill.style.display = 'none';
      if (sep) sep.style.display = 'none';
    }
    const sub = document.getElementById('qpAlertSub');
    if (sub && curPnl > 0 && state.alertAt > 0) {
      const toNext = (state.alertAt - (curPnl % state.alertAt)).toFixed(2);
      sub.innerHTML = `التنبيه القادم بعد <span class="hl gold">$${toNext}</span>`;
    }
  };

  syncLabels();
  const ei = document.getElementById('qpEgpInp');
  const ai = document.getElementById('qpAlertInp');
  if (ei) ei.value = state.usdToEgp;
  if (ai) ai.value = state.alertAt;

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
    if (!isNaN(egp) && egp > 0) state.usdToEgp = egp;
    if (!isNaN(al)  && al  > 0) { state.alertAt = al; state.alertFired = {}; }
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

function updateDbDot(status) {
  const dot = document.getElementById('dbDot');
  if (dot) dot.className = status;
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
  // أسعار المحفظة كل 10 ثوان
  setInterval(async () => {
    await refreshPrices();
    syncQP();
    if (state.currentTab === 'portfolio') renderScreen();
  }, 10000);

  // أسعار الـ market bar كل 15 ثانية
  setInterval(fetchTickerPrices, 15000);

  // تحليل AI تلقائي كل 5 دقائق
  setInterval(() => {
    const age = state.lastSignalUpdate ? Date.now()-state.lastSignalUpdate : Infinity;
    if (age > 5*60*1000 && state.coins.length > 0 && !state.analyzing) runAllSignals();
  }, 60*1000);

  // Countdown في signals كل ثانية
  setInterval(() => {
    if (state.currentTab === 'signals' && !state.analyzing) renderScreen();
  }, 10000);
}

/* ════════════════════════════════════════
   REFRESH BUTTON
════════════════════════════════════════ */
function initRefreshBtn() {
  document.getElementById('refreshBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('refreshBtn');
    btn.innerHTML = '<span class="spin">🔄</span>';
    await refreshPrices();
    await fetchTickerPrices();
    syncQP();
    renderScreen();
    btn.innerHTML = '🔄';
    toast('✅ تم التحديث');
  });
}

/* ════════════════════════════════════════
   SERVICE WORKER
════════════════════════════════════════ */
function registerSW() {
  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ════════════════════════════════════════
   BOOT
════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', async () => {
  load();
  initTabs();
  initModal();
  initQuickPanel();
  initRefreshBtn();
  renderScreen();
  renderMarketBar();
  initFirebase();

  await refreshPrices();
  await fetchTickerPrices();
  renderScreen();
  syncQP();

  startAutoRefresh();
  registerSW();

  if ('Notification' in window && Notification.permission === 'default')
    setTimeout(() => Notification.requestPermission(), 3000);

  // تحليل تلقائي عند الفتح لو البيانات قديمة
  const age = state.lastSignalUpdate ? Date.now()-state.lastSignalUpdate : Infinity;
  if (age > 5*60*1000 && state.coins.length > 0)
    setTimeout(runAllSignals, 3000);
});
