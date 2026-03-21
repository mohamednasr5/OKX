// OKX Tracker PWA - app.js
'use strict';

// ═══════════════════════════════════════
// CONFIG & STATE
// ═══════════════════════════════════════
const OKX_TICKER  = 'https://www.okx.com/api/v5/market/ticker';
const OKX_CANDLES = 'https://www.okx.com/api/v5/market/candles';

let state = {
  coins: [],
  usdToEgp: 50,
  alertAt: 10,          // تنبيه كل $ زيادة في الربح
  prices: {},
  signals: {},
  lastSignalUpdate: null,
  currentScreen: 'portfolio',
  analyzing: false,
  lastPriceUpdate: null,
  alertFired: {},       // لتتبع التنبيهات اللي اتعملت
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

let dbRef   = null;
let isSaving = false;

function initFirebase() {
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    const db = firebase.database();
    dbRef = db.ref('settings');

    dbRef.on('value', snap => {
      const data = snap.val();
      if (!data) return;
      if (isSaving) return;
      if (Array.isArray(data.coins))  state.coins            = data.coins;
      if (data.usdToEgp)              state.usdToEgp         = parseFloat(data.usdToEgp) || 50;
      if (data.alertAt != null)       state.alertAt          = parseFloat(data.alertAt)  || 10;
      if (data.signals)               state.signals          = data.signals;
      if (data.lastSignalUpdate)      state.lastSignalUpdate = data.lastSignalUpdate;
      localSave();
      renderScreen();
    }, err => console.warn('Firebase listener error:', err));

    showDbStatus('🟢 متصل بقاعدة البيانات');
  } catch(e) {
    console.warn('Firebase init failed:', e);
    showDbStatus('🟡 وضع عدم الاتصال');
  }
}

function showDbStatus(msg) {
  const el = document.getElementById('dbStatus');
  if (el) el.textContent = msg;
}

// ═══════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════
async function save() {
  localSave();
  if (!dbRef) return;
  try {
    isSaving = true;
    await dbRef.set({
      coins:            state.coins,
      usdToEgp:         state.usdToEgp,
      alertAt:          state.alertAt,
      signals:          state.signals,
      lastSignalUpdate: state.lastSignalUpdate || null,
      updatedAt:        Date.now(),
    });
  } catch(e) {
    console.warn('Firebase save error:', e);
    showDbStatus('🔴 خطأ في الحفظ');
  } finally {
    setTimeout(() => { isSaving = false; }, 1500);
  }
}

function localSave() {
  try {
    localStorage.setItem('okx_coins',   JSON.stringify(state.coins));
    localStorage.setItem('okx_egp',     state.usdToEgp);
    localStorage.setItem('okx_alertAt', state.alertAt);
    localStorage.setItem('okx_signals', JSON.stringify(state.signals));
    if (state.lastSignalUpdate) localStorage.setItem('okx_sig_ts', state.lastSignalUpdate);
  } catch(e) {}
}

function load() {
  try { state.coins   = JSON.parse(localStorage.getItem('okx_coins')   || '[]'); } catch(e){}
  try { state.signals = JSON.parse(localStorage.getItem('okx_signals') || '{}'); } catch(e){}
  state.usdToEgp        = parseFloat(localStorage.getItem('okx_egp')     || '50') || 50;
  state.alertAt         = parseFloat(localStorage.getItem('okx_alertAt') || '10') || 10;
  state.lastSignalUpdate = parseInt(localStorage.getItem('okx_sig_ts')   || '0')  || null;
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
// PROFIT ALERT — صوت + إشعار + بانر
// ═══════════════════════════════════════
function playProfitSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [523, 659, 784, 1047].forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.13;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  } catch(e) {}
}

function sendNotification(title, body) {
  if (!('Notification' in window)) return;
  const go = () => { try { new Notification(title, { body }); } catch(e) {} };
  if (Notification.permission === 'granted') go();
  else if (Notification.permission !== 'denied')
    Notification.requestPermission().then(p => { if (p==='granted') go(); });
}

function checkProfitAlert(totalPnl) {
  const thr = state.alertAt;
  if (!thr || thr <= 0 || totalPnl <= 0) return;

  const level = Math.floor(totalPnl / thr);
  if (level <= 0) return;

  // reset fired levels لو الربح اتراجع
  const maxFiredLevel = Math.max(0, ...Object.keys(state.alertFired).map(k => parseInt(k.replace('lv','')) || 0));
  if (level < maxFiredLevel) state.alertFired = {};

  const key = 'lv' + level;
  if (state.alertFired[key]) return;
  state.alertFired[key] = true;

  const earned    = (level * thr).toFixed(0);
  const earnedEGP = (level * thr * state.usdToEgp).toFixed(0);

  playProfitSound();
  toast(`🎉 مبروك! ربحت $${earned} — ${Number(earnedEGP).toLocaleString()} جنيه!`, false, true);
  sendNotification('💰 تهانينا!', `محفظتك ربحت $${earned} ≈ ${Number(earnedEGP).toLocaleString()} جنيه 🚀`);
  showProfitBanner(earned, earnedEGP);
}

function showProfitBanner(usd, egp) {
  const old = document.getElementById('profitBanner');
  if (old) old.remove();

  const b = document.createElement('div');
  b.id = 'profitBanner';
  b.className = 'profit-alert-banner';
  b.innerHTML = `
    <div class="alert-icon">🎉</div>
    <div style="flex:1">
      <div class="alert-text-big">مبروك! ربحت $${usd}</div>
      <div class="alert-text-sub">≈ ${Number(egp).toLocaleString()} جنيه مصري — استمر! 🚀</div>
    </div>
    <div class="alert-close" onclick="this.parentElement.remove()">✕</div>`;

  const sc = document.getElementById('mainScreen');
  if (!sc) return;
  const rs = sc.querySelector('.rate-strip');
  if (rs) rs.insertAdjacentElement('afterend', b);
  else sc.prepend(b);
  setTimeout(() => { if (b.parentElement) b.remove(); }, 12000);
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
        price:   parseFloat(t.last),
        open24h: parseFloat(t.sodUtc8||t.open24h||t.last),
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
  results.forEach((r, i) => {
    if (r) state.prices[state.coins[i].symbol] = r;
  });
  state.lastPriceUpdate = Date.now();

  // حساب الربح الكلي وتشغيل التنبيه
  let totalPnl = 0;
  state.coins.forEach(c => {
    const t   = state.prices[c.symbol];
    const price = t?.price ?? 0;
    const qty   = parseFloat(c.quantity) || 0;
    const avg   = parseFloat(c.avgBuy)   || 0;
    totalPnl   += (price - avg) * qty;
  });
  if (totalPnl > 0) checkProfitAlert(totalPnl);
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
  } catch(e) {}
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
    rsi:R?.toFixed(2),rsiVal:R,
    ema9CrossUp:e9&&e21?e9>e21:null,
    priceAboveSMA:s20?cur.close>s20:null,
    macdPositive:macd?macd>0:null,
    bbPct:B?((cur.close-B.lower)/(B.upper-B.lower)*100).toFixed(1):null,
    bbPctVal:B?((cur.close-B.lower)/(B.upper-B.lower)*100):null,
    volRatio:volR?.toFixed(2),volRatioVal:volR,
    resistance:hi20,support:lo20,
    candleGreen:cur.close>cur.open,
    prevGreen:prv.close>prv.open,
    bodyPct:Math.abs((cur.close-cur.open)/cur.open*100).toFixed(3),
    ch1:ch1.toFixed(3),ch5:ch5.toFixed(3),ch12:ch12.toFixed(3),
    ch1Val:ch1,ch5Val:ch5,
  };
}
function calcLevels(signal,snap) {
  const p=snap.price,a=snap.atr;
  if(signal==='UP')   return{entry:p,target:+(p+a*1.5).toFixed(8),stopLoss:+(p-a).toFixed(8)};
  if(signal==='DOWN') return{entry:p,target:+(p-a*1.5).toFixed(8),stopLoss:+(p+a).toFixed(8)};
  return{entry:p,target:null,stopLoss:null};
}

// ═══════════════════════════════════════
// AI ANALYSIS — بالعامية المصرية 100%
// ═══════════════════════════════════════

// بيبني وصف مصري للمؤشرات بدل الإنجليزي
function buildArabicContext(snap, coin) {
  const qty = parseFloat(coin.quantity) || 0;
  const avg = parseFloat(coin.avgBuy)   || 0;
  const pnl = snap.price && avg ? ((snap.price - avg) / avg * 100) : null;
  const pnlUSD = snap.price ? (snap.price - avg) * qty : null;
  const pnlEGP = pnlUSD ? (pnlUSD * state.usdToEgp) : null;

  const rsiDesc = snap.rsiVal != null
    ? (snap.rsiVal < 30 ? `RSI عند ${snap.rsi} — العملة في منطقة تشبع بيعي قوي`
      : snap.rsiVal > 70 ? `RSI عند ${snap.rsi} — العملة في منطقة تشبع شرائي`
      : `RSI عند ${snap.rsi} — محايد`)
    : '';

  const emaDesc = snap.ema9CrossUp != null
    ? (snap.ema9CrossUp ? 'المتوسط المتحرك السريع (9) فوق البطيء (21) — إشارة صعود'
      : 'المتوسط المتحرك السريع (9) تحت البطيء (21) — إشارة هبوط')
    : '';

  const smaDesc = snap.priceAboveSMA != null
    ? (snap.priceAboveSMA ? 'السعر فوق المتوسط المتحرك 20 — اتجاه إيجابي'
      : 'السعر تحت المتوسط المتحرك 20 — اتجاه سلبي')
    : '';

  const macdDesc = snap.macdPositive != null
    ? (snap.macdPositive ? 'الـ MACD موجب — زخم صاعد' : 'الـ MACD سالب — زخم هابط')
    : '';

  const bbDesc = snap.bbPctVal != null
    ? (snap.bbPctVal < 20 ? 'السعر قرب الحد الأدنى لـ Bollinger Bands — منطقة شراء محتملة'
      : snap.bbPctVal > 80 ? 'السعر قرب الحد الأعلى لـ Bollinger Bands — منطقة بيع محتملة'
      : 'السعر في منتصف نطاق Bollinger Bands')
    : '';

  const volDesc = snap.volRatioVal != null
    ? (snap.volRatioVal > 1.5 ? 'حجم التداول مرتفع جداً — حركة قوية'
      : snap.volRatioVal < 0.7 ? 'حجم التداول منخفض — حركة ضعيفة'
      : 'حجم التداول عادي')
    : '';

  const candleDesc = snap.candleGreen
    ? `الشمعة الحالية خضرا (صاعدة) بحجم جسم ${snap.bodyPct}%`
    : `الشمعة الحالية حمرا (هابطة) بحجم جسم ${snap.bodyPct}%`;

  const posDesc = pnlUSD != null
    ? `المستخدم شايل ${qty} وحدة بمتوسط $${fmtP(avg)}، وضعه الحالي: ${pnl >= 0 ? 'ربح' : 'خسارة'} ${Math.abs(pnl).toFixed(2)}% يعني $${Math.abs(pnlUSD).toFixed(2)} (≈ ${Math.abs(pnlEGP).toFixed(0)} جنيه).`
    : `المستخدم شايل ${qty} وحدة بمتوسط $${fmtP(avg)}.`;

  return `
بيانات العملة ${snap.symbol}/USDT:
- السعر الحالي: $${fmtP(snap.price)}
- التغيير آخر شمعة: ${snap.ch1}% | آخر 5 شمعات: ${snap.ch5}%
- ${rsiDesc}
- ${emaDesc}
- ${smaDesc}
- ${macdDesc}
- ${bbDesc}
- ${volDesc}
- ${candleDesc}
- مستوى المقاومة: $${fmtP(snap.resistance)} | الدعم: $${fmtP(snap.support)}
- ${posDesc}
سعر الدولار: ${state.usdToEgp} جنيه مصري`.trim();
}

async function callAI(snap, coin) {
  const context = buildArabicContext(snap, coin);

  const systemMsg = `أنت "أستاذ كريبتو" — مستشار عملات رقمية مصري خبير وصريح جداً.
قواعد صارمة جداً لازم تتبعها:
١- تتكلم عامية مصرية 100% في كل حرف — ممنوع أي إنجليزي في الشرح خالص.
٢- ممنوع تكتب جمل تقنية بالإنجليزي زي "Price is below SMA" أو "RSI is low" أو "EMA cross" — قول ده كله بالعربي المصري.
٣- ابعت JSON فقط بدون أي نص تاني.`;

  const userMsg = `${context}

مطلوب منك:
١- اشرح بالعامية المصرية إيه اللي بيحصل في العملة دي دلوقتي في السوق.
٢- قول وضع المستخدم — ربحان ولا خسران وبكام جنيه تقريباً.
٣- دي توصيتك الصريحة: اشتري / بيع / استنى ولييه.

ابعت JSON بس بالشكل ده:
{"signal":"UP","strength":"STRONG","confidence":78,"reason":"شرح بالعامية المصرية 100% — جملتين أو تلاتة تصف السوق وحالة المستخدم والتوصية"}

signal = UP أو DOWN أو NEUTRAL
strength = STRONG أو MODERATE أو WEAK
confidence = رقم من 55 لـ 92
reason = عامية مصرية فقط — ممنوع إنجليزي`;

  // بنجرب Claude Sonnet أول، لو فشل بنجرب LLM7
  const apis = [
    {
      url: 'https://api.anthropic.com/v1/messages',
      buildBody: () => JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: systemMsg,
        messages: [{ role: 'user', content: userMsg }]
      }),
      parseResp: async (r) => {
        const d = await r.json();
        const txt = (d.content||[]).map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();
        return JSON.parse(txt.match(/\{[\s\S]*\}/)[0]);
      },
      headers: { 'Content-Type': 'application/json' }
    },
    {
      url: 'https://api.llm7.io/v1/chat/completions',
      buildBody: () => JSON.stringify({
        model: 'gpt-4o-mini-2024-07-18',
        max_tokens: 200,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user',   content: userMsg   }
        ]
      }),
      parseResp: async (r) => {
        const d = await r.json();
        const txt = (d.choices?.[0]?.message?.content||'').replace(/```json|```/g,'').trim();
        return JSON.parse(txt.match(/\{[\s\S]*\}/)[0]);
      },
      headers: { 'Content-Type': 'application/json' }
    },
    {
      url: 'https://api.llm7.io/v1/chat/completions',
      buildBody: () => JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 200,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user',   content: userMsg   }
        ]
      }),
      parseResp: async (r) => {
        const d = await r.json();
        const txt = (d.choices?.[0]?.message?.content||'').replace(/```json|```/g,'').trim();
        return JSON.parse(txt.match(/\{[\s\S]*\}/)[0]);
      },
      headers: { 'Content-Type': 'application/json' }
    },
  ];

  for (const api of apis) {
    try {
      const r = await fetch(api.url, {
        method: 'POST',
        headers: api.headers,
        body: api.buildBody()
      });
      if (!r.ok) continue;
      const parsed = await api.parseResp(r);
      return parsed;
    } catch(e) {
      continue;
    }
  }
  throw new Error('فشل الاتصال بالـ AI');
}

async function analyzeOne(coin) {
  const candles = await fetchCandles(coin.symbol);
  if (!candles || candles.length < 30) return { error: 'بيانات غير كافية' };
  const snap = buildSnap(coin.symbol, candles);

  let parsed;
  try {
    parsed = await callAI(snap, coin);
  } catch(e) {
    return { error: 'فشل الاتصال بالـ AI' };
  }

  const validS  = ['UP','DOWN','NEUTRAL'];
  const validST = ['STRONG','MODERATE','WEAK'];
  const signal     = validS.includes(parsed.signal)     ? parsed.signal     : 'NEUTRAL';
  const strength   = validST.includes(parsed.strength)  ? parsed.strength   : 'MODERATE';
  const confidence = Math.min(92, Math.max(55, parseInt(parsed.confidence)||65));
  const reason     = typeof parsed.reason === 'string'  ? parsed.reason     : 'لا يوجد تفسير';
  const levels     = calcLevels(signal, snap);
  return { signal, strength, confidence, reason, ...levels, timeframe:'5-15 دقيقة', fetchedAt:Date.now(), priceAtSignal:snap.price };
}

async function runAllSignals() {
  if (state.analyzing || !state.coins.length) return;
  state.analyzing = true;
  renderScreen();
  for (const c of state.coins) {
    const result = await analyzeOne(c);
    state.signals[c.symbol] = result;
    save();
    if (state.currentScreen === 'signals') renderScreen();
  }
  state.lastSignalUpdate = Date.now();
  state.analyzing = false;
  save();
  renderScreen();
  toast('✅ تم تحديث إشارات AI');
}

// ═══════════════════════════════════════
// EDIT MODAL
// ═══════════════════════════════════════
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
  setTimeout(() => document.getElementById('editQty')?.focus(), 350);
}

function closeEditModal(e) {
  if (e && e.target !== document.getElementById('editModal')) return;
  document.getElementById('editModal').classList.remove('open');
  _editIdx = null;
}

function saveEdit() {
  if (_editIdx === null) return;
  const qty = document.getElementById('editQty')?.value?.trim();
  const avg = document.getElementById('editAvg')?.value?.trim();
  if (!qty || isNaN(qty) || +qty <= 0) { toast('⚠️ الكمية لازم أكبر من صفر!', true); return; }
  if (!avg || isNaN(avg) || +avg <= 0) { toast('⚠️ سعر الشراء لازم صحيح!',   true); return; }
  state.coins[_editIdx].quantity = qty;
  state.coins[_editIdx].avgBuy   = avg;
  save();
  document.getElementById('editModal').classList.remove('open');
  _editIdx = null;
  renderScreen();
  toast('✅ تم حفظ التعديل!');
}

function deleteFromModal() {
  if (_editIdx === null) return;
  const sym = state.coins[_editIdx].symbol;
  state.coins.splice(_editIdx, 1);
  delete state.signals[sym];
  save();
  document.getElementById('editModal').classList.remove('open');
  _editIdx = null;
  renderScreen();
  toast('🗑️ تم حذف ' + sym);
}

// اجعل الدوال global عشان onclick في الـ HTML يشتغل
window.openEditModal   = openEditModal;
window.closeEditModal  = closeEditModal;
window.saveEdit        = saveEdit;
window.deleteFromModal = deleteFromModal;

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeEditModal(); });

// ═══════════════════════════════════════
// RENDER: PORTFOLIO
// ═══════════════════════════════════════
function renderPortfolio() {
  const coins = state.coins, eg = state.usdToEgp;
  if (!coins.length) return `
    <div class="empty-state">
      <div class="empty-icon">📊</div>
      <div class="empty-text">لا توجد عملات بعد<br>اذهب إلى <strong>الإعدادات</strong> لإضافة عملاتك</div>
    </div>`;

  let totalCost=0, totalVal=0;
  const rows = coins.map(c => {
    const t      = state.prices[c.symbol];
    const price  = t?.price ?? null;
    const qty    = parseFloat(c.quantity) || 0;
    const avg    = parseFloat(c.avgBuy)   || 0;
    const val    = price !== null ? price * qty : null;
    const cost   = avg * qty;
    const pnl    = val !== null ? val - cost : null;
    const pnlPct = cost>0 && pnl!==null ? (pnl/cost*100) : null;
    const ch24   = t && t.open24h>0 ? ((price-t.open24h)/t.open24h*100) : null;
    if (val  !== null) totalVal  += val;
    if (cost)          totalCost += cost;
    return {...c, price, qty, avg, val, cost, pnl, pnlPct, pnlEgp: pnl!==null ? pnl*eg : null, ch24};
  });

  const totalPnl    = totalVal - totalCost;
  const totalPnlEgp = totalPnl * eg;
  const totalPnlPct = totalCost > 0 ? (totalPnl/totalCost*100) : 0;
  const cls = pc(totalPnl);

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
      <span class="rate-strip-time">${state.lastPriceUpdate ? new Date(state.lastPriceUpdate).toLocaleTimeString('ar-EG') : ''}</span>
    </div>

    <div class="section-title">
      عملاتي <span class="section-count">${coins.length}</span>
    </div>

    ${rows.map((c,i) => coinCard(c, eg, i)).join('')}`;
}

function coinCard(c, eg, idx) {
  const ip  = c.pnl !== null ? c.pnl >= 0 : null;
  const cls = ip === null ? '' : ip ? 'profit' : 'loss';
  const sig = state.signals[c.symbol];

  return `<div class="coin-card ${cls}">
    <div class="coin-side-bar"></div>
    <div class="coin-main">
      <div class="coin-row1">
        <div class="coin-identity">
          <div class="coin-ava">${c.symbol.substring(0,3)}</div>
          <div>
            <div class="coin-sym">${c.symbol.toUpperCase()}</div>
            <div class="coin-pair">/ USDT</div>
            ${c.ch24 !== null ? `<span class="coin-change-badge ${pc(c.ch24)}">${sign(c.ch24)}${fmt(Math.abs(c.ch24),2)}%</span>` : ''}
          </div>
        </div>
        <div class="coin-price-block">
          <div class="coin-price ${cls}">$${c.price!==null ? fmtP(c.price) : '---'}</div>
          <div class="coin-price-egp">${c.price!==null ? fmt(c.price*eg,2)+' ج.م' : '---'}</div>
          ${sig && !sig.error ? `<div style="font-size:10px;text-align:left;margin-top:2px;color:${sig.signal==='UP'?'var(--profit)':sig.signal==='DOWN'?'var(--loss)':'var(--gold)'}">${sig.signal==='UP'?'🟢 صاعد':sig.signal==='DOWN'?'🔴 هابط':'🟡 محايد'}</div>` : ''}
        </div>
      </div>
    </div>
    <div class="coin-stats-grid">
      <div><div class="cstat-label">الكمية</div><div class="cstat-val">${fmt(c.qty,4)}</div></div>
      <div><div class="cstat-label">متوسط الشراء</div><div class="cstat-val">$${fmtP(c.avg)}</div></div>
      <div><div class="cstat-label">القيمة الحالية</div><div class="cstat-val">${c.val!==null ? '$'+fmt(c.val) : '---'}</div></div>
    </div>
    <div class="coin-pnl-bar">
      <div>
        <div class="coin-pnl-usd ${cls}">${c.pnl!==null ? sign(c.pnl)+'$'+fmt(Math.abs(c.pnl)) : '---'}</div>
        <div class="coin-pnl-egp">${c.pnlEgp!==null ? sign(c.pnlEgp)+fmt(Math.abs(c.pnlEgp))+' ج.م' : '---'}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="coin-pnl-pct ${ip===null?'neutral':cls}">${c.pnlPct!==null ? sign(c.pnlPct)+fmt(Math.abs(c.pnlPct),2)+'%' : '---'}</div>
        <div class="edit-btn" onclick="openEditModal(${idx})" title="تعديل">✏️</div>
      </div>
    </div>
  </div>`;
}

// ═══════════════════════════════════════
// RENDER: AI SIGNALS
// ═══════════════════════════════════════
function renderSignals() {
  const next = state.lastSignalUpdate ? Math.max(0, 300-Math.floor((Date.now()-state.lastSignalUpdate)/1000)) : 0;
  const nm = Math.floor(next/60), ns = next%60;
  const analyzeLabel = state.analyzing ? '⏳ جاري التحليل...' : '⚡ تحليل الآن';

  let cards = '';
  if (!state.coins.length) {
    cards = `<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">أضف عملات في الإعدادات أولاً</div></div>`;
  } else {
    cards = state.coins.map(c => signalCard(c, state.signals[c.symbol])).join('');
  }

  return `
    <div class="ai-header-card">
      <div class="ai-top">
        <div class="ai-label"><span class="ai-dot"></span>🤖 مستشار AI المصري</div>
        <button class="ai-analyze-btn" id="analyzeBtn" ${state.analyzing?'disabled':''}>${analyzeLabel}</button>
      </div>
      <div class="ai-meta">
        آخر تحليل: <strong>${timeAgo(state.lastSignalUpdate)}</strong>
        ${next>0 ? ` | التالي: <strong style="color:var(--accent)">${nm}:${String(ns).padStart(2,'0')}</strong>` : ''}
        <br>تحليل بالعامية المصرية — مجاني بلا تسجيل
      </div>
      <div class="ai-disclaimer">⚠️ التحليل للاسترشاد فقط — مش نصيحة مالية رسمية.</div>
    </div>
    ${cards}`;
}

function signalCard(c, s) {
  if (!s) return `
    <div class="signal-card">
      <div class="signal-top">
        <div class="sig-coin">
          <div class="sig-ava">${c.symbol.substring(0,3)}</div>
          <div><div class="sig-sym">${c.symbol.toUpperCase()}/USDT</div><div class="sig-time">في انتظار التحليل</div></div>
        </div>
        <div style="font-size:24px;opacity:.3">⏳</div>
      </div>
    </div>`;

  if (s.error) return `
    <div class="signal-card">
      <div class="signal-top">
        <div class="sig-coin">
          <div class="sig-ava" style="color:var(--loss)">${c.symbol.substring(0,3)}</div>
          <div><div class="sig-sym">${c.symbol.toUpperCase()}/USDT</div><div class="sig-time" style="color:var(--loss)">${s.error}</div></div>
        </div>
      </div>
    </div>`;

  const up  = s.signal==='UP', dn = s.signal==='DOWN';
  const cardCls  = up ? 'buy' : dn ? 'sell' : 'wait';
  const emoji    = up ? '🟢 اشتري' : dn ? '🔴 بيع' : '🟡 استنى';
  const strAr    = s.strength==='STRONG' ? 'قوي' : s.strength==='MODERATE' ? 'متوسط' : 'ضعيف';
  const confColor= s.confidence>=75 ? 'var(--profit)' : s.confidence>=55 ? 'var(--gold)' : 'var(--loss)';

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
          <div class="sig-main ${cardCls}">${emoji}</div>
          <div class="sig-str">${strAr} · ${s.confidence}% ثقة</div>
        </div>
      </div>
      <div class="sig-conf-row">
        <span class="conf-label">الثقة</span>
        <div class="conf-track"><div class="conf-fill ${cardCls}" style="width:${s.confidence}%"></div></div>
        <span class="conf-pct" style="color:${confColor}">${s.confidence}%</span>
      </div>
      <div class="sig-reason">${s.reason || ''}</div>
      ${s.entry ? `
      <div class="sig-levels">
        <div class="sig-level"><div class="sig-level-label">دخول</div><div class="sig-level-val neutral">$${fmtP(s.entry)}</div></div>
        <div class="sig-level"><div class="sig-level-label">هدف</div><div class="sig-level-val profit">$${fmtP(s.target)}</div></div>
        <div class="sig-level"><div class="sig-level-label">وقف</div><div class="sig-level-val loss">$${fmtP(s.stopLoss)}</div></div>
        <div class="sig-level"><div class="sig-level-label">إطار</div><div class="sig-level-val neutral">5-15د</div></div>
      </div>` : ''}
    </div>`;
}

// ═══════════════════════════════════════
// RENDER: SETTINGS
// ═══════════════════════════════════════
function renderSettings() {
  return `
    <div class="settings-section">
      <div class="settings-section-title">⚙️ الإعدادات العامة</div>
      <div class="setting-row">
        <div><div class="setting-label">سعر الدولار</div><div class="setting-sub">بالجنيه المصري</div></div>
        <input class="setting-input" id="egpInput" type="number" value="${state.usdToEgp}" step="0.5" min="1" placeholder="50">
      </div>
      <div class="setting-row">
        <div><div class="setting-label">🔔 تنبيه ربح كل ($)</div><div class="setting-sub">صوت وإشعار كل ما تكسب المبلغ ده</div></div>
        <input class="setting-input" id="alertInput" type="number" value="${state.alertAt}" step="1" min="1" placeholder="10">
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">🪙 عملاتي (${state.coins.length})</div>
      ${state.coins.length===0 ? `<div style="padding:16px;text-align:center;color:var(--text3);font-size:13px;">لا توجد عملات بعد</div>` : ''}
      ${state.coins.map((c,i) => `
        <div class="coin-row-item">
          <div class="coin-row-ava">${c.symbol.substring(0,3)}</div>
          <div class="coin-row-info">
            <div class="coin-row-sym">${c.symbol.toUpperCase()}/USDT</div>
            <div class="coin-row-meta">الكمية: ${c.quantity} | شراء: $${c.avgBuy}</div>
          </div>
          <div class="edit-btn" onclick="openEditModal(${i})">✏️</div>
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
      🤖 <strong style="color:var(--accent)">AI مجاني</strong> — تحليل بالعامية المصرية<br>
      🌐 يستخدم GPT-4o-mini و DeepSeek عبر LLM7.io<br>
      ⏱️ تحليل تلقائي كل <strong style="color:var(--accent)">5 دقائق</strong><br>
      📱 أضف التطبيق للشاشة الرئيسية لتجربة أفضل
    </div>`;
}

// ═══════════════════════════════════════
// MAIN RENDER
// ═══════════════════════════════════════
function renderScreen() {
  const el = document.getElementById('mainScreen');
  if (!el) return;
  switch (state.currentScreen) {
    case 'portfolio': el.innerHTML = renderPortfolio(); break;
    case 'signals':   el.innerHTML = renderSignals();   wireSignalsEvents(); break;
    case 'settings':  el.innerHTML = renderSettings();  wireSettingsEvents(); break;
  }
}

function wireSignalsEvents() {
  const btn = document.getElementById('analyzeBtn');
  if (btn) btn.addEventListener('click', () => runAllSignals());
}

function wireSettingsEvents() {
  document.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i   = parseInt(btn.dataset.del);
      const sym = state.coins[i].symbol;
      state.coins.splice(i, 1);
      delete state.signals[sym];
      save(); renderScreen();
      toast('تم حذف ' + sym);
    });
  });

  const addBtn = document.getElementById('addCoinBtn');
  if (addBtn) addBtn.addEventListener('click', addCoin);

  const saveBtn = document.getElementById('saveSettingsBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveSettingsHandler);

  const symInput = document.getElementById('fSymbol');
  if (symInput) symInput.addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
}

function addCoin() {
  const symbol  = (document.getElementById('fSymbol')?.value||'').trim().toUpperCase();
  const quantity = (document.getElementById('fQty')?.value||'').trim();
  const avgBuy   = (document.getElementById('fAvg')?.value||'').trim();
  if (!symbol)                              return toast('أدخل رمز العملة', true);
  if (!quantity||isNaN(quantity)||+quantity<=0) return toast('أدخل الكمية', true);
  if (!avgBuy  ||isNaN(avgBuy)  ||+avgBuy<=0)  return toast('أدخل سعر الشراء', true);
  const exists = state.coins.findIndex(c => c.symbol === symbol);
  if (exists >= 0) { state.coins[exists] = { symbol, quantity, avgBuy }; toast('تم تحديث ' + symbol + ' ✅'); }
  else             { state.coins.push({ symbol, quantity, avgBuy });      toast('تمت إضافة ' + symbol + ' ✅'); }
  // clear form
  ['fSymbol','fQty','fAvg'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  save(); renderScreen();
}

function saveSettingsHandler() {
  const egp   = parseFloat(document.getElementById('egpInput')?.value  || 50);
  const alert = parseFloat(document.getElementById('alertInput')?.value || 10);
  if (!isNaN(egp)   && egp   > 0) state.usdToEgp = egp;
  if (!isNaN(alert) && alert > 0) { state.alertAt = alert; state.alertFired = {}; }
  save();
  toast('تم الحفظ ✅');
  setTimeout(() => renderScreen(), 800);
}

// ═══════════════════════════════════════
// TOAST
// ═══════════════════════════════════════
function toast(msg, isErr=false, isGold=false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr?' err':'') + (isGold?' gold':'');
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ═══════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════
function initNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentScreen = btn.dataset.screen;
      renderScreen();
    });
  });
  document.getElementById('refreshBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('refreshBtn');
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
  setInterval(async () => {
    await refreshPrices();
    if (state.currentScreen === 'portfolio') renderScreen();
  }, 3000);

  setInterval(() => {
    const age = state.lastSignalUpdate ? Date.now()-state.lastSignalUpdate : Infinity;
    if (age > 5*60*1000) runAllSignals();
  }, 60*1000);

  setInterval(() => {
    if (state.currentScreen === 'signals' && !state.analyzing) renderScreen();
  }, 10000);
}

// ═══════════════════════════════════════
// SERVICE WORKER
// ═══════════════════════════════════════
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ═══════════════════════════════════════
// BOOT
// ═══════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  load();
  initNav();
  renderScreen();
  initFirebase();
  await refreshPrices();
  renderScreen();
  startAutoRefresh();
  registerSW();

  // طلب إذن الإشعارات
  if ('Notification' in window && Notification.permission === 'default')
    setTimeout(() => Notification.requestPermission(), 2000);

  // Auto-run AI لو البيانات قديمة
  const age = state.lastSignalUpdate ? Date.now()-state.lastSignalUpdate : Infinity;
  if (age > 5*60*1000 && state.coins.length > 0) {
    setTimeout(runAllSignals, 3000);
  }
});
