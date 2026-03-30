// ============================================================
// game-controller.js — Orchestration Layer
// Nine of Hearts
//
// Responsibilities:
//   - Own the authoritative game state (bitmask format)
//   - Listen to UI events from ui-manager.js
//   - Drive AI turns via ai-engine.js
//   - Send rendering commands back to ui-manager.js via Update()
//
// NOT responsible for:
//   - Rendering or DOM
//   - Game rules (game-logic.js owns those)
//   - AI search (ai-engine.js owns that)
// ============================================================

import {
    createInitialState,
    getPossibleMoves,
    applyMove,
    isGameOver,
    decodeState,
    decodeMove,
    DRAW_FLAG,
    RANK_NAMES,
    SUIT_NAMES,
} from './game-logic.js';

import { ISMCTSEngine } from './ai-engine.js';

import {
    Update,
    onGameStart,
    onDealComplete,
    onCardPlayed,
    onDrawRequested,
} from './ui-manager.js';

// ============================================================
// Config
// ============================================================

const NUM_PLAYERS   = 4;
const HUMAN         = 0;
const POST_MOVE_MS  = 350;    // pause after each move before next turn
const TURBO_AI_MS   = 300;    // AI delay during turbo mode
const HUMAN_TURN_MS = 15000;  // must match TURN_DURATION_MS in ui-manager.js

/** Random 2–4 s delay so AI turns feel natural, not robotic. */
const _aiDelay = () => 2000 + Math.random() * 2000;

const PLAYER_IDS = [
    'yourCards',    // 0 — Human (bottom)
    'player1Cards', // 1 — Lisa   (right)
    'player2Cards', // 2 — John   (top)
    'player3Cards', // 3 — Carol  (left)
];

const PLAYER_NAMES = ['You', 'Lisa', 'John', 'Carol'];

const AI_PROFILE_KEYS = {
    1: 'shark',     // Lisa  — Shark
    2: 'shark',     // John  — Shark
    3: 'shark',     // Carol — Shark
};

// ============================================================
// AI Engines  (one instance per AI player, reused across games)
// ============================================================

const _engines = {};
for (const [p, key] of Object.entries(AI_PROFILE_KEYS)) {
    _engines[p] = new ISMCTSEngine(key);
}

// ============================================================
// Bit utility (private — avoids re-importing)
// ============================================================

function _popcount(x) {
    x = (x | 0);
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    x = (x + (x >>> 4)) & 0x0F0F0F;
    return (Math.imul(x, 0x010101) >>> 16) & 0xFF;
}

// ============================================================
// Game State
// ============================================================

let _state          = null;
let _gameActive     = false;
let _turboMode      = false;   // true once human player is safe
let _turboTurnsLeft = 0;       // countdown of AI turns after human exits
let _humanTimer     = null;    // setTimeout handle for human auto-move

const TURBO_TURNS   = 10;

// ============================================================
// Bridge — register callbacks with ui-manager
// ============================================================

onGameStart(_startGame);
onDealComplete(_startTurn);
onCardPlayed(_humanPlayCards);
onDrawRequested(_humanDraw);

// ============================================================
// Game Flow
// ============================================================

function _startGame() {
    _state          = createInitialState(NUM_PLAYERS);
    _gameActive     = true;
    _turboMode      = false;
    _turboTurnsLeft = 0;

    // Reset card knowledge in all AI engines for the new game
    for (const engine of Object.values(_engines)) engine.resetKnowledge();

    const ds    = decodeState(_state);

    // Build the hands map for the deal animation
    const hands = {};
    for (let p = 0; p < NUM_PLAYERS; p++) {
        hands[PLAYER_IDS[p]] = ds.hands[p];
    }

    // Place 9♥ in the pile, then animate the deal
    Update('CLEAR_PILE');
    Update('ADD_TO_PILE', { card: ds.pile[0] });
    Update('ANIMATE_DEAL', { hands });
}

function _startTurn() {
    if (!_state || !_gameActive) return;

    if (isGameOver(_state)) {
        _endGame();
        return;
    }

    // Turbo countdown: each AI turn after human exits counts down
    if (_turboMode) {
        if (_turboTurnsLeft <= 0) {
            _forceEndGame();
            return;
        }
        _turboTurnsLeft--;
    }

    const ds = decodeState(_state);
    const p  = _state.currentPlayer;

    _renderHands(ds);

    const drawable  = _state.pileSize - 1;
    const drawCount = Math.min(3, drawable);

    Update('HIGHLIGHT_PLAYER', { playerId: PLAYER_IDS[p] });

    const turnMsg = _turboMode
        ? `⚡ TURBO  ·  ${_turboTurnsLeft + 1} turns left  ·  ${PLAYER_NAMES[p]}: ${ds.topCard.rank}${ds.topCard.suit}`
        : `${PLAYER_NAMES[p]}'s turn  ·  Top: ${ds.topCard.rank}${ds.topCard.suit}`;
    Update('SHOW_MESSAGE', { text: turnMsg });

    if (p === HUMAN) {
        _updateDrawBtn(drawCount);
        Update('ENABLE_PLAY', { enabled: true });
        Update('ENABLE_DRAW', { enabled: drawable > 0 });
        Update('START_TIMER', { playerId: PLAYER_IDS[p], isHuman: true });
        _humanTimer = setTimeout(_humanTimerExpired, HUMAN_TURN_MS);
    } else {
        Update('ENABLE_PLAY', { enabled: false });
        Update('ENABLE_DRAW', { enabled: false });
        Update('START_TIMER', { playerId: PLAYER_IDS[p], isHuman: false });
        const delay = _turboMode ? TURBO_AI_MS : _aiDelay();
        setTimeout(() => _aiTurn(p), delay);
    }
}

function _aiTurn(playerIdx) {
    if (!_state || !_gameActive || _state.currentPlayer !== playerIdx) return;

    const engine = _engines[playerIdx];
    const move   = engine.chooseMove(_state);

    // Apply first — advanceTree inside _applyAndAdvance saves the subtree
    // before cleanup() would discard _root
    _applyAndAdvance(move);
    engine.cleanup();
}

function _humanPlayCards(cards) {
    if (!_state || !_gameActive || _state.currentPlayer !== HUMAN) return;

    const move = _matchPlay(cards);
    if (move === null) {
        Update('SHOW_MESSAGE', {
            text: "❌  Can't play those cards — select 1, 4-of-a-kind, or triple 9s",
        });
        Update('DESELECT_ALL');
        return;
    }

    _applyAndAdvance(move);
}

function _humanDraw() {
    if (!_state || !_gameActive || _state.currentPlayer !== HUMAN) return;

    const drawMove = getPossibleMoves(_state).find(m => !!(m & DRAW_FLAG));
    if (drawMove === undefined) return;

    _applyAndAdvance(drawMove);
}

function _applyAndAdvance(move) {
    if (_humanTimer) { clearTimeout(_humanTimer); _humanTimer = null; }

    // Notify all AI engines of this move (before state changes so pile is intact)
    for (const engine of Object.values(_engines)) {
        engine.observeMove(_state, move);
        engine.advanceTree(move);
    }
    Update('STOP_TIMER');
    Update('ENABLE_PLAY', { enabled: false });
    Update('ENABLE_DRAW', { enabled: false });
    Update('DESELECT_ALL');

    // Sync pile visuals before applying state change
    const dm = decodeMove(move);
    if (dm.type === 'draw') {
        Update('REMOVE_FROM_PILE', { count: dm.count });
    } else {
        for (const card of dm.cards) {
            Update('ADD_TO_PILE', { card });
        }
    }

    _state = applyMove(_state, move);

    // Activate turbo mode the moment the human player empties their hand
    if (!_turboMode && (_state.eliminated & (1 << HUMAN))) {
        _turboMode      = true;
        _turboTurnsLeft = TURBO_TURNS;
        Update('SHOW_MESSAGE', { text: `⚡ You're safe! TURBO MODE — ${TURBO_TURNS} turns left for the AIs!` });
    }

    setTimeout(_startTurn, POST_MOVE_MS);
}

/**
 * Human turn timer expired — auto-play the lowest legal single card,
 * or the lowest non-draw move if no single-card play exists,
 * or draw if there are no play moves at all.
 */
function _humanTimerExpired() {
    _humanTimer = null;
    if (!_state || !_gameActive || _state.currentPlayer !== HUMAN) return;

    const moves     = getPossibleMoves(_state);
    const playMoves = moves.filter(m => !(m & DRAW_FLAG));

    if (playMoves.length > 0) {
        // Prefer single-card plays; fall back to any play move
        const singles = playMoves.filter(m => _popcount(m & 0xFFFFFF) === 1);
        const pool    = singles.length > 0 ? singles : playMoves;
        // Pick whichever has the lowest set-bit (lowest rank/suit)
        const move = pool.reduce((best, m) => {
            const bLow = best & -best;   // isolate lowest bit
            const mLow = m    & -m;
            return mLow < bLow ? m : best;
        });
        _applyAndAdvance(move);
    } else {
        const drawMove = moves.find(m => !!(m & DRAW_FLAG));
        if (drawMove !== undefined) _applyAndAdvance(drawMove);
    }
}

function _endGame() {
    _gameActive = false;
    Update('STOP_TIMER');
    Update('ENABLE_PLAY', { enabled: false });
    Update('ENABLE_DRAW', { enabled: false });

    _renderHands(decodeState(_state));

    // The loser is the one player who still holds cards
    for (let p = 0; p < NUM_PLAYERS; p++) {
        if (!(_state.eliminated & (1 << p))) {
            Update('SHOW_MESSAGE', {
                text: p === HUMAN
                    ? "💔  YOU are the LOSER — don't be a loser next time!"
                    : `💔  ${PLAYER_NAMES[p]} is the LOSER!`,
            });
            return;
        }
    }
}

function _forceEndGame() {
    _gameActive = false;
    Update('STOP_TIMER');
    Update('ENABLE_PLAY', { enabled: false });
    Update('ENABLE_DRAW', { enabled: false });

    _renderHands(decodeState(_state));

    const loserIdx = _findForcedLoser();
    Update('SHOW_MESSAGE', {
        text: `⏱️  Time's up! ${PLAYER_NAMES[loserIdx]} is the LOSER (most dead weight)!`,
    });
}

/**
 * Determine the forced loser among non-eliminated players.
 *
 * Priority:
 *   1. Most cards in hand (highest count loses)
 *   2. Tie → most 9s (lowest-rank cards) in hand
 *   3. Still tied → lowest single card by bit index (rank × 4 + suit)
 */
function _findForcedLoser() {
    const active = [];
    for (let p = 0; p < NUM_PLAYERS; p++) {
        if (!(_state.eliminated & (1 << p))) active.push(p);
    }
    if (active.length === 1) return active[0];

    const NINES_MASK = 0x0000_0F; // bits 0-3: all four 9s

    active.sort((a, b) => {
        // 1. More cards → loses
        const sizeA = _popcount(_state.hands[a]);
        const sizeB = _popcount(_state.hands[b]);
        if (sizeA !== sizeB) return sizeB - sizeA;

        // 2. More 9s → loses
        const ninesA = _popcount(_state.hands[a] & NINES_MASK);
        const ninesB = _popcount(_state.hands[b] & NINES_MASK);
        if (ninesA !== ninesB) return ninesB - ninesA;

        // 3. Lower lowest-card bit index → loses (9 < 10 < J < ...)
        const lowestA = 31 - Math.clz32(_state.hands[a] & (-_state.hands[a]));
        const lowestB = 31 - Math.clz32(_state.hands[b] & (-_state.hands[b]));
        return lowestA - lowestB;
    });

    return active[0];
}

// ============================================================
// Rendering helpers
// ============================================================

function _renderHands(ds) {
    for (let p = 0; p < NUM_PLAYERS; p++) {
        if (p === HUMAN) {
            Update('RENDER_HAND', { playerId: PLAYER_IDS[p], cards: ds.hands[p] });
        } else {
            Update('RENDER_HAND', { playerId: PLAYER_IDS[p], count: ds.hands[p].length });
        }
    }
}

function _updateDrawBtn(count) {
    const btn = document.getElementById('drawButton');
    if (btn) btn.textContent = count > 0 ? `Draw ${count}` : 'Draw';
}

// ============================================================
// Move matching  (UI card objects → legal bitmask move)
// ============================================================

function _matchPlay(uiCards) {
    let mask = 0;
    for (const { rank, suit } of uiCards) {
        const rIdx = RANK_NAMES.indexOf(rank);
        const sIdx = SUIT_NAMES.indexOf(suit);
        if (rIdx < 0 || sIdx < 0) return null;
        mask |= (1 << (rIdx * 4 + sIdx));
    }

    const legal = getPossibleMoves(_state);

    // Exact bitmask match
    for (const m of legal) {
        if (!(m & DRAW_FLAG) && (m & 0xFFFFFF) === mask) return m;
    }

    // Single-card fallback: remap to the legal single-card of the same rank.
    // Suits are interchangeable in Nine Hearts — only rank affects game state.
    // getPossibleMoves emits only lowestBit(group) per rank, so this covers
    // the case where the human clicks e.g. J♥ but only J♠ is in legal moves.
    if (uiCards.length === 1) {
        const rIdx = RANK_NAMES.indexOf(uiCards[0].rank);
        for (const m of legal) {
            if (m & DRAW_FLAG) continue;
            const bits = m & 0xFFFFFF;
            if (_popcount(bits) === 1 && (31 - Math.clz32(bits)) >> 2 === rIdx) return m;
        }
    }

    return null;
}
