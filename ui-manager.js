// ============================================================
// ui-manager.js  —  Pure Visual / Rendering Layer
// Nine of Hearts
//
// Responsibilities:
//   - Render cards, hands, pile, messages, timers, animations
//   - Emit UI events (card played, draw requested, game start)
//   - Receive rendering commands via Update()
//
// NOT responsible for:
//   - Game rules or win conditions
//   - Turn order or scoring
//   - AI logic or game state
// ============================================================

// ============================================================
// DOM / Layout Constants
// ============================================================

const HUMAN_ID = 'yourCards';

const SIDE_IDS = new Set(['player1Cards', 'player3Cards']);

const INFO_ID = {
    yourCards:    'yourInfo',
    player1Cards: 'player1Info',
    player2Cards: 'player2Info',
    player3Cards: 'player3Info',
};

// ============================================================
// Visual-only State
// ============================================================

let _selectedCards    = [];
let _draggedCards     = [];
let _dragPreview      = null;
let _isDragInProgress = false;
let _humanCanPlay     = false;

let _lastTap  = { time: 0, card: null };
let _touchTap = { time: 0, card: null, startX: 0, startY: 0 };
let _mouseTap = { card: null, startX: 0, startY: 0 };

const TURN_DURATION_MS = 15000;
let _timer = { rafId: null, endTime: 0, isHuman: false, lastTick: null, container: null };

// ============================================================
// Bridge — Outgoing Callbacks
// (registered once by the external controller / ai_trainer)
// ============================================================

let _cbCardPlayed    = null;   // ([{rank, suit}]) => void
let _cbDrawRequested = null;   // () => void
let _cbGameStart     = null;   // () => void
let _cbDealComplete  = null;   // () => void

/** Fires when the human player drags/taps cards onto the pile. */
export function onCardPlayed(fn)    { _cbCardPlayed    = fn; }

/** Fires when the human player clicks the Draw button. */
export function onDrawRequested(fn) { _cbDrawRequested = fn; }

/** Fires when the START button on the welcome screen is pressed. */
export function onGameStart(fn)     { _cbGameStart     = fn; }

/** Fires once the deal animation has fully completed. */
export function onDealComplete(fn)  { _cbDealComplete  = fn; }

// ============================================================
// Bridge — Incoming Commands  (Update)
// ============================================================

/**
 * Send a rendering command to the UI.
 *
 * ┌─────────────────┬──────────────────────────────────────────────────────────┐
 * │ Command         │ Payload                                                  │
 * ├─────────────────┼──────────────────────────────────────────────────────────┤
 * │ RENDER_HAND     │ { playerId, cards?:[{rank,suit}], count?:number }        │
 * │                 │   Human hand → face-up + interactive                     │
 * │                 │   AI hand   → face-down  (use count or cards.length)     │
 * ├─────────────────┼──────────────────────────────────────────────────────────┤
 * │ ADD_TO_PILE     │ { card: {rank, suit} }                                   │
 * │ REMOVE_FROM_PILE│ { count?: number }   (default 1)                         │
 * │ CLEAR_PILE      │ {}                                                        │
 * ├─────────────────┼──────────────────────────────────────────────────────────┤
 * │ SHOW_MESSAGE    │ { text: string }                                          │
 * │ SHOW_WINNER     │ { playerName: string }                                    │
 * ├─────────────────┼──────────────────────────────────────────────────────────┤
 * │ HIGHLIGHT_PLAYER│ { playerId }                                              │
 * │ START_TIMER     │ { playerId, isHuman?: bool }                              │
 * │ STOP_TIMER      │ {}                                                        │
 * ├─────────────────┼──────────────────────────────────────────────────────────┤
 * │ ANIMATE_DEAL    │ { hands: { [playerId]: [{rank,suit}] } }                  │
 * │                 │   Fires onDealComplete() when done.                       │
 * ├─────────────────┼──────────────────────────────────────────────────────────┤
 * │ ENABLE_DRAW     │ { enabled: bool }                                         │
 * │ ENABLE_PLAY     │ { enabled: bool }   — turns human card interaction on/off │
 * │ DESELECT_ALL    │ {}                                                        │
 * └─────────────────┴──────────────────────────────────────────────────────────┘
 */
export function Update(command, payload = {}) {
    switch (command) {
        case 'RENDER_HAND':
            _renderHand(payload.playerId, payload.cards, payload.count);
            break;
        case 'ADD_TO_PILE':
            _addCardToPile(payload.card);
            break;
        case 'REMOVE_FROM_PILE':
            _removeFromPile(payload.count ?? 1);
            break;
        case 'CLEAR_PILE':
            _clearPile();
            break;
        case 'SHOW_MESSAGE':
            _showMessage(payload.text ?? '');
            break;
        case 'SHOW_WINNER':
            _showWinner(payload.playerName ?? '');
            break;
        case 'HIGHLIGHT_PLAYER':
            _highlightPlayer(payload.playerId);
            break;
        case 'START_TIMER':
            _startTimer(payload.playerId, payload.isHuman ?? false);
            break;
        case 'STOP_TIMER':
            _stopTimer();
            break;
        case 'ANIMATE_DEAL':
            _animateDealing(payload.hands).then(() => {
                if (_cbDealComplete) _cbDealComplete();
            });
            break;
        case 'ENABLE_DRAW':
            _setDrawEnabled(payload.enabled ?? false);
            break;
        case 'ENABLE_PLAY':
            _humanCanPlay = payload.enabled ?? false;
            break;
        case 'DESELECT_ALL':
            _deselectAll();
            break;
        default:
            console.warn(`[ui-manager] Unknown command: "${command}"`);
    }
}

// ============================================================
// Audio
// ============================================================

let _audioCtx = null;
let _welcomeSoundPending = false;

function _initAudio() {
    if (_audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    _audioCtx = new Ctx();
}

function _playWelcomeSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});

    const now = _audioCtx.currentTime;
    const dur = 0.42;
    const bufSize = Math.max(1, Math.floor(_audioCtx.sampleRate * dur));
    const buf  = _audioCtx.createBuffer(1, bufSize, _audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * (i / bufSize));
    }
    const noise = _audioCtx.createBufferSource();
    noise.buffer = buf;
    const filt = _audioCtx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(500, now);
    filt.frequency.exponentialRampToValueAtTime(2200, now + dur);
    filt.Q.setValueAtTime(0.6, now);
    const g = _audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.07, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    noise.connect(filt); filt.connect(g); g.connect(_audioCtx.destination);
    noise.start(now); noise.stop(now + dur);

    const osc = _audioCtx.createOscillator();
    const og  = _audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now + 0.06);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.24);
    og.gain.setValueAtTime(0.0001, now + 0.06);
    og.gain.exponentialRampToValueAtTime(0.035, now + 0.09);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    osc.connect(og); og.connect(_audioCtx.destination);
    osc.start(now + 0.06); osc.stop(now + 0.35);
}

function _playTickSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now = _audioCtx.currentTime;
    const osc = _audioCtx.createOscillator();
    const g   = _audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1200, now);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(g); g.connect(_audioCtx.destination);
    osc.start(now); osc.stop(now + 0.14);
}

let _lastDealSoundAt = 0;
function _playDealSound() {
    if (!_audioCtx) return;
    const nowMs = performance.now();
    if (nowMs - _lastDealSoundAt < 90) return;
    _lastDealSoundAt = nowMs;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now = _audioCtx.currentTime;
    const dur = 0.09;
    const bufSize = Math.max(1, Math.floor(_audioCtx.sampleRate * dur));
    const buf  = _audioCtx.createBuffer(1, bufSize, _audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
    const src  = _audioCtx.createBufferSource();
    src.buffer = buf;
    const filt = _audioCtx.createBiquadFilter();
    filt.type = 'bandpass'; filt.frequency.setValueAtTime(900, now); filt.Q.setValueAtTime(0.7, now);
    const g = _audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.05, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filt); filt.connect(g); g.connect(_audioCtx.destination);
    src.start(now); src.stop(now + dur);
}

// ============================================================
// Welcome Sequence
// ============================================================

function _startWelcomeSequence() {
    const ws = document.getElementById('welcomeScreen');
    if (!ws) return;
    document.body.classList.add('welcome-active');
    ws.classList.add('playing');

    try {
        _initAudio();
        if (_audioCtx && _audioCtx.state === 'suspended') {
            _audioCtx.resume().then(_playWelcomeSound).catch(() => { _welcomeSoundPending = true; });
        } else {
            _playWelcomeSound();
        }
    } catch (e) { _welcomeSoundPending = true; }

    setTimeout(() => {
        ws.classList.add('shatter');
        try {
            const host = ws.querySelector('.text-shards');
            const src  = ws.querySelector('.welcome-content');
            if (host && src) {
                host.innerHTML = '';
                for (let i = 0; i < 8; i++) {
                    const s = document.createElement('div');
                    s.className = 'text-shard';
                    s.appendChild(src.cloneNode(true));
                    host.appendChild(s);
                }
            }
        } catch (e) {}
        setTimeout(() => {
            ws.classList.add('ready');
            document.body.classList.remove('welcome-active');
        }, 1100 + 80);
    }, 2000 + 4000);
}

// ============================================================
// Turn Timer  (visual only — progress ring)
// ============================================================

function _stopTimer() {
    if (_timer.rafId) cancelAnimationFrame(_timer.rafId);
    _timer = { rafId: null, endTime: 0, isHuman: false, lastTick: null, container: null };
}

function _startTimer(playerId, isHuman) {
    _stopTimer();
    const infoId = INFO_ID[playerId];
    const el     = infoId ? document.querySelector(`#${infoId} .avatar-container`) : null;
    if (!el) return;

    _timer.container = el;
    _timer.isHuman   = isHuman;
    _timer.endTime   = performance.now() + TURN_DURATION_MS;
    _timer.lastTick  = null;

    const tick = () => {
        const rem      = Math.max(0, _timer.endTime - performance.now());
        const progress = rem / TURN_DURATION_MS;
        if (_timer.container) _timer.container.style.setProperty('--ring-progress', String(progress));

        if (_timer.isHuman) {
            const secs = Math.ceil(rem / 1000);
            if (secs <= 5 && secs >= 1 && _timer.lastTick !== secs) {
                _timer.lastTick = secs;
                _playTickSound();
            }
        }
        if (rem > 0) _timer.rafId = requestAnimationFrame(tick);
    };
    _timer.rafId = requestAnimationFrame(tick);
}

// ============================================================
// Player Highlight
// ============================================================

function _highlightPlayer(playerId) {
    document.querySelectorAll('.avatar.active').forEach(a => a.classList.remove('active'));
    document.querySelectorAll('.avatar-container.active').forEach(c => {
        c.classList.remove('active');
        c.style.setProperty('--ring-progress', '0');
    });
    _stopTimer();

    const infoId = INFO_ID[playerId];
    if (!infoId) return;
    const avatar = document.querySelector(`#${infoId} .avatar`);
    if (avatar) {
        avatar.classList.add('active');
        const container = avatar.closest('.avatar-container');
        if (container) container.classList.add('active');
    }
}

// ============================================================
// Message
// ============================================================

function _showMessage(text) {
    const el = document.getElementById('message');
    if (el) el.textContent = text;
}

function _showWinner(playerName) {
    const el = document.getElementById('message');
    if (el) el.textContent = `\uD83C\uDFC6 ${playerName} wins!`;
}

// ============================================================
// Draw Button
// ============================================================

function _setDrawEnabled(enabled) {
    const btn = document.getElementById('drawButton');
    if (btn) btn.disabled = !enabled;
}

// ============================================================
// Card DOM Helpers
// ============================================================

function _createCardBack() {
    const card = document.createElement('div');
    card.className = 'card';
    const back = document.createElement('div');
    back.className = 'card-back';
    card.appendChild(back);
    return card;
}

function _createDeckStack() {
    const deck  = document.createElement('div');
    deck.className = 'deal-deck';
    const stack = document.createElement('div');
    stack.className = 'deal-deck-stack';
    for (let i = 0; i < 4; i++) {
        const c = document.createElement('div');
        c.className = 'deal-deck-card card dealt';
        c.style.cssText = 'width:100%;height:100%';
        c.style.setProperty('--deck-scale', String(1 - i * 0.015));
        const back = document.createElement('div');
        back.className = 'card-back';
        c.appendChild(back);
        stack.appendChild(c);
    }
    deck.appendChild(stack);
    return deck;
}

function _createSideWrap(cardEl) {
    const wrap = document.createElement('div');
    wrap.className = 'side-card-wrap';
    wrap.appendChild(cardEl);
    return wrap;
}

/**
 * Creates a face-up card element.
 * @param {{rank:string, suit:string}} cardData
 * @param {boolean} interactive  — if true, wires up click/drag for the human player
 */
function _createFaceUpCard(cardData, interactive = false) {
    const isRed = cardData.suit === '\u2665' || cardData.suit === '\u2666';
    const card  = document.createElement('div');
    card.className = 'card';
    card.dataset.rank = cardData.rank;
    card.dataset.suit = cardData.suit;

    const front = document.createElement('div');
    front.className = `card-front ${isRed ? 'red' : 'black'}`;

    let center;
    if (cardData.rank === 'J') center = `<div class="face-image">\uD83D\uDC66</div>`;
    else if (cardData.rank === 'Q') center = `<div class="face-image">\uD83D\uDC78</div>`;
    else if (cardData.rank === 'K') center = `<div class="face-image">\uD83E\uDD34</div>`;
    else center = `<div class="suit center">${cardData.suit}</div>`;

    front.innerHTML = `
        <div class="rank top-left">${cardData.rank}</div>
        <div class="suit top-left">${cardData.suit}</div>
        ${center}
        <div class="rank bottom-right">${cardData.rank}</div>
        <div class="suit bottom-right">${cardData.suit}</div>
    `;
    card.appendChild(front);

    if (interactive) {
        card.addEventListener('click', e => {
            e.stopPropagation();
            if (e.detail !== 1) return;
            _toggleSelection(card);
        });
        card.addEventListener('mousedown',  _onCardMouseDown);
        card.addEventListener('touchstart', _onCardTouchStart, { passive: false });
        card.addEventListener('touchmove',  _onCardTouchMove,  { passive: false });
        card.addEventListener('touchend',   _onCardTouchEnd);
    }
    return card;
}

// ============================================================
// Hand Rendering
// ============================================================

function _renderHand(playerId, cards, count) {
    const container = document.getElementById(playerId);
    if (!container) return;
    container.innerHTML = '';
    _deselectAll();

    const isHuman = playerId === HUMAN_ID;
    const isSide  = SIDE_IDS.has(playerId);
    const n       = count ?? (cards ? cards.length : 0);

    if (isHuman && cards) {
        cards.forEach(cardData => {
            const el = _createFaceUpCard(cardData, true);
            el.classList.add('dealt');
            container.appendChild(el);
        });
        requestAnimationFrame(() => {
            requestAnimationFrame(_updateHandLayout);
            requestAnimationFrame(_updateTopHandLayout);
        });
    } else {
        for (let i = 0; i < n; i++) {
            const el = _createCardBack();
            el.classList.add('dealt');
            container.appendChild(isSide ? _createSideWrap(el) : el);
        }
        if (playerId === 'player2Cards') {
            requestAnimationFrame(() => requestAnimationFrame(_updateTopHandLayout));
        }
    }
}

// ============================================================
// Pile
// ============================================================

function _addCardToPile(cardData) {
    const pile = document.getElementById('pile');
    if (!pile || !cardData) return;
    const card = _createFaceUpCard(cardData, false);
    card.classList.add('dealt');
    pile.appendChild(card);
}

function _removeFromPile(count) {
    const pile = document.getElementById('pile');
    if (!pile) return;
    for (let i = 0; i < count; i++) {
        if (pile.lastElementChild) pile.lastElementChild.remove();
    }
}

function _clearPile() {
    const pile = document.getElementById('pile');
    if (pile) pile.innerHTML = '';
}

// ============================================================
// Card Selection  (visual toggle only)
// ============================================================

function _deselectAll() {
    _selectedCards.forEach(c => c.classList.remove('selected'));
    _selectedCards = [];
}

function _toggleSelection(card) {
    if (!_humanCanPlay) return;
    const hand = document.getElementById(HUMAN_ID);
    if (!hand) return;

    const current = Array.from(hand.querySelectorAll('.card.selected'));
    if (current.length > 0 && card.dataset.rank !== current[0].dataset.rank) {
        current.forEach(c => c.classList.remove('selected'));
    }
    card.classList.toggle('selected');
    _selectedCards = Array.from(hand.querySelectorAll('.card.selected'));
}

function _selectFourOfAKind(card) {
    if (!_humanCanPlay) return;
    const hand = document.getElementById(HUMAN_ID);
    if (!hand) return;
    const sameRank = Array.from(hand.querySelectorAll('.card')).filter(c => c.dataset.rank === card.dataset.rank);
    if (sameRank.length < 4) return;
    _deselectAll();
    const picked = sameRank.slice(0, 4);
    picked.forEach(c => c.classList.add('selected'));
    _selectedCards = picked;
}

// ============================================================
// Touch / Mouse Handlers
// ============================================================

function _onCardTouchStart(e) {
    e.preventDefault();
    const t = e.touches[0];
    _touchTap = { time: Date.now(), card: e.currentTarget, startX: t.clientX, startY: t.clientY };
}

function _onCardTouchMove(e) {
    if (!_touchTap.card) return;
    const t  = e.touches[0];
    const dx = t.clientX - _touchTap.startX;
    const dy = t.clientY - _touchTap.startY;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        const card = _touchTap.card;
        _touchTap.card = null;
        _beginDrag(card, t.clientX, t.clientY);
    }
}

function _onCardTouchEnd(e) {
    if (_isDragInProgress) return;
    const card = e.currentTarget;
    const now  = Date.now();
    const isDouble = _lastTap.card === card && (now - _lastTap.time) < 320;
    _lastTap = { time: now, card };
    if (isDouble) { _selectFourOfAKind(card); return; }
    _toggleSelection(card);
}

function _onCardMouseDown(e) {
    if (e.button !== 0) return;
    _mouseTap = { card: e.currentTarget, startX: e.clientX, startY: e.clientY };
    document.addEventListener('mousemove', _onCardMouseMove);
    document.addEventListener('mouseup',   _onCardMouseUp);
}

function _onCardMouseMove(e) {
    if (!_mouseTap.card) return;
    if (Math.abs(e.clientX - _mouseTap.startX) > 4 || Math.abs(e.clientY - _mouseTap.startY) > 4) {
        const card = _mouseTap.card;
        _mouseTap.card = null;
        e.preventDefault();
        _beginDrag(card, e.clientX, e.clientY);
    }
}

function _onCardMouseUp() {
    document.removeEventListener('mousemove', _onCardMouseMove);
    document.removeEventListener('mouseup',   _onCardMouseUp);
    _mouseTap.card = null;
}

// ============================================================
// Drag & Drop  (fires onCardPlayed — no game logic here)
// ============================================================

function _beginDrag(card, clientX, clientY) {
    if (!_humanCanPlay) return;
    _isDragInProgress = true;
    if (!card.classList.contains('selected')) {
        _deselectAll();
        _selectedCards = [card];
        card.classList.add('selected');
    }
    _draggedCards = [..._selectedCards];
    _createDragPreviewEl(clientX, clientY);
    document.addEventListener('mousemove', _onDragMove);
    document.addEventListener('touchmove', _onDragMove, { passive: false });
    document.addEventListener('mouseup',   _onDragEnd);
    document.addEventListener('touchend',  _onDragEnd);
    _draggedCards.forEach(c => c.classList.add('dragging'));
}

function _createDragPreviewEl(clientX, clientY) {
    _dragPreview = document.createElement('div');
    _dragPreview.className = 'card drag-preview';
    _dragPreview.style.width  = 'var(--your-card-width)';
    _dragPreview.style.height = 'var(--your-card-height)';
    _dragPreview.innerHTML = _draggedCards[0].querySelector('.card-front').outerHTML;
    if (_draggedCards.length > 1) {
        const badge = document.createElement('div');
        Object.assign(badge.style, {
            position: 'absolute', top: '-10px', right: '-10px',
            background: '#4CAF50', color: 'white', borderRadius: '50%',
            width: '24px', height: '24px', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: '12px', fontWeight: 'bold',
        });
        badge.textContent = _draggedCards.length;
        _dragPreview.appendChild(badge);
    }
    document.body.appendChild(_dragPreview);
    _moveDragPreview(clientX, clientY);
}

function _moveDragPreview(x, y) {
    if (!_dragPreview) return;
    const r = _dragPreview.getBoundingClientRect();
    _dragPreview.style.left = `${x - r.width  / 2}px`;
    _dragPreview.style.top  = `${y - r.height / 2}px`;
}

function _onDragMove(e) {
    if (!_dragPreview) return;
    e.preventDefault();
    const x = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
    const y = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
    _moveDragPreview(x, y);
    const pile = document.getElementById('pile');
    const r    = pile.getBoundingClientRect();
    pile.classList.toggle('drop-active', x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
}

function _onDragEnd(e) {
    if (!_dragPreview) return;
    const x = e.type.includes('touch') ? e.changedTouches[0].clientX : e.clientX;
    const y = e.type.includes('touch') ? e.changedTouches[0].clientY : e.clientY;
    const pile = document.getElementById('pile');
    const r    = pile.getBoundingClientRect();

    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        _fireCardPlayed();
    }

    _draggedCards.forEach(c => c.classList.remove('dragging'));
    pile.classList.remove('drop-active');
    _dragPreview.remove(); _dragPreview = null;
    _draggedCards     = [];
    _isDragInProgress = false;
    document.removeEventListener('mousemove', _onDragMove);
    document.removeEventListener('touchmove', _onDragMove);
    document.removeEventListener('mouseup',   _onDragEnd);
    document.removeEventListener('touchend',  _onDragEnd);
}

function _fireCardPlayed() {
    if (_selectedCards.length === 0 || !_cbCardPlayed) return;
    const cards = _selectedCards.map(c => ({ rank: c.dataset.rank, suit: c.dataset.suit }));
    _cbCardPlayed(cards);
}

// ============================================================
// Layout Helpers
// ============================================================

function _updateHandLayout() {
    const hand = document.getElementById(HUMAN_ID);
    if (!hand) return;
    const cards   = hand.querySelectorAll('.card');
    const n       = cards.length;
    const isLand  = window.matchMedia('(orientation: landscape)').matches;
    const first   = cards[0];
    const cardW   = first ? first.getBoundingClientRect().width : 0;
    const areaW   = hand.clientWidth;
    const total   = cardW * n;

    let overlap = 0;
    if (n > 1 && cardW > 0 && areaW > 0 && total > areaW) {
        overlap = Math.max(0, Math.min(cardW - 1, (total - areaW) / (n - 1)));
    }
    document.documentElement.style.setProperty('--your-overlap-margin', `-${overlap}px`);

    if (!isLand) {
        const nearFull  = areaW > 0 && (total / areaW) >= 0.85;
        const leftAlign = overlap > 0 || nearFull;
        hand.style.justifyContent = leftAlign ? 'flex-start' : 'center';
        hand.style.transform = leftAlign
            ? `translateX(-${Math.min(10, Math.round(cardW * 0.08))}px)`
            : 'translateX(0px)';
    } else {
        hand.style.transform = 'translateX(0px)';
    }

    requestAnimationFrame(() => {
        const overflow = hand.scrollWidth - hand.clientWidth;
        if (overflow > 0 && n > 1) {
            const adj = Math.max(0, Math.min(cardW - 1, overlap + overflow / (n - 1) + 1));
            document.documentElement.style.setProperty('--your-overlap-margin', `-${adj}px`);
            if (!isLand) hand.style.justifyContent = 'flex-start';
        }
    });
}

function _updateTopHandLayout() {
    const hand = document.getElementById('player2Cards');
    if (!hand) return;
    const cards = hand.querySelectorAll('.card');
    const n     = cards.length;
    const first = cards[0];
    const cardW = first ? first.getBoundingClientRect().width : 0;
    const areaW = hand.clientWidth;

    let overlap = 0;
    if (n > 1 && cardW > 0 && areaW > 0) {
        const total = cardW * n;
        if (total > areaW) overlap = Math.max(0, Math.min(cardW - 1, (total - areaW) / (n - 1)));
    }
    document.documentElement.style.setProperty('--top-overlap-margin', `-${overlap}px`);
}

// ============================================================
// Dealing Animation
// ============================================================

function _getTargetPoint(container, index, total, cardW, cardH, axis) {
    const r    = container.getBoundingClientRect();
    const step = total <= 1 ? 0 : axis === 'y'
        ? (r.height - cardH) / (total - 1)
        : (r.width  - cardW) / (total - 1);
    return axis === 'y'
        ? { x: r.left + r.width / 2,      y: r.top + cardH / 2 + step * index }
        : { x: r.left + cardW / 2 + step * index, y: r.top + r.height / 2 };
}

function _getSizeForVar(wVar, hVar) {
    const probe = document.createElement('div');
    probe.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${wVar};height:${hVar}`;
    document.body.appendChild(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    return { w: r.width, h: r.height };
}

async function _animateDealing(hands) {
    const dealOrder = ['yourCards', 'player3Cards', 'player2Cards', 'player1Cards'];
    const counts    = Object.fromEntries(dealOrder.map(id => [id, (hands[id] || []).length]));
    const rounds    = Math.max(...Object.values(counts));
    const stepMs    = 3000 / (rounds * dealOrder.length);

    const pileEl = document.getElementById('pile');
    const deckEl = _createDeckStack();
    pileEl.appendChild(deckEl);
    const or     = pileEl.getBoundingClientRect();
    const origin = { x: or.left + or.width / 2, y: or.top + or.height / 2 };

    const sizeYour  = _getSizeForVar('var(--your-card-width)',   'var(--your-card-height)');
    const sizeOther = _getSizeForVar('var(--other-card-width)',  'var(--other-card-height)');
    const sizeSide  = _getSizeForVar('var(--other-card-height)', 'var(--other-card-width)');

    const promises = [];
    let dealIdx    = 0;

    for (let r = 0; r < rounds; r++) {
        for (const targetId of dealOrder) {
            const handArr = hands[targetId] || [];
            if (r >= handArr.length) { dealIdx++; continue; }

            const container = document.getElementById(targetId);
            const isHuman   = targetId === HUMAN_ID;
            const isTop     = targetId === 'player2Cards';
            const isSide    = SIDE_IDS.has(targetId);
            const cardData  = handArr[r];
            const cardW     = isHuman ? sizeYour.w : sizeOther.w;
            const cardH     = isHuman ? sizeYour.h : sizeOther.h;
            const axis      = (isHuman || isTop) ? 'x' : 'y';
            const tSize     = isSide ? sizeSide : { w: cardW, h: cardH };
            const point     = _getTargetPoint(container, r, counts[targetId], tSize.w, tSize.h, axis);
            const atMs      = dealIdx * stepMs + Math.floor(dealIdx / dealOrder.length) * 40 + (dealIdx % dealOrder.length) * 10;

            const p = new Promise(resolve => {
                setTimeout(() => {
                    _playDealSound();

                    const fly = document.createElement('div');
                    fly.className = 'deal-fly';
                    fly.style.cssText = `width:${cardW}px;height:${cardH}px;left:${origin.x - cardW / 2}px;top:${origin.y - cardH / 2}px`;
                    const flyCard = document.createElement('div');
                    flyCard.className = 'card dealt';
                    flyCard.style.cssText = 'width:100%;height:100%';
                    const back = document.createElement('div');
                    back.className = 'card-back';
                    flyCard.appendChild(back);
                    fly.appendChild(flyCard);
                    document.body.appendChild(fly);

                    const anim = fly.animate([
                        { transform: 'translate(0,0)', opacity: 1 },
                        { transform: `translate(${point.x - origin.x}px,${point.y - origin.y}px)`, opacity: 1 },
                    ], { duration: 220, easing: 'cubic-bezier(0.25,0.46,0.45,0.94)' });

                    anim.onfinish = () => {
                        fly.remove();
                        const finalCard = isHuman ? _createFaceUpCard(cardData, true) : _createCardBack();
                        finalCard.classList.add('dealt');
                        if (isSide) {
                            const wrap = _createSideWrap(finalCard);
                            container[targetId === 'player1Cards' ? 'insertBefore' : 'appendChild'](
                                wrap, targetId === 'player1Cards' ? container.firstChild : undefined
                            );
                        } else {
                            container.appendChild(finalCard);
                        }
                        if (isHuman) requestAnimationFrame(() => requestAnimationFrame(_updateHandLayout));
                        if (isTop)   requestAnimationFrame(() => requestAnimationFrame(_updateTopHandLayout));
                        resolve();
                    };
                }, atMs);
            });
            promises.push(p);
            dealIdx++;
        }
    }

    await Promise.all(promises);
    deckEl.remove();
    requestAnimationFrame(() => {
        requestAnimationFrame(_updateHandLayout);
        requestAnimationFrame(_updateTopHandLayout);
    });
}

// ============================================================
// Debug / Dev Helpers
// ============================================================

function _toggleControls() {
    const el = document.getElementById('controls');
    if (el) el.classList.toggle('hidden');
}

async function _downloadHtml() {
    const html = document.documentElement.outerHTML;
    try {
        await navigator.clipboard.writeText(html);
        alert('Page HTML copied to clipboard!');
    } catch {
        window.prompt('Copy HTML manually:', html);
    }
}

function _updateLayoutDebug() {
    if (!location.search.includes('debug=1') && !/#debug\b/i.test(location.hash)) return;
    let el = document.getElementById('layoutDebug');
    if (!el) {
        el = document.createElement('div');
        el.id = 'layoutDebug';
        Object.assign(el.style, {
            position: 'fixed', left: '8px', top: '8px', zIndex: '99999',
            padding: '6px 8px', background: 'rgba(0,0,0,0.75)', color: '#fff',
            font: '12px/1.25 Arial,sans-serif', borderRadius: '6px', pointerEvents: 'none',
        });
        document.body.appendChild(el);
    }
    const your  = document.getElementById(HUMAN_ID);
    const u     = getComputedStyle(document.documentElement).getPropertyValue('--u').trim();
    const cards = your ? your.querySelectorAll('.card').length : 0;
    const ip    = window.matchMedia('(orientation: portrait)').matches;
    el.textContent = `portrait:${ip}  yourCards:${cards}  u:${u}`;
}

// ============================================================
// Event Listeners
// ============================================================

function _setupListeners() {
    const startBtn = document.getElementById('startButton');
    if (startBtn) {
        startBtn.addEventListener('click', e => {
            e.stopPropagation();
            _initAudio();
            if (_welcomeSoundPending) { _welcomeSoundPending = false; _playWelcomeSound(); }
            const root = document.documentElement;
            if (root.requestFullscreen)            root.requestFullscreen().catch(() => {});
            else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
            document.getElementById('welcomeScreen')?.remove();
            document.getElementById('tapToStart')?.remove();
            if (_cbGameStart) _cbGameStart();
        });
    }

    const legacyTap = document.getElementById('tapToStart');
    if (legacyTap) {
        legacyTap.addEventListener('click', () => {
            _initAudio();
            document.getElementById('welcomeScreen')?.remove();
            legacyTap.remove();
            if (_cbGameStart) _cbGameStart();
        });
    }

    document.querySelector('.toggle-controls')
        ?.addEventListener('click', _toggleControls);

    document.getElementById('drawButton')
        ?.addEventListener('click', () => { if (_cbDrawRequested) _cbDrawRequested(); });

    document.getElementById('downloadHtmlBtn')
        ?.addEventListener('click', _downloadHtml);

    document.getElementById('testTimerBtn')
        ?.addEventListener('click', () => _startTimer(HUMAN_ID, true));

    document.getElementById('addCardBtn')
        ?.addEventListener('click', () => console.log('[ui-manager] addCardBtn: connect via controller'));

    document.getElementById('removeCardBtn')
        ?.addEventListener('click', () => console.log('[ui-manager] removeCardBtn: connect via controller'));

    const pile = document.getElementById('pile');
    if (pile) {
        pile.addEventListener('click', () => {
            if (_selectedCards.length > 0 && _humanCanPlay && !_isDragInProgress) {
                _fireCardPlayed();
            }
        });
    }

    window.addEventListener('resize', () => {
        _updateHandLayout();
        _updateTopHandLayout();
        _updateLayoutDebug();
    });
    window.addEventListener('orientationchange', () => {
        requestAnimationFrame(() => {
            _updateHandLayout();
            _updateTopHandLayout();
            _updateLayoutDebug();
        });
    });
}

// ============================================================
// Init  (module is deferred — DOM is ready)
// ============================================================

_setupListeners();
_startWelcomeSequence();
_updateLayoutDebug();

if (location.search.includes('debug=1') || /#debug\b/i.test(location.hash)) {
    setInterval(_updateLayoutDebug, 250);
}
