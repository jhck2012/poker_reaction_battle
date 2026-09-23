/* ============================================================
   ★ 遊戲參數設定區（調整這裡即可改規則）
============================================================ */
const CONFIG = {
  GAME_TIME: 60,          // 遊戲總秒數
  FLIP_INTERVAL: 3000,    // 每幾毫秒翻一次牌（3 秒）
  MATCH_COUNT: 7,         // 60 秒內恰好 N 次「數字相同」
  SCORE_HIT: 2,           // 搶答得分
  SCORE_MISS: -1,         // 誤按扣分（可為負）
  ROUND_GAP: 500,         // 翻牌前的翻面回背空隙節奏（ms）
  COUNTDOWN: 3,           // 開始前倒數秒數
  DANGER_TIME: 10,        // 最後 N 秒計時器變紅閃爍
};
/* 計算：60s ÷ 3s = 20 個回合，其中 7 個為相同牌 */
const TOTAL_ROUNDS = Math.floor(CONFIG.GAME_TIME * 1000 / CONFIG.FLIP_INTERVAL);

const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const SUITS = [
  { sym: '♠️', red: false },
  { sym: '♥️', red: true  },
  { sym: '♦️', red: true  },
  { sym: '♣️', red: false },
];

/* ============================================================
   DOM 參照
============================================================ */
const $ = id => document.getElementById(id);
const startScreen = $('startScreen'), gameScreen = $('gameScreen'), endScreen = $('endScreen');
const cardEls = [$('card1'), $('card2')];
const frontEls = [$('front1'), $('front2')];
const scoreEls = { A: $('scoreA'), B: $('scoreB') };
const btnEls = { A: $('btnA'), B: $('btnB') };
const timerText = $('timerText'), timerArc = $('timerArc'), timerWrap = $('timerWrap');
const tableFlash = $('tableFlash');

/* 計時環圓周長 */
const ARC_LEN = 2 * Math.PI * 44;
timerArc.style.strokeDasharray = ARC_LEN;
timerArc.style.strokeDashoffset = 0;

/* ============================================================
   遊戲狀態
============================================================ */
const state = {
  running: false,
  timeLeft: CONFIG.GAME_TIME,
  scores: { A: 0, B: 0 },
  schedule: [],        // 本場 20 回合是否為相同牌（true/false）
  roundIndex: -1,
  currentMatch: false, // 目前檯面上是否為相同牌
  claimed: false,      // 本回合是否已被搶答（防連發 / 後按不得分）
  soundOn: true,
};

/* ============================================================
   音效系統（Web Audio API，無需外部音檔）
============================================================ */
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
function tone(freq, dur, type = 'sine', vol = 0.25, delay = 0, slideTo = null) {
  if (!state.soundOn || !audioCtx) return;
  const t0 = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.05);
}
function noiseBurst(dur = 0.08, vol = 0.2, freq = 2500) {
  if (!state.soundOn || !audioCtx) return;
  const t0 = audioCtx.currentTime;
  const len = audioCtx.sampleRate * dur;
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'bandpass'; filter.frequency.value = freq; filter.Q.value = 0.8;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(filter).connect(g).connect(audioCtx.destination);
  src.start(t0);
}
const SFX = {
  flip()       { noiseBurst(0.07, 0.22, 3000); noiseBurst(0.05, 0.15, 1800); }, // 紙牌聲
  ding()       { tone(1046, 0.12, 'sine', 0.3); tone(1568, 0.15, 'sine', 0.18, 0.06); }, // 相同牌提示
  score()      { tone(660, 0.1, 'triangle', 0.3); tone(880, 0.12, 'triangle', 0.3, 0.08); tone(1320, 0.18, 'triangle', 0.25, 0.16); }, // 得分上揚
  penalty()    { tone(220, 0.25, 'sawtooth', 0.25, 0, 110); },                    // 低沉錯誤
  win()        { [523,659,784,1046].forEach((f,i)=>tone(f,0.18,'triangle',0.28,i*0.12)); tone(1318,0.5,'triangle',0.25,0.5); }, // 勝利旋律
  lose()       { tone(392,0.2,'triangle',0.25); tone(311,0.35,'triangle',0.25,0.2); },
  tick()       { tone(880, 0.07, 'square', 0.12); },
  countBeep()  { tone(587, 0.12, 'sine', 0.25); },
  countGo()    { tone(1175, 0.3, 'sine', 0.3); },
};

/* 音效開關 */
$('soundBtn').addEventListener('click', () => {
  state.soundOn = !state.soundOn;
  $('soundBtn').textContent = state.soundOn ? '🔊' : '🔇';
  ensureAudio();
});

/* ============================================================
   回合排程：恰好 MATCH_COUNT 次相同、禁止連續 3 次、首回合不為相同
============================================================ */
function buildSchedule() {
  while (true) {
    const arr = new Array(TOTAL_ROUNDS).fill(false);
    // 隨機挑 MATCH_COUNT 個位置
    const idxs = [...Array(TOTAL_ROUNDS).keys()].sort(() => Math.random() - 0.5)
                 .slice(0, CONFIG.MATCH_COUNT).sort((a, b) => a - b);
    idxs.forEach(i => arr[i] = true);
    // 檢查：不可連續 3 次相同、第一回合不為相同（給玩家熱身）
    let ok = !arr[0];
    for (let i = 0; i < TOTAL_ROUNDS - 2 && ok; i++) {
      if (arr[i] && arr[i + 1] && arr[i + 2]) ok = false;
    }
    if (ok) return arr;
    // 不合規則就重排
  }
}

/* ============================================================
   撲克牌產生與渲染
============================================================ */
function randomCard() {
  return {
    rank: RANKS[Math.floor(Math.random() * RANKS.length)],
    suit: SUITS[Math.floor(Math.random() * SUITS.length)],
  };
}
function renderCard(el, card) {
  const red = card.suit.red;
  el.className = 'card-face card-front' + (red ? ' red' : '');
  el.innerHTML = `
    <div class="card-corner tl">${card.rank}<br>${card.suit.sym}</div>
    <div class="card-rank">${card.rank}</div>
    <div class="card-suit">${card.suit.sym}</div>
    <div class="card-corner br">${card.rank}<br>${card.suit.sym}</div>`;
}
function dealPair(isMatch) {
  const c1 = randomCard();
  let c2 = randomCard();
  if (isMatch) {
    // 相同數字、隨機花色
    c2 = { rank: c1.rank, suit: SUITS[Math.floor(Math.random() * SUITS.length)] };
  } else {
    // 確保不同數字
    while (c2.rank === c1.rank) c2 = randomCard();
  }
  renderCard(frontEls[0], c1);
  renderCard(frontEls[1], c2);
}

/* ============================================================
   分數與動畫回饋
============================================================ */
function floatText(btn, text, cls) {
  const r = btn.getBoundingClientRect();
  const span = document.createElement('div');
  span.className = 'float-text ' + cls;
  span.textContent = text;
  span.style.left = (r.left + r.width / 2 - 20) + 'px';
  span.style.top = (r.top - 10) + 'px';
  document.body.appendChild(span);
  setTimeout(() => span.remove(), 1000);
}
function updateScore(p, delta) {
  state.scores[p] += delta;
  const el = scoreEls[p];
  el.textContent = state.scores[p];
  el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  floatText(btnEls[p], delta > 0 ? `+${delta}` : `${delta}`, delta > 0 ? 'plus' : 'minus');
}
function shake(btn) { btn.classList.remove('shake'); void btn.offsetWidth; btn.classList.add('shake'); }
function flashTable(kind) { tableFlash.className = 'table-flash'; void tableFlash.offsetWidth; tableFlash.className = 'table-flash ' + kind; }

/* ============================================================
   玩家按下按鈕（核心判定）
============================================================ */
function playerHit(p) {
  if (!state.running) return;
  const btn = btnEls[p];

  // 防連發：同一次翻牌只計第一次按下
  if (state.claimed) {
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 100);
    return;
  }
  state.claimed = true;

  if (state.currentMatch) {
    // ✅ 相同牌 → 先按者得 SCORE_HIT 分
    updateScore(p, CONFIG.SCORE_HIT);
    SFX.score();
    btn.classList.add('won-round');
    setTimeout(() => btn.classList.remove('won-round'), 500);
    flashTable('go');
  } else {
    // ❌ 不同牌 → 誤按扣分
    updateScore(p, CONFIG.SCORE_MISS);
    SFX.penalty();
    shake(btn);
    flashTable('bad');
  }
}

/* 鍵盤：A / L，並防止按住連發 */
const keyDownSet = new Set();
window.addEventListener('keydown', e => {
  if (e.repeat || keyDownSet.has(e.code)) return;   // 防連發
  if (e.code === 'KeyA') { keyDownSet.add(e.code); playerHit('A'); }
  if (e.code === 'KeyL') { keyDownSet.add(e.code); playerHit('B'); }
});
window.addEventListener('keyup', e => keyDownSet.delete(e.code));

/* 觸控 / 滑鼠按鈕 */
['A', 'B'].forEach(p => {
  btnEls[p].addEventListener('pointerdown', e => { e.preventDefault(); playerHit(p); });
});

/* ============================================================
   遊戲流程
============================================================ */
let gameTimer = null, gapTimer = null, roundTimer = null;

function startGame() {
  ensureAudio();
  state.running = false;
  state.scores = { A: 0, B: 0 };
  state.roundIndex = -1;
  state.claimed = true;          // 倒數期間不可按
  scoreEls.A.textContent = '0';
  scoreEls.B.textContent = '0';
  state.schedule = buildSchedule();
  state.timeLeft = CONFIG.GAME_TIME;

  startScreen.classList.add('hidden');
  endScreen.classList.add('hidden');
  gameScreen.classList.add('show');

  // 3-2-1 倒數
  const overlay = $('countdownOverlay'), numEl = $('countNum');
  overlay.classList.add('show');
  let n = CONFIG.COUNTDOWN;
  numEl.textContent = n;
  SFX.countBeep();
  const cd = setInterval(() => {
    n--;
    if (n > 0) { numEl.textContent = n; SFX.countBeep(); }
    else {
      clearInterval(cd);
      numEl.textContent = 'GO!';
      SFX.countGo();
      setTimeout(() => overlay.classList.remove('show'), 700);
      beginRounds();
    }
  }, 1000);
}

function beginRounds() {
  state.running = true;
  updateTimerUI();

  // 每秒倒數
  gameTimer = setInterval(() => {
    state.timeLeft--;
    updateTimerUI();
    if (state.timeLeft <= CONFIG.DANGER_TIME && state.timeLeft > 0) SFX.tick();
    if (state.timeLeft <= 0) endGame();
  }, 1000);

  nextRound();
}

function updateTimerUI() {
  timerText.textContent = state.timeLeft;
  timerArc.style.strokeDashoffset = ARC_LEN * (1 - state.timeLeft / CONFIG.GAME_TIME);
  timerWrap.classList.toggle('danger', state.timeLeft <= CONFIG.DANGER_TIME);
}

function nextRound() {
  if (!state.running) return;
  state.roundIndex++;

  if (state.roundIndex >= TOTAL_ROUNDS) {
    // 牌已翻完但時間未到：蓋牌等待最後幾秒
    cardEls.forEach(c => c.classList.remove('flipped'));
    state.claimed = true;
    state.currentMatch = false;
    return;
  }

  // 空隙節奏：先蓋牌喘息
  cardEls.forEach(c => c.classList.remove('flipped'));
  state.claimed = true;
  state.currentMatch = false;

  gapTimer = setTimeout(() => {
    if (!state.running) return;
    const isMatch = state.schedule[state.roundIndex];
    dealPair(isMatch);
    cardEls.forEach(c => c.classList.add('flipped'));
    SFX.flip();
    if (isMatch) setTimeout(() => { if (state.running && state.currentMatch) SFX.ding(); }, 350); // 相同牌提示音
    state.currentMatch = isMatch;
    state.claimed = false;       // 開放搶答
  }, CONFIG.ROUND_GAP);

  // 排下一次翻牌
  roundTimer = setTimeout(nextRound, CONFIG.FLIP_INTERVAL);
}

function endGame() {
  state.running = false;
  clearInterval(gameTimer);
  clearTimeout(gapTimer);
  clearTimeout(roundTimer);
  cardEls.forEach(c => c.classList.remove('flipped'));
  timerWrap.classList.remove('danger');

  const { A, B } = state.scores;
  $('finalA').textContent = A;
  $('finalB').textContent = B;
  const title = $('resultTitle');
  if (A > B)      { title.textContent = '🎉 玩家 A 獲勝！'; SFX.win(); }
  else if (B > A) { title.textContent = '🎉 玩家 B 獲勝！'; SFX.win(); }
  else            { title.textContent = '🤝 平手！再戰一場？'; SFX.lose(); }

  gameScreen.classList.remove('show');
  endScreen.classList.remove('hidden');
}

/* 「？」按鈕：展開 / 收合遊戲規則 */
const rulesBox = $('rulesBox');
$('rulesBtn').addEventListener('click', () => {
  const open = rulesBox.style.display === 'none';
  rulesBox.style.display = open ? 'block' : 'none';
  $('rulesBtn').textContent = open ? '✕' : '？';
});

/* 開始 / 重開按鈕 */
$('startBtn').addEventListener('click', startGame);
$('restartBtn').addEventListener('click', startGame);
