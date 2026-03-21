// OKX Tracker PWA - app.js
'use strict';

// ═══════════════════════════════════════
// CONFIG & STATE
// ═══════════════════════════════════════
const OKX_TICKER  = 'https://www.okx.com/api/v5/market/ticker';
const OKX_CANDLES = 'https://www.okx.com/api/v5/market/candles';
const LLM7_API    = 'https://api.llm7.io/v1/chat/completions';

let state = {
  coins: [],
  usdToEgp: 50,
  prices: {},
  signals: {},
  lastSignalUpdate: null,
  currentScreen: 'portfolio',
  analyzing: false,
  lastPriceUpdate: null,
};

// ═══════════════════════════════════════
// FIREBASE CONFIG
// ═══════════════════════════════════════
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAbkjK3I1OmNi4FLHBBjvd19bwQ74y4Dpk",
  authDomain:        "okx01-3c8d1.firebaseapp.com",
  databaseURL:       "https://okx01-3c8d1-default-rtdb.firebaseio.com",
  projectId:         "okx01-3c8d1",
  storageBucket:     "okx01-3c8d1.firebasestorage.app",
  messagingSenderId: "472089731731",
  appId:             "1:472089731731:web:1206305ca415b5e8056366",
  measurementId:     "G-NE80437ZQ0"
};

// Firebase refs (set after init)
let dbRef = null;
let isSaving = false; // prevents Firebase listener from overriding during active save

// Initialize Firebase — uses compat SDK loaded from CDN in index.html
function initFirebase() {
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    const db = firebase.database();
    dbRef = db.ref('settings');

    // 🔴 LIVE LISTENER — updates state instantly when DB changes (even from another device)
    dbRef.on('value', snap => {
      const data = snap.val();
      if (!data) return;
      if (isSaving) return; // ← ignore Firebase echo while we're the ones saving
      if (Array.isArray(data.coins))  state.coins      = data.coins;
      if (data.usdToEgp)              state.usdToEgp   = parseFloat(data.usdToEgp) || 50;
      if (data.signals)               state.signals    = data.signals;
      if (data.lastSignalUpdate)      state.lastSignalUpdate = data.lastSignalUpdate;
      localSave();
      renderScreen();
    }, err => {
      console.warn('Firebase listener error:', err);
    });

    console.log('✅ Firebase connected');
    showDbStatus('🟢 متصل بقاعدة البيانات');
  } catch(e) {
    console.warn('Firebase init failed, using localStorage:', e);
    showDbStatus('🟡 وضع عدم الاتصال');
  }
}

// Show connection status badge
function showDbStatus(msg) {
  const el = document.getElementById('dbStatus');
  if (el) el.textContent = msg;
}

// ═══════════════════════════════════════
// STORAGE — Firebase primary, localStorage fallback
// ═══════════════════════════════════════
async function save() {
  localSave();
  if (!dbRef) return;
  try {
    isSaving = true;
    await dbRef.set({
      coins:            state.coins,
      usdToEgp:         state.usdToEgp,
      signals:          state.signals,
      lastSignalUpdate: state.lastSignalUpdate || null,
      updatedAt:        Date.now(),
    });
  } catch(e) {
    console.warn('Firebase save error:', e);
    showDbStatus('🔴 خطأ في الحفظ');
  } finally {
    // Release lock after Firebase echo has time to arrive and be ignored
    setTimeout(() => { isSaving = false; }, 1500);
  }
}

function localSave() {
  try {
    localStorage.setItem('okx_coins',   JSON.stringify(state.coins));
    localStorage.setItem('okx_egp',     state.usdToEgp);
    localStorage.setItem('okx_signals', JSON.stringify(state.signals));
    if (state.lastSignalUpdate) localStorage.setItem('okx_sig_ts', state.lastSignalUpdate);
  } catch(e) {}
}

// Load from localStorage first (instant boot), then Firebase live listener takes over
function load() {
  try { state.coins   = JSON.parse(localStorage.getItem('okx_coins')   || '[]'); } catch(e){}
  try { state.signals = JSON.parse(localStorage.getItem('okx_signals') || '{}'); } catch(e){}
  state.usdToEgp        = parseFloat(localStorage.getItem('okx_egp')    || '50') || 50;
  state.lastSignalUpdate = parseInt(localStorage.getItem('okx_sig_ts')  || '0')  || null;
}

// ═══════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════
function fmt(n, d=2) {
  if (n==null||isNaN(n)) return '---';
  return Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
}
function fmtP(p) {
  if (!p||isNaN(p)) return '---';
  if (p>=10000) return fmt(p,1);
  if (p>=1000)  return fmt(p,2);
  if (p>=1)     return fmt(p,4);
  if (p>=0.01)  return fmt(p,5);
  return fmt(p,8);
}
function sign(v) { return v>=0?'+':''; }
function pc(v)   { return v>=0?'profit':'loss'; }
function timeAgo(ts) {
  if (!ts) return 'لم يتم بعد';
  const d = Math.floor((Date.now()-ts)/1000);
  if (d<60) return `منذ ${d} ث`;
  if (d<3600) return `منذ ${Math.floor(d/60)} د`;
  return `منذ ${Math.floor(d/3600)} س`;
}

// ═══════════════════════════════════════
// API: PRICES
// ═══════════════════════════════════════
async function fetchTicker(symbol) {
  try {
    const r = await fetch(`${OKX_TICKER}?instId=${symbol.toUpperCase()}-USDT`);
    const d = await r.json();
    if (d.code==='0' && d.data?.length>0) {
      const t = d.data[0];
      return {
        price:    parseFloat(t.last),
        open24h:  parseFloat(t.sodUtc8||t.open24h||t.last),
        high24h:  parseFloat(t.high24h),
        low24h:   parseFloat(t.low24h),
        vol24h:   parseFloat(t.vol24h),
      };
    }
  } catch(e){}
  return null;
}

async function refreshPrices() {
  if (!state.coins.length) return;
  const results = await Promise.all(state.coins.map(c=>fetchTicker(c.symbol)));
  results.forEach((r,i)=>{
    if (r) state.prices[state.coins[i].symbol] = r;
  });
  state.lastPriceUpdate = Date.now();
}

// ═══════════════════════════════════════
// API: CANDLES + INDICATORS
// ═══════════════════════════════════════
async function fetchCandles(symbol) {
  try {
    const r = await fetch(`${OKX_CANDLES}?instId=${symbol.toUpperCase()}-USDT&bar=5m&limit=60`);
    const d = await r.json();
    if (d.code==='0' && d.data?.length>0) {
      return d.data.map(c=>({
        open:parseFloat(c[1]),high:parseFloat(c[2]),
        low:parseFloat(c[3]),close:parseFloat(c[4]),vol:parseFloat(c[5])
      })).reverse();
    }
  } catch(e){}
  return null;
}
function ema(cls,p) {
  if(cls.length<p)return null;
  const k=2/(p+1);
  let e=cls.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<cls.length;i++) e=cls[i]*k+e*(1-k);
  return e;
}
function rsi(cls,p=14) {
  if(cls.length<p+1)return null;
  const ch=cls.slice(1).map((c,i)=>c-cls[i]);
  let ag=0,al=0;
  for(let i=0;i<p;i++){if(ch[i]>0)ag+=ch[i];else al-=ch[i];}
  ag/=p;al/=p;
  for(let i=p;i<ch.length;i++){
    ag=(ag*(p-1)+Math.max(0,ch[i]))/p;
    al=(al*(p-1)+Math.max(0,-ch[i]))/p;
  }
  return al===0?100:100-100/(1+ag/al);
}
function atr(candles,p=14) {
  if(candles.length<p+1)return null;
  const trs=candles.slice(1).map((c,i)=>{
    const pv=candles[i];
    return Math.max(c.high-c.low,Math.abs(c.high-pv.close),Math.abs(c.low-pv.close));
  });
  return trs.slice(-p).reduce((a,b)=>a+b,0)/p;
}
function bb(cls,p=20) {
  if(cls.length<p)return null;
  const s=cls.slice(-p);
  const m=s.reduce((a,b)=>a+b,0)/p;
  const std=Math.sqrt(s.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);
  return{upper:m+2*std,middle:m,lower:m-2*std};
}
function buildSnap(symbol,candles) {
  const cls=candles.map(c=>c.close);
  const cur=candles[candles.length-1];
  const prv=candles[candles.length-2];
  const e9=ema(cls,9),e21=ema(cls,21),s20=ema(cls,20);
  const macd=e9&&e21?e9-e21:null;
  const B=bb(cls);
  const R=rsi(cls);
  const ATR=atr(candles)||cur.close*0.005;
  const volR=candles.length>=15
    ?(candles.slice(-5).reduce((a,c)=>a+c.vol,0)/5)/(candles.slice(-15,-5).reduce((a,c)=>a+c.vol,0)/10)
    :1;
  const hi20=Math.max(...candles.slice(-20).map(c=>c.high));
  const lo20=Math.min(...candles.slice(-20).map(c=>c.low));
  const ch1=prv.close>0?((cur.close-prv.close)/prv.close*100):0;
  const ch5=candles.length>5?((cur.close-candles[candles.length-6].close)/candles[candles.length-6].close*100):0;
  const ch12=candles.length>12?((cur.close-candles[candles.length-13].close)/candles[candles.length-13].close*100):0;
  return {symbol,price:cur.close,atr:ATR,
    rsi:R?.toFixed(2),
    ema9CrossUp:e9&&e21?e9>e21:null,
    priceAboveSMA:s20?cur.close>s20:null,
    macdPositive:macd?macd>0:null,
    bbPct:B?((cur.close-B.lower)/(B.upper-B.lower)*100).toFixed(1):null,
    volRatio:volR?.toFixed(2),
    resistance:hi20,support:lo20,
    candleGreen:cur.close>cur.open,
    prevGreen:prv.close>prv.open,
    bodyPct:Math.abs((cur.close-cur.open)/cur.open*100).toFixed(3),
    ch1:ch1.toFixed(3),ch5:ch5.toFixed(3),ch12:ch12.toFixed(3)
  };
}
function calcLevels(signal,snap) {
  const p=snap.price,a=snap.atr;
  if(signal==='UP')   return{entry:p,target:+(p+a*1.5).toFixed(8),stopLoss:+(p-a).toFixed(8)};
  if(signal==='DOWN') return{entry:p,target:+(p-a*1.5).toFixed(8),stopLoss:+(p+a).toFixed(8)};
  return{entry:p,target:null,stopLoss:null};
}

// ═══════════════════════════════════════
// AI ANALYSIS
// ═══════════════════════════════════════
async function callLLM7(model,snap) {
  const pr=`Crypto technical analyst. Analyze ${snap.symbol}/USDT 5min chart.
Data: Price=$${snap.price}, RSI=${snap.rsi}${snap.rsi<30?' OVERSOLD':snap.rsi>70?' OVERBOUGHT':''}, EMA9>${snap.ema9CrossUp?'EMA21 bullish':'EMA21 bearish'}, Price ${snap.priceAboveSMA?'above':'below'} SMA20, MACD ${snap.macdPositive?'positive':'negative'}, BB%=${snap.bbPct}%, VolumeRatio=${snap.volRatio}x, 1c=${snap.ch1}%, 5c=${snap.ch5}%, 12c=${snap.ch12}%, candle=${snap.candleGreen?'GREEN':'RED'} body=${snap.bodyPct}%, resistance=$${snap.resistance?.toFixed(4)}, support=$${snap.support?.toFixed(4)}
Reply ONLY valid JSON no markdown: {"signal":"UP","strength":"STRONG","confidence":75,"reason":"Arabic one sentence"}
signal=UP|DOWN|NEUTRAL, strength=STRONG|MODERATE|WEAK, confidence=0-100`;
  const res=await fetch(LLM7_API,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model,max_tokens:120,temperature:0.2,
      messages:[{role:'system',content:'Crypto analyst. JSON only.'},{role:'user',content:pr}]})
  });
  if(!res.ok) throw new Error(`${res.status}`);
  const d=await res.json();
  const txt=(d.choices?.[0]?.message?.content||'').replace(/```json|```/g,'').trim();
  return JSON.parse(txt);
}

async function analyzeOne(symbol) {
  const candles=await fetchCandles(symbol);
  if(!candles||candles.length<30) return{error:'بيانات غير كافية'};
  const snap=buildSnap(symbol,candles);
  let parsed;
  try { parsed=await callLLM7('gpt-4o-mini-2024-07-18',snap); }
  catch(e1) {
    try { parsed=await callLLM7('deepseek-chat',snap); }
    catch(e2) { return{error:'فشل الاتصال بالـ AI'}; }
  }
  const validS=['UP','DOWN','NEUTRAL'];
  const validST=['STRONG','MODERATE','WEAK'];
  const signal=validS.includes(parsed.signal)?parsed.signal:'NEUTRAL';
  const strength=validST.includes(parsed.strength)?parsed.strength:'MODERATE';
  const confidence=Math.min(100,Math.max(0,parseInt(parsed.confidence)||50));
  const reason=typeof parsed.reason==='string'?parsed.reason:'لا يوجد تفسير';
  const levels=calcLevels(signal,snap);
  return{signal,strength,confidence,reason,...levels,timeframe:'5-15 دقيقة',fetchedAt:Date.now(),priceAtSignal:snap.price};
}

async function runAllSignals() {
  if(state.analyzing||!state.coins.length) return;
  state.analyzing=true;
  renderScreen();
  for(const c of state.coins) {
    const result=await analyzeOne(c.symbol);
    state.signals[c.symbol]=result;
    save();
    if(state.currentScreen==='signals') renderScreen();
  }
  state.lastSignalUpdate=Date.now();
  state.analyzing=false;
  save();
  renderScreen();
  toast('✅ تم تحديث إشارات AI');
}

// ═══════════════════════════════════════
// RENDER: PORTFOLIO
// ═══════════════════════════════════════
function renderPortfolio() {
  const coins=state.coins, eg=state.usdToEgp;
  if(!coins.length) return `
    <div class="empty-state">
      <div class="empty-icon">📊</div>
      <div class="empty-text">لا توجد عملات بعد<br>اذهب إلى <strong>الإعدادات</strong> لإضافة عملاتك</div>
    </div>`;

  let totalCost=0,totalVal=0;
  const rows=coins.map(c=>{
    const t=state.prices[c.symbol];
    const price=t?.price??null;
    const qty=parseFloat(c.quantity)||0;
    const avg=parseFloat(c.avgBuy)||0;
    const val=price!==null?price*qty:null;
    const cost=avg*qty;
    const pnl=val!==null?val-cost:null;
    const pnlPct=cost>0&&pnl!==null?(pnl/cost*100):null;
    const ch24=t&&t.open24h>0?((price-t.open24h)/t.open24h*100):null;
    if(val!==null)totalVal+=val;
    if(cost)totalCost+=cost;
    return{...c,price,qty,avg,val,cost,pnl,pnlPct,pnlEgp:pnl!==null?pnl*eg:null,ch24};
  });
  const totalPnl=totalVal-totalCost;
  const totalPnlEgp=totalPnl*eg;
  const totalPnlPct=totalCost>0?(totalPnl/totalCost*100):0;
  const cls=pc(totalPnl);

  return `
    <div class="summary-card">
      <div class="summary-top">
        <div>
          <div class="summary-label">إجمالي المحفظة</div>
          <div class="total-value ${cls}">$${fmt(totalVal)}</div>
          <div class="total-egp">${fmt(totalVal*eg)} ج.م</div>
        </div>
        <div class="pnl-badge">
          <div class="pnl-pct-big ${cls}">${sign(totalPnlPct)}${fmt(totalPnlPct,2)}%</div>
          <div class="pnl-abs ${cls}">${sign(totalPnl)}$${fmt(Math.abs(totalPnl))}</div>
          <div class="pnl-abs">${sign(totalPnlEgp)}${fmt(Math.abs(totalPnlEgp))} ج.م</div>
        </div>
      </div>
      <div class="summary-grid">
        <div class="sum-stat">
          <div class="sum-stat-label">التكلفة</div>
          <div class="sum-stat-val">$${fmt(totalCost,0)}</div>
          <div class="sum-stat-sub">${fmt(totalCost*eg,0)} ج.م</div>
        </div>
        <div class="sum-stat">
          <div class="sum-stat-label">الربح / الخسارة</div>
          <div class="sum-stat-val ${cls}">${sign(totalPnl)}$${fmt(Math.abs(totalPnl))}</div>
          <div class="sum-stat-sub ${cls}">${sign(totalPnlEgp)}${fmt(Math.abs(totalPnlEgp))} ج.م</div>
        </div>
        <div class="sum-stat">
          <div class="sum-stat-label">عدد العملات</div>
          <div class="sum-stat-val">${coins.length}</div>
          <div class="sum-stat-sub">${state.lastPriceUpdate?'محدّث الآن':'جاري التحميل'}</div>
        </div>
      </div>
    </div>

    <div class="rate-strip">
      <span class="rate-strip-label">💱 سعر الدولار</span>
      <span class="rate-strip-val">${fmt(eg,2)} ج.م</span>
      <span class="rate-strip-time">${state.lastPriceUpdate?new Date(state.lastPriceUpdate).toLocaleTimeString('ar-EG'):''}</span>
    </div>

    <div class="section-title">
      عملاتي <span class="section-count">${coins.length}</span>
    </div>

    ${rows.map(c=>coinCard(c,eg)).join('')}`;
}

function coinCard(c,eg) {
  const ip=c.pnl!==null?c.pnl>=0:null;
  const cls=ip===null?'':ip?'profit':'loss';
  const sig=state.signals[c.symbol];

  return `<div class="coin-card ${cls}">
    <div class="coin-side-bar"></div>
    <div class="coin-main">
      <div class="coin-row1">
        <div class="coin-identity">
          <div class="coin-ava">${c.symbol.substring(0,3)}</div>
          <div>
            <div class="coin-sym">${c.symbol.toUpperCase()}</div>
            <div class="coin-pair">/ USDT</div>
            ${c.ch24!==null?`<span class="coin-change-badge ${pc(c.ch24)}">${sign(c.ch24)}${fmt(Math.abs(c.ch24),2)}%</span>`:''}
          </div>
        </div>
        <div class="coin-price-block">
          <div class="coin-price ${cls}">$${c.price!==null?fmtP(c.price):'---'}</div>
          <div class="coin-price-egp">${c.price!==null?fmt(c.price*eg,2)+' ج.م':'---'}</div>
          ${sig&&!sig.error?`<div style="font-size:10px;text-align:left;margin-top:2px;color:${sig.signal==='UP'?'var(--profit)':sig.signal==='DOWN'?'var(--loss)':'var(--gold)'}">${sig.signal==='UP'?'🟢 صاعد':sig.signal==='DOWN'?'🔴 هابط':'🟡 محايد'}</div>`:''}
        </div>
      </div>
    </div>
    <div class="coin-stats-grid">
      <div><div class="cstat-label">الكمية</div><div class="cstat-val">${fmt(c.qty,4)}</div></div>
      <div><div class="cstat-label">متوسط الشراء</div><div class="cstat-val">$${fmtP(c.avg)}</div></div>
      <div><div class="cstat-label">القيمة الحالية</div><div class="cstat-val">${c.val!==null?'$'+fmt(c.val):'---'}</div></div>
    </div>
    <div class="coin-pnl-bar">
      <div>
        <div class="coin-pnl-usd ${cls}">${c.pnl!==null?sign(c.pnl)+'$'+fmt(Math.abs(c.pnl)):'---'}</div>
        <div class="coin-pnl-egp">${c.pnlEgp!==null?sign(c.pnlEgp)+fmt(Math.abs(c.pnlEgp))+' ج.م':'---'}</div>
      </div>
      <div class="coin-pnl-pct ${ip===null?'neutral':cls}">${c.pnlPct!==null?sign(c.pnlPct)+fmt(Math.abs(c.pnlPct),2)+'%':'---'}</div>
    </div>
  </div>`;
}

// ═══════════════════════════════════════
// RENDER: AI SIGNALS
// ═══════════════════════════════════════
function renderSignals() {
  const next=state.lastSignalUpdate?Math.max(0,300-Math.floor((Date.now()-state.lastSignalUpdate)/1000)):0;
  const nm=Math.floor(next/60),ns=next%60;
  const analyzeLabel=state.analyzing?'⏳ جاري التحليل...':'⚡ تحليل الآن';

  let cards='';
  if(!state.coins.length) {
    cards=`<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">أضف عملات في الإعدادات أولاً</div></div>`;
  } else {
    cards=state.coins.map(c=>signalCard(c,state.signals[c.symbol])).join('');
  }

  return `
    <div class="ai-header-card">
      <div class="ai-top">
        <div class="ai-label"><span class="ai-dot"></span>🤖 تحليل AI المجاني</div>
        <button class="ai-analyze-btn" id="analyzeBtn" ${state.analyzing?'disabled':''}>${analyzeLabel}</button>
      </div>
      <div class="ai-meta">
        آخر تحليل: <strong>${timeAgo(state.lastSignalUpdate)}</strong>
        ${next>0?` | التالي: <strong style="color:var(--accent)">${nm}:${String(ns).padStart(2,'0')}</strong>`:''}
        <br>يستخدم GPT-4o-mini — مجاني بلا تسجيل
      </div>
    </div>
    ${cards}`;
}

function signalCard(c,s) {
  if(!s) return `
    <div class="signal-card">
      <div class="signal-top">
        <div class="sig-coin"><div class="sig-ava">${c.symbol.substring(0,3)}</div>
        <div><div class="sig-sym">${c.symbol.toUpperCase()}/USDT</div><div class="sig-time">في انتظار التحليل</div></div></div>
        <div style="font-size:24px;opacity:.3">⏳</div>
      </div>
    </div>`;

  if(s.error) return `
    <div class="signal-card">
      <div class="signal-top">
        <div class="sig-coin"><div class="sig-ava" style="color:var(--loss)">${c.symbol.substring(0,3)}</div>
        <div><div class="sig-sym">${c.symbol.toUpperCase()}/USDT</div><div class="sig-time" style="color:var(--loss)">${s.error}</div></div></div>
        <div class="sig-time">${timeAgo(s.fetchedAt)}</div>
      </div>
    </div>`;

  const up=s.signal==='UP',dn=s.signal==='DOWN';
  const cardCls=up?'up':dn?'down':'neutral';
  const badgeCls=up?'up':dn?'down':'neutral';
  const emoji=up?'📈':dn?'📉':'➡️';
  const dirAr=up?'صاعد':dn?'هابط':'محايد';
  const strAr=s.strength==='STRONG'?'قوي':s.strength==='MODERATE'?'متوسط':'ضعيف';
  const confColor=s.confidence>=75?'var(--profit)':s.confidence>=50?'var(--gold)':'var(--loss)';

  return `
    <div class="signal-card ${cardCls}">
      <div class="signal-top">
        <div class="sig-coin">
          <div class="sig-ava">${c.symbol.substring(0,3)}</div>
          <div>
            <div class="sig-sym">${c.symbol.toUpperCase()}/USDT</div>
            <div class="sig-time">${timeAgo(s.fetchedAt)}</div>
          </div>
        </div>
        <div class="sig-badge-wrap">
          <div class="sig-main ${badgeCls}">${emoji} ${dirAr}</div>
          <div class="sig-str">${strAr} • ${s.confidence}%</div>
        </div>
      </div>
      <div class="sig-conf-row">
        <span class="conf-label">الثقة</span>
        <div class="conf-track"><div class="conf-fill" style="width:${s.confidence}%;background:${confColor}"></div></div>
        <span class="conf-pct" style="color:${confColor}">${s.confidence}%</span>
      </div>
      <div class="sig-reason">${s.reason||''}</div>
      ${s.entry?`
      <div class="sig-levels">
        <div class="sig-level"><div class="sig-level-label">دخول</div><div class="sig-level-val neutral">$${fmtP(s.entry)}</div></div>
        <div class="sig-level"><div class="sig-level-label">هدف</div><div class="sig-level-val ${up?'profit':'loss'}">$${fmtP(s.target)}</div></div>
        <div class="sig-level"><div class="sig-level-label">وقف</div><div class="sig-level-val ${up?'loss':'profit'}">$${fmtP(s.stopLoss)}</div></div>
        <div class="sig-level"><div class="sig-level-label">إطار</div><div class="sig-level-val neutral">5-15د</div></div>
      </div>`:``}
    </div>`;
}

// ═══════════════════════════════════════
// RENDER: SETTINGS
// ═══════════════════════════════════════
function renderSettings() {
  return `
    <div class="settings-section">
      <div class="settings-section-title">💱 الإعدادات العامة</div>
      <div class="setting-row">
        <div><div class="setting-label">سعر الدولار</div><div class="setting-sub">بالجنيه المصري</div></div>
        <input class="setting-input" id="egpInput" type="number" value="${state.usdToEgp}" step="0.5" min="1" placeholder="50">
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">🪙 عملاتي (${state.coins.length})</div>
      ${state.coins.length===0?`<div style="padding:16px;text-align:center;color:var(--text3);font-size:13px;">لا توجد عملات بعد</div>`:''}
      ${state.coins.map((c,i)=>`
        <div class="coin-row-item">
          <div class="coin-row-ava">${c.symbol.substring(0,3)}</div>
          <div class="coin-row-info">
            <div class="coin-row-sym">${c.symbol.toUpperCase()}/USDT</div>
            <div class="coin-row-meta">الكمية: ${c.quantity} | شراء: $${c.avgBuy}</div>
          </div>
          <div class="del-btn" data-del="${i}">🗑️</div>
        </div>`).join('')}
    </div>

    <div class="add-form">
      <div class="add-form-title">➕ إضافة عملة جديدة</div>
      <div class="form-grid">
        <div class="form-field">
          <label>رمز العملة</label>
          <input id="fSymbol" type="text" placeholder="BTC, ETH, SOL..." autocomplete="off" autocorrect="off" spellcheck="false">
        </div>
        <div class="form-field">
          <label>الكمية</label>
          <input id="fQty" type="number" placeholder="0.5" step="any" min="0" inputmode="decimal">
        </div>
      </div>
      <div class="form-grid">
        <div class="form-field">
          <label>متوسط الشراء ($)</label>
          <input id="fAvg" type="number" placeholder="45000" step="any" min="0" inputmode="decimal">
        </div>
        <div class="form-field" style="display:flex;align-items:flex-end;">
          <button class="add-btn" id="addCoinBtn">➕ إضافة</button>
        </div>
      </div>
    </div>

    <button class="save-btn" id="saveSettingsBtn">💾 حفظ الإعدادات</button>

    <div style="background:rgba(0,229,184,.05);border:1px solid rgba(0,229,184,.15);border-radius:12px;padding:12px 14px;font-size:11px;color:var(--text3);line-height:1.9;">
      🔥 <strong style="color:#ff6d00">Firebase</strong> Realtime Database — بياناتك محفوظة على السحابة<br>
      <span id="dbStatus">🟡 جاري الاتصال...</span><br>
      🤖 <strong style="color:var(--accent)">AI مجاني تماماً</strong> — لا يلزم أي تسجيل أو مفتاح<br>
      🌐 يستخدم LLM7.io مع GPT-4o-mini و DeepSeek<br>
      ⏱️ تحليل تلقائي كل <strong style="color:var(--accent)">5 دقائق</strong> من تبويب إشارات AI<br>
      📱 أضف التطبيق للشاشة الرئيسية لتجربة أفضل
    </div>`;
}

// ═══════════════════════════════════════
// MAIN RENDER
// ═══════════════════════════════════════
function renderScreen() {
  const el=document.getElementById('mainScreen');
  if(!el) return;
  switch(state.currentScreen) {
    case 'portfolio': el.innerHTML=renderPortfolio(); break;
    case 'signals':   el.innerHTML=renderSignals();   wireSignalsEvents(); break;
    case 'settings':  el.innerHTML=renderSettings();  wireSettingsEvents(); break;
  }
}

function wireSignalsEvents() {
  const btn=document.getElementById('analyzeBtn');
  if(btn) btn.addEventListener('click',()=>{ runAllSignals(); });
}

function wireSettingsEvents() {
  // Delete coin buttons
  document.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const i=parseInt(btn.dataset.del);
      const sym=state.coins[i].symbol;
      state.coins.splice(i,1);
      delete state.signals[sym];
      save(); renderScreen();
      toast(`تم حذف ${sym}`);
    });
  });

  // Add coin
  const addBtn=document.getElementById('addCoinBtn');
  if(addBtn) addBtn.addEventListener('click',addCoin);

  // Save settings
  const saveBtn=document.getElementById('saveSettingsBtn');
  if(saveBtn) saveBtn.addEventListener('click',saveSettingsHandler);

  // Symbol uppercase
  const symInput=document.getElementById('fSymbol');
  if(symInput) symInput.addEventListener('input',e=>{ e.target.value=e.target.value.toUpperCase(); });
}

function addCoin() {
  const symbol=(document.getElementById('fSymbol')?.value||'').trim().toUpperCase();
  const quantity=(document.getElementById('fQty')?.value||'').trim();
  const avgBuy=(document.getElementById('fAvg')?.value||'').trim();
  if(!symbol) return toast('أدخل رمز العملة',true);
  if(!quantity||isNaN(quantity)||+quantity<=0) return toast('أدخل الكمية',true);
  if(!avgBuy||isNaN(avgBuy)||+avgBuy<=0) return toast('أدخل سعر الشراء',true);
  const exists=state.coins.findIndex(c=>c.symbol===symbol);
  if(exists>=0) { state.coins[exists]={symbol,quantity,avgBuy}; toast(`تم تحديث ${symbol} ✅`); }
  else          { state.coins.push({symbol,quantity,avgBuy});   toast(`تمت إضافة ${symbol} ✅`); }
  save(); renderScreen();
}

function saveSettingsHandler() {
  const v=parseFloat(document.getElementById('egpInput')?.value||50);
  if(!isNaN(v)&&v>0) state.usdToEgp=v;
  save(); toast('تم الحفظ ✅');
  setTimeout(()=>renderScreen(),800);
}

// ═══════════════════════════════════════
// TOAST
// ═══════════════════════════════════════
function toast(msg,isErr=false) {
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.className='toast'+(isErr?' err':'');
  setTimeout(()=>t.classList.add('show'),10);
  setTimeout(()=>t.classList.remove('show'),2500);
}

// ═══════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════
function initNav() {
  document.querySelectorAll('.nav-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      state.currentScreen=btn.dataset.screen;
      renderScreen();
    });
  });
  document.getElementById('refreshBtn')?.addEventListener('click',async ()=>{
    const btn=document.getElementById('refreshBtn');
    btn.classList.add('spin');
    await refreshPrices();
    btn.classList.remove('spin');
    renderScreen();
    toast('تم التحديث ✅');
  });
}

// ═══════════════════════════════════════
// AUTO REFRESH
// ═══════════════════════════════════════
function startAutoRefresh() {
  // Prices every 3 seconds
  setInterval(async()=>{
    await refreshPrices();
    if(state.currentScreen==='portfolio') renderScreen();
  }, 3000);

  // AI signals every 5 minutes
  setInterval(()=>{
    const age=state.lastSignalUpdate?Date.now()-state.lastSignalUpdate:Infinity;
    if(age>5*60*1000) runAllSignals();
  }, 60*1000);

  // Countdown timer in signals tab
  setInterval(()=>{
    if(state.currentScreen==='signals'&&!state.analyzing) renderScreen();
  }, 10000);
}

// ═══════════════════════════════════════
// SERVICE WORKER
// ═══════════════════════════════════════
function registerSW() {
  if('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}

// ═══════════════════════════════════════
// BOOT
// ═══════════════════════════════════════
window.addEventListener('DOMContentLoaded', async ()=>{
  load();           // instant boot from localStorage
  initNav();
  renderScreen();
  initFirebase();   // connect Firebase (live listener will update state)
  await refreshPrices();
  renderScreen();
  startAutoRefresh();
  registerSW();

  // Auto-run AI if data is stale
  const age = state.lastSignalUpdate ? Date.now()-state.lastSignalUpdate : Infinity;
  if (age > 5*60*1000 && state.coins.length > 0) {
    setTimeout(runAllSignals, 3000);
  }
});
