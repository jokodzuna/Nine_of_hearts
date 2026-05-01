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
    createBotfatherState,
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
// ===== DEBUG_BLOCK_START — expose toggle via browser console: aiDebug(true/false) =====
window.aiDebug = (on = true) => { window.AI_DEBUG = on; console.log(`[AI_DEBUG] ${on ? 'ON' : 'OFF'}`); };
// ===== DEBUG_BLOCK_END =====
import { QBotEngine, HybridQBotEngine, TrainingQBotEngine } from './q-bot.js'; // HybridQBotEngine/TrainingQBotEngine: TEST_BLOCK
import { sandbox } from './training-sandbox.js'; // TEST_BLOCK

import {
    Update,
    onGameStart,
    onDealComplete,
    onCardPlayed,
    onDrawRequested,
    getPlayerConfig,
    onMultiplayerReady,
    onMPHostStart,
    onNewGame,
    onMainMenu,
    onHostLeft,
    onDealStart,
} from './ui-manager.js';

import * as MP from './multiplayer.js';
const { convertToBot, incrementTurnsMissed, permanentBot, tryPromoteHost } = MP;

import { AI_AVATARS, DEFAULT_AVATAR } from './constants.js';

import * as Economy from './economy.js';
import * as Audio  from './audio.js';

// ===== TEST_BLOCK_START — appState for training sandbox =====
export const appState = { isTrainingMode: false };
const TRAINING_BOT_DELAY = 500; // ms before bot plays in training mode (shorter — reveal window replaces pre-play delay)
const REVEAL_WINDOW_MS   = 4000; // ms tap-to-pause window after bot card lands
// ===== TEST_BLOCK_END =====

// ============================================================
// Config
// ============================================================

let   NUM_PLAYERS   = 4;   // updated from welcome config each game
const HUMAN         = 0;
const POST_MOVE_MS  = 350;    // pause after each move before next turn
const HUMAN_TURN_MS = 15000;  // must match TURN_DURATION_MS in ui-manager.js

/** Random 2–4 s delay so AI turns feel natural, not robotic. */
const _aiDelay = () => 2000 + Math.random() * 2000;

// ===== TEST_BLOCK_START — bot-vs-bot mode =====
let _botVsBot     = false;
let _botVsBotFast = false;
const _BOT_LABELS = { mctsAce50: 'MCTS-ace-50', shark: 'Shark', gambler: 'Gambler',
    newbie: 'Newbie', hybrid: 'Hybrid Q+MCTS', pureq: 'Pure Q-bot', training: 'Training Bot' };
function _makeBotEngine(key) {
    switch (key) {
        case 'mctsAce50': return new ISMCTSEngine('mctsAce50');
        case 'gambler':   return new ISMCTSEngine('gambler');
        case 'newbie':    return new ISMCTSEngine('newbie');
        case 'hybrid':    return new HybridQBotEngine();
        case 'pureq':     return new QBotEngine();
        case 'training':  return new TrainingQBotEngine();
        default:          return new ISMCTSEngine('shark');
    }
}
// ===== TEST_BLOCK_END =====

const PLAYER_IDS = [
    'yourCards',    // 0 — Human (bottom)
    'player1Cards', // 1 — Lisa   (right)
    'player2Cards', // 2 — John   (top)
    'player3Cards', // 3 — Carol  (left)
];

let PLAYER_NAMES = ['You', 'Lisa', 'John', 'Carol'];

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

/**
 * Map a game-player index to the correct DOM container ID.
 * In MP mode, rotates so _myMPIdx always maps to 'yourCards' (bottom).
 */
function _mpDispId(gameIdx) {
    if (!_mpMode) return PLAYER_IDS[gameIdx];
    return PLAYER_IDS[(gameIdx - _myMPIdx + 4) % 4];
}

// ============================================================
// Disconnect tracking  (MP only)
// ============================================================

let _disconnectedUids   = {};   // playerIdx → uid, for incrementTurnsMissed
let _reconnectTimeouts  = {};   // playerIdx → setTimeout handle (5-min permanent-bot)

// ============================================================
// Game State
// ============================================================

let _state          = null;
let _gameActive     = false;
let _pendingHands   = null;   // botfather: hands stored until deal veil clears
let _humanTimer     = null;    // setTimeout handle for human auto-move
let _pileAddTimer   = null;    // setTimeout handle for deferred AI card→pile animation

// Multiplayer state
let _mpMode       = false;     // true during a multiplayer game
let _myMPIdx      = 0;         // this client's player-seat index
let _mpBotIdxs    = [];        // seat indices managed as bots by the host
let _abandonTimer = null;      // host: fires when all human guests have been gone 1 min

// Post-game restart data
let _lastMPMode     = false;
let _lastLocalConfig = null;

// Economy tracking (reset each game)
let _gameStartTime       = 0;
let _humanMaxCards       = 0;
let _humanFoursThisGame  = 0;

// ============================================================
// Bridge — register callbacks with ui-manager
// ============================================================

onGameStart(_startGame);
onDealStart(_triggerDeal);
onDealComplete(_startTurn);
onCardPlayed(_humanPlayCards);
onDrawRequested(_humanDraw);
onMultiplayerReady(_startMPGame);
onMPHostStart(_handleMPHostStart);
onNewGame(_handleNewGame);
onMainMenu(_handleMainMenu);
onHostLeft(_handleHostLeft);

MP.on('playerDisconnected',   _handlePlayerDisconnected);
MP.on('playerReconnected',    _handlePlayerReconnected);
MP.on('hostChanged',          _handleHostChanged);
MP.on('connectionLost',       _handleConnectionLost);
MP.on('connectionRestored',   _handleConnectionRestored);
MP.on('selfReconnected',      _handleSelfReconnected);
MP.on('hostHeartbeatLost',    _handleHostHeartbeatLost);
MP.on('hostHeartbeatRestored',_handleHostHeartbeatRestored);

// ============================================================
// Game Flow
// ============================================================

function _startGame(cfgOverride = null) {
    const cfg = cfgOverride ?? getPlayerConfig();
    _lastMPMode      = false;
    _lastLocalConfig = { ...cfg };

    // Reset any per-game overrides from a previous run
    PLAYER_IDS[1] = 'player1Cards';
    PLAYER_NAMES[1] = 'Lisa'; PLAYER_NAMES[2] = 'John'; PLAYER_NAMES[3] = 'Carol';

    const isBotfather = cfg.difficulty === 'botfather';
    const isTestBot   = cfg.difficulty === 'test-hybrid' || cfg.difficulty === 'test-pureq' || cfg.difficulty === 'test-training' || cfg.difficulty === 'test-ace50' || cfg.difficulty === 'test-bot-vs-bot'; // TEST_BLOCK

    // ---- Engines ----
    const DIFF_PROFILES = {
        easy:           [null, 'gambler', 'newbie',  'newbie' ],
        medium:         [null, 'shark',  'gambler', 'gambler'],
        hard:           [null, 'shark',  'shark',   'shark'  ],
        botfather:      [null, null,    null,       null    ],
        'test-hybrid':  [null, null,     null,       null    ], // TEST_BLOCK
        'test-pureq':   [null, null,     null,       null    ], // TEST_BLOCK
        'test-training':[null, null,     null,       null    ], // TEST_BLOCK
        'test-ace50':   [null, null,     null,       null    ], // TEST_BLOCK
        'test-bot-vs-bot': [null, null,  null,       null    ], // TEST_BLOCK
    };
    const profiles = DIFF_PROFILES[cfg.difficulty] ?? DIFF_PROFILES.hard;
    for (let p = 1; p < 4; p++) _engines[p] = profiles[p] ? new ISMCTSEngine(profiles[p]) : null;
    // ===== TEST_BLOCK_START =====
    if      (cfg.difficulty === 'botfather')     _engines[1] = new TrainingQBotEngine();
    else if (cfg.difficulty === 'test-hybrid')   _engines[1] = new HybridQBotEngine();
    else if (cfg.difficulty === 'test-pureq')    _engines[1] = new QBotEngine();
    else if (cfg.difficulty === 'test-training') _engines[1] = new TrainingQBotEngine(); // TEST_BLOCK
    else if (cfg.difficulty === 'test-ace50')    _engines[1] = new ISMCTSEngine('mctsAce50'); // TEST_BLOCK
    else if (cfg.difficulty === 'test-bot-vs-bot') {                                          // TEST_BLOCK
        _engines[0] = _makeBotEngine(cfg.botP0 ?? 'mctsAce50');                              // TEST_BLOCK
        _engines[1] = _makeBotEngine(cfg.botP1 ?? 'shark');                                  // TEST_BLOCK
    }                                                                                         // TEST_BLOCK
    // ===== TEST_BLOCK_END =====
    // ===== TEST_BLOCK_START — bot-vs-bot flags =====
    _botVsBot     = cfg.difficulty === 'test-bot-vs-bot';
    _botVsBotFast = _botVsBot && !!cfg.botVsBotFast;
    if (_botVsBot) appState.isTrainingMode = false;
    // ===== TEST_BLOCK_END =====
    // ===== TEST_BLOCK_START — reset sandbox on new game =====
    console.log(`[GC] _startGame: difficulty=${cfg.difficulty}, appState.isTrainingMode=${appState.isTrainingMode}`);
    if (appState.isTrainingMode) {
        sandbox.reset();
        sandbox.ensureInitialized().catch(console.warn);
    }
    // ===== TEST_BLOCK_END =====

    // ---- Players ----
    NUM_PLAYERS = (isBotfather || isTestBot) ? 2 : cfg.numPlayers; // TEST_BLOCK: isTestBot forces 2
    if (isBotfather) {
        PLAYER_IDS[1]   = 'player2Cards';   // Botfather sits at top
        PLAYER_NAMES[1] = 'The Botfather';
    // ===== TEST_BLOCK_START =====
    } else if (cfg.difficulty === 'test-bot-vs-bot') {
        PLAYER_NAMES[0] = _BOT_LABELS[cfg.botP0] ?? 'Bot A';
        PLAYER_NAMES[1] = _BOT_LABELS[cfg.botP1] ?? 'Bot B';
    } else if (isTestBot) {
        PLAYER_NAMES[1] = cfg.difficulty === 'test-hybrid'   ? 'Hybrid Q+MCTS'
                        : cfg.difficulty === 'test-training' ? 'Training Bot'
                        : cfg.difficulty === 'test-ace50'    ? 'MCTS-ace-50'
                        : 'Pure Q-bot';
    }
    // ===== TEST_BLOCK_END =====
    _state = isBotfather ? createBotfatherState() : createInitialState(NUM_PLAYERS);

    if (!_botVsBot) PLAYER_NAMES[0] = cfg.playerName || 'Player'; // TEST_BLOCK: bot-vs-bot sets name above
    _gameActive         = true;
    _gameStartTime      = Date.now();
    _humanMaxCards      = 0;
    _humanFoursThisGame = 0;

    for (const engine of Object.values(_engines)) engine?.resetKnowledge();

    const ds = decodeState(_state);

    if (isBotfather) {
        Update('SETUP_PLAYERS',      { numPlayers: 3, playerName: PLAYER_NAMES[0], avatarPath: cfg.avatarPath });
        Update('SETUP_PLAYER_AREAS', { showRight: false, showTop: true, showLeft: false });
        Update('SET_PLAYER_AVATAR',  { playerId: 'player2Cards', avatarPath: 'Images/bot-avatars/botfather.webp' });
        Update('SET_PLAYER_NAME',    { playerId: 'player2Cards', name: 'The Botfather' });
    } else {
        const numForSetup = isTestBot ? 2 : cfg.numPlayers; // TEST_BLOCK
        Update('SETUP_PLAYERS', { numPlayers: numForSetup, playerName: PLAYER_NAMES[0], avatarPath: cfg.avatarPath });
        const maxBotSlot = isTestBot ? 2 : 4; // TEST_BLOCK
        for (let p = 1; p < maxBotSlot; p++) {
            Update('SET_PLAYER_AVATAR', { playerId: PLAYER_IDS[p], avatarPath: AI_AVATARS[p] ?? DEFAULT_AVATAR });
            Update('SET_PLAYER_NAME',   { playerId: PLAYER_IDS[p], name: PLAYER_NAMES[p] });
        }
        if (_botVsBot) Update('SET_PLAYER_NAME', { playerId: PLAYER_IDS[0], name: PLAYER_NAMES[0] }); // TEST_BLOCK
    }

    const hands = {};
    for (let p = 0; p < NUM_PLAYERS; p++) hands[PLAYER_IDS[p]] = ds.hands[p];

    Update('CLEAR_PILE');
    Update('ADD_TO_PILE', { card: ds.pile[0] });
    if (isBotfather) {
        _pendingHands = hands;   // deal fired by _triggerDeal() when veil clears
    } else {
        _pendingHands = null;
        Update('ANIMATE_DEAL', { hands });
    }
}

function _triggerDeal() {
    if (_pendingHands) {
        const h = _pendingHands;
        _pendingHands = null;
        Update('ANIMATE_DEAL', { hands: h });
    }
}

function _startTurn() {
    if (_mpMode) { _startMPTurn(); return; }
    if (!_state || !_gameActive) return;

    if (isGameOver(_state)) {
        _endGame();
        return;
    }

    const ds = decodeState(_state);
    const p  = _state.currentPlayer;

    _renderHands(ds);

    const drawable  = _state.pileSize - 1;
    const drawCount = Math.min(3, drawable);

    Update('HIGHLIGHT_PLAYER', { playerId: PLAYER_IDS[p] });

    const turnMsg = `${PLAYER_NAMES[p]}'s turn  ·  Top: ${ds.topCard.rank}${ds.topCard.suit}`;
    Update('SHOW_MESSAGE', { text: turnMsg });

    if (p === HUMAN && !_botVsBot) {
        _updateDrawBtn(drawCount);
        Update('ENABLE_PLAY', { enabled: true });
        Update('ENABLE_DRAW', { enabled: drawable > 0 });
        Update('START_TIMER', { playerId: PLAYER_IDS[p], isHuman: true });
        _humanTimer = setTimeout(_humanTimerExpired, HUMAN_TURN_MS);
    } else {
        Update('ENABLE_PLAY', { enabled: false });
        Update('ENABLE_DRAW', { enabled: false });
        Update('START_TIMER', { playerId: PLAYER_IDS[p], isHuman: false });
        setTimeout(() => _aiTurn(p), _botVsBotFast ? 50 : appState.isTrainingMode ? TRAINING_BOT_DELAY : _aiDelay());
    }
}

function _aiTurn(playerIdx) {
    if (!_state || !_gameActive || _state.currentPlayer !== playerIdx) return;

    const engine = _engines[playerIdx];
    // ===== TEST_BLOCK_START =====
    const preState = appState.isTrainingMode ? Object.assign({}, _state,
        { hands: Int32Array.from(_state.hands), pile: Int32Array.from(_state.pile) }
    ) : null;
    // ===== TEST_BLOCK_END =====
    const move = engine.chooseMove(_state);

    // Apply first — advanceTree inside _applyAndAdvance saves the subtree
    // before cleanup() would discard _root
    _applyAndAdvance(move, preState, engine);
    engine.cleanup();
}

// ===== TEST_BLOCK_START =====
function _applyTrainingCorrection(preState, botMove, correctedMove, botEngine) {
    if (!correctedMove || correctedMove === botMove) {
        // No correction — silent approve MCTS if applicable
        if (botEngine?.lastMoveSrc === 'mcts') {
            const key = _encodeHumanState(preState);
            sandbox.applyMCTSApproval(key, _moveToActLocal(botMove));
        }
        setTimeout(_startTurn, POST_MOVE_MS);
        return;
    }
    // Undo bot's move: restore pre-move state and replay with corrected move
    _state = preState;
    // Cancel any pending deferred pile-add from the original bot move and re-sync visuals
    if (_pileAddTimer) { clearTimeout(_pileAddTimer); _pileAddTimer = null; }
    Update('CLEAR_PILE');
    const _preDecode = decodeState(_state);
    for (const c of _preDecode.pile) Update('ADD_TO_PILE', { card: c });
    const key    = _encodeHumanState(preState);
    const botAct = _moveToActLocal(botMove);
    const humAct = _moveToActLocal(correctedMove);
    sandbox.applyCorrection(key, humAct, botAct);
    _applyAndAdvance(correctedMove);
}

function _encodeHumanState(s) {
    // Mirror of encodeState from q-bot.js for recording human moves
    const BOT_SEAT = 1;
    const RM = [0x00000F,0x0000F0,0x000F00,0x00F000,0x0F0000,0xF00000];
    const h   = s.hands[BOT_SEAT], oh = s.hands[1 - BOT_SEAT];
    const p2  = s.pileSize >= 2 ? (s.pile[s.pileSize-2]>>2 <= 1 ? 0 : s.pile[s.pileSize-2]>>2 <= 3 ? 1 : 2) : 3;
    const p3  = s.pileSize >= 3 ? (s.pile[s.pileSize-3]>>2 <= 1 ? 0 : s.pile[s.pileSize-3]>>2 <= 3 ? 1 : 2) : 3;
    const bkt = n => n>=3?3:n;
    const myH = Math.min(_popcount(h), 12), opH = Math.min(_popcount(oh), 12);
    const myA = _popcount(h & RM[5]);
    const pd  = s.pileSize-1 <= 0 ? 0 : s.pileSize-1 <= 2 ? 1 : 2;
    return `${s.topRankIdx}|${p2}|${p3}|${bkt(_popcount(h&(RM[0]|RM[1])))}|${bkt(_popcount(h&(RM[2]|RM[3])))}|${myA}|${myH}|${opH}|${pd}|${bkt(_popcount(oh&(RM[4]|RM[5])))}`;
}

const ACT_QUAD_L = 6, ACT_DRAW_L = 7;
function _moveToActLocal(m) {
    if (m & DRAW_FLAG) return ACT_DRAW_L;
    const bits = m & 0xFFFFFF;
    if (_popcount(bits) >= 3) return ACT_QUAD_L;
    return (31 - Math.clz32(bits)) >> 2;
}
// ===== TEST_BLOCK_END =====

function _humanPlayCards(cards) {
    const hi = _mpMode ? _myMPIdx : HUMAN;
    if (!_state || !_gameActive || _state.currentPlayer !== hi) return;

    const move = _matchPlay(cards);
    if (move === null) {
        Audio.triggerHaptic('error');
        Update('SHOW_MESSAGE', {
            text: "\u274C  Can't play those cards \u2014 select 1, 4-of-a-kind, or triple 9s",
        });
        Update('DESELECT_ALL');
        return;
    }

    Audio.triggerHaptic('light');
    // ===== TEST_BLOCK_START — record human move for training =====
    if (appState.isTrainingMode) {
        const key = _encodeHumanState(_state);
        sandbox.recordHumanMove(key, _moveToActLocal(move));
    }
    // ===== TEST_BLOCK_END =====
    if (_mpMode) _applyMPMove(move);
    else         _applyAndAdvance(move);
}

function _humanDraw() {
    const hi = _mpMode ? _myMPIdx : HUMAN;
    if (!_state || !_gameActive || _state.currentPlayer !== hi) return;

    const moves        = getPossibleMoves(_state);
    const drawMove     = moves.find(m => !!(m & DRAW_FLAG));
    if (drawMove === undefined) return;

    if (_mpMode) _applyMPMove(drawMove);
    else         _applyAndAdvance(drawMove);
}

function _applyAndAdvance(move, preState = null, botEngine = null) {
    if (_humanTimer) { clearTimeout(_humanTimer); _humanTimer = null; }

    // Notify all AI engines of this move (before state changes so pile is intact)
    for (const engine of Object.values(_engines)) {
        if (!engine) continue;
        engine.observeMove(_state, move);
        engine.advanceTree(move);
    }
    Update('STOP_TIMER');
    Update('ENABLE_PLAY', { enabled: false });
    Update('ENABLE_DRAW', { enabled: false });
    Update('DESELECT_ALL');

    // Sync visuals: for AI plays, remove card from hand first then add to pile
    const dm  = decodeMove(move);
    const _cp = _state.currentPlayer;
    if (_cp === HUMAN && dm.type !== 'draw' && dm.cards.length === 4) _humanFoursThisGame++;
    if (dm.type === 'draw') {
        Update('REMOVE_FROM_PILE', { count: dm.count });
    } else if (_cp !== HUMAN) {
        // Show AI hand with card already gone before it lands on the pile
        Update('RENDER_HAND', {
            playerId: PLAYER_IDS[_cp],
            count: Math.max(0, _popcount(_state.hands[_cp]) - dm.cards.length),
        });
        const _played = dm.cards;
        if (_pileAddTimer) { clearTimeout(_pileAddTimer); _pileAddTimer = null; }
        _pileAddTimer = setTimeout(() => {
            _pileAddTimer = null;
            for (const card of _played) Update('ADD_TO_PILE', { card });
        }, 150);
    } else {
        for (const card of dm.cards) {
            Update('ADD_TO_PILE', { card });
        }
    }

    _state = applyMove(_state, move);

    if (_allHumansEliminated()) {
        setTimeout(_forceEndGame, POST_MOVE_MS);
        return;
    }

    // ===== TEST_BLOCK_START — reveal window in training mode for AI moves =====
    if (appState.isTrainingMode && preState !== null) {
        const legalMoves = getPossibleMoves(preState); // includes draw option
        Update('SHOW_REVEAL_WINDOW', {
            preState, move, botEngine, legalMoves,
            onCorrection: (correctedMove) => _applyTrainingCorrection(preState, move, correctedMove, botEngine),
            onApprove:    () => setTimeout(_startTurn, POST_MOVE_MS),
        });
        return;
    }
    // ===== TEST_BLOCK_END =====
    setTimeout(_startTurn, POST_MOVE_MS);
}

/**
 * Human turn timer expired — auto-play the lowest legal single card,
 * or the lowest non-draw move if no single-card play exists,
 * or draw if there are no play moves at all.
 */
function _humanTimerExpired() {
    _humanTimer = null;
    const hi = _mpMode ? _myMPIdx : HUMAN;
    if (!_state || !_gameActive || _state.currentPlayer !== hi) return;

    const moves     = getPossibleMoves(_state);
    const playMoves = moves.filter(m => !(m & DRAW_FLAG));

    let chosen;
    if (playMoves.length > 0) {
        const singles = playMoves.filter(m => _popcount(m & 0xFFFFFF) === 1);
        const pool    = singles.length > 0 ? singles : playMoves;
        chosen = pool.reduce((best, m) => {
            const bLow = best & -best;
            const mLow = m    & -m;
            return mLow < bLow ? m : best;
        });
    } else {
        chosen = moves.find(m => !!(m & DRAW_FLAG));
    }
    if (chosen === undefined) return;
    if (_mpMode) _applyMPMove(chosen);
    else         _applyAndAdvance(chosen);
}

/**
 * Host: when a remote human's 15 s turn timer expires before their disconnect
 * is detected, play the lowest valid card (or draw) on their behalf so the
 * game keeps moving.
 */
async function _remoteHumanTimerExpired(playerIdx) {
    _humanTimer = null;
    if (!_state || !_gameActive || _state.currentPlayer !== playerIdx) return;
    if (_mpBotIdxs.includes(playerIdx)) return;  // already handled as bot

    const moves     = getPossibleMoves(_state);
    const playMoves = moves.filter(m => !(m & DRAW_FLAG));
    let chosen;
    if (playMoves.length > 0) {
        const singles = playMoves.filter(m => _popcount(m & 0xFFFFFF) === 1);
        const pool    = singles.length > 0 ? singles : playMoves;
        chosen = pool.reduce((best, m) => {
            const bLow = best & -best;
            const mLow = m    & -m;
            return mLow < bLow ? m : best;
        });
    } else {
        chosen = moves.find(m => !!(m & DRAW_FLAG));
    }
    if (chosen === undefined) return;

    for (const eng of Object.values(_engines)) {
        eng.observeMove(_state, chosen);
        eng.advanceTree(chosen);
    }

    const dm = decodeMove(chosen);
    const cp = _state.currentPlayer;
    Update('STOP_TIMER');
    if (dm.type === 'draw') {
        Update('REMOVE_FROM_PILE', { count: dm.count });
    } else {
        Update('RENDER_HAND', {
            playerId: _mpDispId(cp),
            count:    Math.max(0, _popcount(_state.hands[cp]) - dm.cards.length),
        });
        const played = dm.cards;
        setTimeout(() => { for (const card of played) Update('ADD_TO_PILE', { card }); }, 150);
    }

    const newState = applyMove(_state, chosen);
    _state = newState;
    try   { await MP.pushMove(newState); }
    catch (e) { console.error('[MP] remoteHumanTimerExpired pushMove failed:', e); }
    setTimeout(_startMPTurn, POST_MOVE_MS);
}

/**
 * Returns true when every human seat has cleared their hand.
 * Local: only seat 0 is human. MP: every seat not in _mpBotIdxs.
 */
function _allHumansEliminated() {
    if (_mpMode) {
        for (let i = 0; i < NUM_PLAYERS; i++) {
            if (!_mpBotIdxs.includes(i) && !(_state.eliminated & (1 << i))) return false;
        }
        return true;
    }
    return !!(_state.eliminated & (1 << HUMAN));
}

function _endGame() {
    _gameActive = false;
    Update('STOP_TIMER');
    Update('ENABLE_PLAY', { enabled: false });
    Update('ENABLE_DRAW', { enabled: false });

    _renderHands(decodeState(_state));

    // ===== TEST_BLOCK_START — training backprop + flush =====
    console.log(`[GC] _endGame called. isTrainingMode=${appState.isTrainingMode}`);
    if (appState.isTrainingMode) {
        // Find the loser (the one player NOT eliminated = still holds cards)
        let loser = -1;
        for (let p = 0; p < NUM_PLAYERS; p++) {
            if (!(_state.eliminated & (1 << p))) { loser = p; break; }
        }
        if (loser >= 0) {
            const winner = (loser === HUMAN) ? 'bot' : 'human'; // winner is the NON-loser
            sandbox.applyBackprop(winner);
            sandbox.flushToFirebase().catch(console.warn);
        }
    }
    // ===== TEST_BLOCK_END =====

    for (let p = 0; p < NUM_PLAYERS; p++) {
        if (!(_state.eliminated & (1 << p))) {
            const humanSeat = _mpMode ? _myMPIdx : HUMAN;
            const survived  = p !== humanSeat;
            Economy.recordGameResult({
                survived,
                foursPlayedThisGame: _humanFoursThisGame,
                gameTimeMs:          Date.now() - _gameStartTime,
                maxCardsHeld:        _humanMaxCards,
            }).catch(console.error);
            const text   = _bannerText(p);
            const isMP   = _mpMode;
            const isHost = MP.isHost();
            _mpMode = false;
            Update('SHOW_GAME_OVER_BANNER', { text, isMP, isHost });
            return;
        }
    }
    _mpMode = false;
}

function _bannerText(loserIdx) {
    const humanSeat = _mpMode ? _myMPIdx : HUMAN;
    const isBot     = _mpMode ? _mpBotIdxs.includes(loserIdx) : loserIdx !== HUMAN;
    if (isBot)                   return 'BOTS ARE LOSERS!';
    if (loserIdx === humanSeat)  return 'YOU ARE THE LOSER!';
    return `${PLAYER_NAMES[loserIdx]} IS THE LOSER!`;
}

function _forceEndGame() {
    _gameActive = false;
    Update('STOP_TIMER');
    Update('ENABLE_PLAY', { enabled: false });
    Update('ENABLE_DRAW', { enabled: false });

    _renderHands(decodeState(_state));

    // In _forceEndGame all humans cleared their hands — human always survived
    // ===== TEST_BLOCK_START — training backprop + flush (human won) =====
    console.log(`[GC] _forceEndGame called. isTrainingMode=${appState.isTrainingMode}`);
    if (appState.isTrainingMode) {
        sandbox.applyBackprop('human');
        sandbox.flushToFirebase().catch(console.warn);
    }
    // ===== TEST_BLOCK_END =====
    Economy.recordGameResult({
        survived:            true,
        foursPlayedThisGame: _humanFoursThisGame,
        gameTimeMs:          Date.now() - _gameStartTime,
        maxCardsHeld:        _humanMaxCards,
    }).catch(console.error);

    const loserIdx = _findForcedLoser();
    const text     = _bannerText(loserIdx);
    const isMP     = _mpMode;
    const isHost   = MP.isHost();
    _mpMode = false;
    Update('SHOW_GAME_OVER_BANNER', { text, isMP, isHost });
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
    const humanIdx = _mpMode ? _myMPIdx : HUMAN;
    if (_gameActive && ds.hands[humanIdx]) {
        const cnt = ds.hands[humanIdx].length;
        if (cnt > _humanMaxCards) _humanMaxCards = cnt;
    }
    for (let p = 0; p < NUM_PLAYERS; p++) {
        const dispId = _mpDispId(p);
        if (p === humanIdx) {
            // In MP: compare actual card content to avoid unnecessary re-renders
            // (prevents portrait-mode hand blink on other players' moves).
            const needsRender = _mpMode
                ? _handNeedsRender(dispId, ds.hands[p])
                : (!document.getElementById(dispId) ||
                   document.getElementById(dispId).querySelectorAll('.card').length !== ds.hands[p].length);
            if (needsRender) {
                Update('RENDER_HAND', { playerId: dispId, cards: ds.hands[p] });
            }
        } else {
            Update('RENDER_HAND', { playerId: dispId, count: ds.hands[p].length });
        }
    }
}

function _handNeedsRender(containerId, expectedCards) {
    const container = document.getElementById(containerId);
    if (!container) return true;
    const els = container.querySelectorAll('.card');
    if (els.length !== expectedCards.length) return true;
    for (let i = 0; i < expectedCards.length; i++) {
        if (els[i].dataset.rank !== expectedCards[i].rank ||
            els[i].dataset.suit !== expectedCards[i].suit) return true;
    }
    return false;
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

// ============================================================
// Multiplayer Mode
// ============================================================

// ============================================================
// Post-game handlers (NEW GAME / MAIN MENU)
// ============================================================

function _handleNewGame() {
    if (_lastMPMode) {
        if (MP.isHost()) {
            const newState = createInitialState(NUM_PLAYERS);
            MP.restartGame(newState).catch(e => console.error('[MP] restartGame failed:', e));
            _startMPGame({
                rawState:   MP.serialiseState(newState),
                players:    MP.getPlayers(),
                myIdx:      MP.getPlayerIndex(),
                maxPlayers: MP.getMaxPlayers(),
            });
        }
        // Guest: screen stays; Firebase 'gameStart' triggers _onMPGameStart
    } else {
        _startGame(_lastLocalConfig);
    }
}

function _handleMainMenu() {
    _gameActive = false;
    _mpMode     = false;
    if (_abandonTimer) { clearTimeout(_abandonTimer); _abandonTimer = null; }
    if (_lastMPMode) {
        MP.clearLastRoom();
        if (MP.isHost()) {
            MP.hostReturnToMenu().catch(e => console.error('[MP] hostReturnToMenu failed:', e));
        } else {
            MP.leaveRoom();
        }
    }
}

function _handleHostLeft() {
    MP.leaveRoom();
}

function _handlePlayerDisconnected({ uid, playerIdx, nickname, wasHost }) {
    if (MP.isHost() && !_mpBotIdxs.includes(playerIdx)) {
        _mpBotIdxs.push(playerIdx);
        _disconnectedUids[playerIdx] = uid;
        convertToBot(uid).catch(e => console.error('[MP] convertToBot failed:', e));

        // 5-minute reconnect window — after that, slot is permanently a bot
        _reconnectTimeouts[playerIdx] = setTimeout(() => {
            delete _reconnectTimeouts[playerIdx];
            delete _disconnectedUids[playerIdx];
            permanentBot(uid, `${nickname} (Bot)`)
                .catch(e => console.error('[MP] permanentBot failed:', e));
            Update('SHOW_MESSAGE', { text: `${nickname} timed out. AI will finish the game.` });
        }, 5 * 60 * 1000);

        // If it's currently this player's turn, restart the turn so the bot
        // branch in _startMPTurn picks up immediately.
        if (_gameActive && _state && _state.currentPlayer === playerIdx) {
            if (_humanTimer) { clearTimeout(_humanTimer); _humanTimer = null; }
            Update('STOP_TIMER');
            setTimeout(_startMPTurn, 300);
        }

        // If every human guest has now disconnected, start the 1-minute abandon
        // countdown.  We only trigger this when at least one human was present
        // (i.e. _disconnectedUids is non-empty) so a host-vs-bots game is
        // left untouched.
        const totalGuests = (_state?.numPlayers ?? 1) - 1;  // slots excluding host
        const botGuests   = _mpBotIdxs.filter(i => i !== _myMPIdx).length;
        const allGone     = botGuests >= totalGuests && Object.keys(_disconnectedUids).length > 0;
        if (allGone && !_abandonTimer) {
            _abandonTimer = setTimeout(() => {
                _abandonTimer = null;
                if (!_mpMode || !MP.isHost()) return;
                console.log('[MP] All human guests gone for 1 min — ending session.');
                MP.hostReturnToMenu().catch(e => console.error('[MP] abandon hostReturnToMenu:', e));
            }, 60_000);
        }
    }

    if (wasHost) {
        Update('SHOW_CONNECTION_OVERLAY', { mode: 'host' });
        tryPromoteHost().catch(e => console.error('[MP] host promotion failed:', e));
    }

    Update('PLAYER_STATUS', { playerId: _mpDispId(playerIdx), disconnected: true });
    Update('SHOW_MESSAGE', { text: `${nickname} disconnected. AI took over.` });
}

function _handlePlayerReconnected({ uid, playerIdx, nickname, turnsMissed }) {
    if (MP.isHost()) {
        clearTimeout(_reconnectTimeouts[playerIdx]);
        delete _reconnectTimeouts[playerIdx];
        delete _disconnectedUids[playerIdx];
        _mpBotIdxs = _mpBotIdxs.filter(i => i !== playerIdx);

        // A human is back — cancel the room-abandon countdown.
        if (_abandonTimer) { clearTimeout(_abandonTimer); _abandonTimer = null; }

        // If it's currently the reconnected player's turn, cancel any stale bot
        // or remote-human timer and restart _startMPTurn so they get a fresh window.
        if (_gameActive && _state && _state.currentPlayer === playerIdx) {
            if (_humanTimer) { clearTimeout(_humanTimer); _humanTimer = null; }
            Update('STOP_TIMER');
            setTimeout(_startMPTurn, 300);
        }
    }
    Update('PLAYER_STATUS', { playerId: _mpDispId(playerIdx), disconnected: false });
    Update('SHOW_MESSAGE', { text: `${nickname} reconnected!` });
}

function _handleHostChanged({ isMe }) {
    if (isMe) {
        // Keep the overlay visible for 2 s so players can read "Lost connection"
        // before dismissing it and starting the first turn as the new host.
        Update('SHOW_MESSAGE', { text: 'You are now the game host.' });
        setTimeout(() => {
            Update('HIDE_CONNECTION_OVERLAY');
            if (_gameActive) _startMPTurn();
        }, 2000);
    } else {
        Update('HIDE_CONNECTION_OVERLAY');
    }
}

function _handleHostHeartbeatLost({ uid, playerIdx, nickname }) {
    if (!_mpMode || !_gameActive) return;
    Update('SHOW_CONNECTION_OVERLAY', { mode: 'host' });
    if (playerIdx >= 0) Update('PLAYER_STATUS', { playerId: _mpDispId(playerIdx), disconnected: true });

    tryPromoteHost().catch(e => console.error('[MP] tryPromoteHost (heartbeat) failed:', e));

    // tryPromoteHost sets _isHost synchronously before its first await.
    // If this client was just promoted, take over the offline player's slot
    // so _startMPTurn drives their turns as bot and the game doesn't stall.
    if (MP.isHost() && _gameActive && playerIdx >= 0 && !_mpBotIdxs.includes(playerIdx)) {
        _mpBotIdxs.push(playerIdx);
        _disconnectedUids[playerIdx] = uid;
        convertToBot(uid).catch(e => console.error('[MP] convertToBot failed:', e));
        _reconnectTimeouts[playerIdx] = setTimeout(() => {
            delete _reconnectTimeouts[playerIdx];
            delete _disconnectedUids[playerIdx];
            permanentBot(uid, `${nickname} (Bot)`)
                .catch(e => console.error('[MP] permanentBot failed:', e));
            Update('SHOW_MESSAGE', { text: `${nickname} timed out. AI will finish the game.` });
        }, 5 * 60 * 1000);
    }
}

function _handleHostHeartbeatRestored() {
    // Hide overlay whether or not a new host was promoted in the meantime
    Update('HIDE_CONNECTION_OVERLAY');
}

function _handleConnectionLost() {
    if (!_mpMode || !_gameActive) return;
    Update('SHOW_CONNECTION_OVERLAY', { mode: 'self' });
}

function _handleConnectionRestored() {
    Update('HIDE_CONNECTION_OVERLAY');
    // Fallback: resume turn processing in case selfReconnected wasn't emitted
    if (_mpMode && _gameActive && MP.isHost()) setTimeout(_startMPTurn, 800);
}

function _handleSelfReconnected({ turnsMissed, wasHost, isStillHost }) {
    Update('HIDE_CONNECTION_OVERLAY');
    Update('PLAYER_STATUS', { playerId: 'yourCards', disconnected: false });

    const msg = turnsMissed > 0
        ? `Welcome back! AI played ${turnsMissed} turn${turnsMissed !== 1 ? 's' : ''} for you.`
        : 'Welcome back! Connection restored.';
    Update('SHOW_MESSAGE', { text: msg });

    if (wasHost && !isStillHost) {
        // Demoted while offline — stop managing bot timers
        for (const h of Object.values(_reconnectTimeouts)) clearTimeout(h);
        _reconnectTimeouts = {};
    }

    // Always resume turn processing after reconnection.
    // - If still host: drives bot turns that stalled during the outage.
    // - If guest/demoted: enables play buttons if it happens to be our turn.
    if (_mpMode && _gameActive) setTimeout(_startMPTurn, 800);
}

/** Called when the host clicks '▶ Start Game' in the MP lobby. */
function _handleMPHostStart({ players, maxPlayers }) {
    const humanIdxs = Object.values(players).map(p => p.idx);
    _mpBotIdxs = [];
    for (let i = 0; i < maxPlayers; i++) {
        if (!humanIdxs.includes(i)) _mpBotIdxs.push(i);
    }
    NUM_PLAYERS = maxPlayers;
    const state = createInitialState(NUM_PLAYERS);
    MP.startGame(state).catch(e => console.error('[MP] startGame failed:', e));
}

/**
 * Called by ui-manager after the lift-door animation completes.
 * Sets up the MP game state and board for this client.
 */
function _startMPGame({ rawState, players, myIdx, maxPlayers, isReconnect = false, turnsMissed = 0 }) {
    _lastMPMode = true;
    const initialState = MP.deserialiseState(rawState);

    // Seats that are either unoccupied or currently AI-controlled are bot seats
    const humanIdxs = Object.values(players)
        .filter(p => !p.isAI)
        .map(p => p.idx);
    _mpBotIdxs = [];
    for (let i = 0; i < maxPlayers; i++) {
        if (!humanIdxs.includes(i)) _mpBotIdxs.push(i);
    }

    // Restore disconnect tracking for any already-AI seats
    _disconnectedUids = {};
    _reconnectTimeouts = {};
    for (const [uid, p] of Object.entries(players)) {
        if (p.isAI && p.wasHuman) _disconnectedUids[p.idx] = uid;
    }

    _mpMode     = true;
    _myMPIdx    = myIdx;
    NUM_PLAYERS = maxPlayers;
    _state      = initialState;
    _gameActive = true;
    _gameStartTime      = Date.now();
    _humanMaxCards      = 0;
    _humanFoursThisGame = 0;

    const byIdx = {};
    for (const p of Object.values(players)) byIdx[p.idx] = p;
    for (let i = 0; i < NUM_PLAYERS; i++) {
        PLAYER_NAMES[i] = i === myIdx ? 'You'
            : (byIdx[i]?.nickname ?? `Player ${i + 1}`);
    }

    for (const engine of Object.values(_engines)) engine.resetKnowledge();

    Update('SETUP_PLAYERS', {
        numPlayers: NUM_PLAYERS,
        playerName: byIdx[myIdx]?.nickname ?? 'You',
        avatarPath: byIdx[myIdx]?.avatarPath ?? DEFAULT_AVATAR,
    });

    const ds = decodeState(_state);
    Update('CLEAR_PILE');

    if (isReconnect) {
        // Restore current pile and hands without a deal animation
        for (let i = 0; i < _state.pileSize; i++) Update('ADD_TO_PILE', { card: ds.pile[i] });
        for (let p = 0; p < NUM_PLAYERS; p++) {
            if (p === _myMPIdx) {
                Update('RENDER_HAND', { playerId: _mpDispId(p), cards: ds.hands[p] });
            } else {
                Update('RENDER_HAND', { playerId: _mpDispId(p), count: ds.hands[p].length });
            }
        }
        const missedText = turnsMissed > 0
            ? `Welcome back! AI played ${turnsMissed} turn${turnsMissed !== 1 ? 's' : ''} for you.`
            : 'Welcome back! You\'ve rejoined the game.';
        Update('SHOW_MESSAGE', { text: missedText });
    } else {
        Update('ADD_TO_PILE', { card: ds.pile[0] });
        const hands = {};
        for (let p = 0; p < NUM_PLAYERS; p++) hands[_mpDispId(p)] = ds.hands[p];
        Update('ANIMATE_DEAL', { hands, humanPlayerId: 'yourCards' });
    }

    // Show/hide player areas based on actual rotated seat occupancy
    const _occupied = new Set(Array.from({ length: NUM_PLAYERS }, (_, p) => _mpDispId(p)));
    Update('SETUP_PLAYER_AREAS', {
        showRight: _occupied.has('player1Cards'),
        showTop:   _occupied.has('player2Cards'),
        showLeft:  _occupied.has('player3Cards'),
    });

    // Set player names and avatars at each display position
    for (let p = 0; p < NUM_PLAYERS; p++) {
        Update('SET_PLAYER_NAME',   { playerId: _mpDispId(p), name: PLAYER_NAMES[p] });
        Update('SET_PLAYER_AVATAR', { playerId: _mpDispId(p), avatarPath: byIdx[p]?.avatarPath ?? DEFAULT_AVATAR });
    }

    // Restore disconnect visual indicators for any already-disconnected seats
    for (const [uid, p] of Object.entries(players)) {
        if (p.isAI && p.wasHuman) {
            Update('PLAYER_STATUS', { playerId: _mpDispId(p.idx), disconnected: true });
        }
    }

    MP.off('stateUpdate', _onMPStateUpdate);
    MP.on ('stateUpdate', _onMPStateUpdate);

    if (isReconnect) setTimeout(_startMPTurn, 600);
}

/** Firebase 'stateUpdate' — another player made a move; sync local state. */
function _onMPStateUpdate(rawState) {
    if (!_mpMode || !_gameActive) return;

    const incoming = MP.deserialiseState(rawState);

    // Skip echo of our own move (applied locally already in _applyMPMove / _mpBotTurn)
    if (_state &&
        incoming.currentPlayer === _state.currentPlayer &&
        incoming.eliminated    === _state.eliminated) {
        return;
    }

    // Visualise the move that was just made
    const prevCP = _state ? _state.currentPlayer : -1;
    if (prevCP >= 0 && prevCP !== _myMPIdx) {
        const ds         = decodeState(incoming);
        const pileEl     = document.getElementById('pile');
        const uiPileCount = pileEl ? pileEl.children.length : 0;
        if (incoming.pileSize > uiPileCount) {
            for (let i = uiPileCount; i < incoming.pileSize; i++) {
                Update('ADD_TO_PILE', { card: ds.pile[i] });
            }
            Update('RENDER_HAND', {
                playerId: _mpDispId(prevCP),
                count:    _popcount(incoming.hands[prevCP]),
            });
        } else if (incoming.pileSize < uiPileCount) {
            Update('REMOVE_FROM_PILE', { count: uiPileCount - incoming.pileSize });
        }
    }

    _state = incoming;
    setTimeout(_startMPTurn, POST_MOVE_MS);
}

/** Start a turn in multiplayer mode. */
function _startMPTurn() {
    if (_humanTimer) { clearTimeout(_humanTimer); _humanTimer = null; }
    if (!_state || !_gameActive) return;

    if (isGameOver(_state)) { _endGame(); return; }
    if (_allHumansEliminated()) { _forceEndGame(); return; }

    const ds = decodeState(_state);
    const p  = _state.currentPlayer;

    _renderHands(ds);
    Update('HIGHLIGHT_PLAYER', { playerId: _mpDispId(p) });
    Update('SHOW_MESSAGE', {
        text: p === _myMPIdx
            ? `Your turn  ·  Top: ${ds.topCard.rank}${ds.topCard.suit}`
            : `${PLAYER_NAMES[p]}'s turn  ·  Top: ${ds.topCard.rank}${ds.topCard.suit}`,
    });

    const drawable  = _state.pileSize - 1;
    const drawCount = Math.min(3, drawable);

    if (p === _myMPIdx) {
        _updateDrawBtn(drawCount);
        Update('ENABLE_PLAY', { enabled: true });
        Update('ENABLE_DRAW', { enabled: drawable > 0 });
        Update('START_TIMER', { playerId: _mpDispId(p), isHuman: true });
        _humanTimer = setTimeout(_humanTimerExpired, HUMAN_TURN_MS);
    } else if (_mpBotIdxs.includes(p) && MP.isHost()) {
        Update('ENABLE_PLAY', { enabled: false });
        Update('ENABLE_DRAW', { enabled: false });
        Update('START_TIMER', { playerId: _mpDispId(p), isHuman: false });
        setTimeout(() => _mpBotTurn(p), _aiDelay());
    } else {
        Update('ENABLE_PLAY', { enabled: false });
        Update('ENABLE_DRAW', { enabled: false });
        Update('START_TIMER', { playerId: _mpDispId(p), isHuman: true });
        // Host enforces the 15 s timer so a slow/disconnected remote player
        // can't stall the game indefinitely before the heartbeat fires.
        if (MP.isHost()) {
            _humanTimer = setTimeout(() => _remoteHumanTimerExpired(p), HUMAN_TURN_MS);
        }
    }
}

/** Host: run Shark bot for the given seat and push new state to Firebase. */
async function _mpBotTurn(playerIdx) {
    if (!_state || !_gameActive || _state.currentPlayer !== playerIdx) return;
    if (!_mpBotIdxs.includes(playerIdx)) return;   // player reclaimed slot

    const engine = _engines[playerIdx] ?? (_engines[playerIdx] = new ISMCTSEngine('shark'));
    const move   = engine.chooseMove(_state);

    // Increment counter if this seat belongs to a disconnected human
    const dcUid = _disconnectedUids[playerIdx];
    if (dcUid) incrementTurnsMissed(dcUid).catch(() => {});

    for (const eng of Object.values(_engines)) {
        eng.observeMove(_state, move);
        eng.advanceTree(move);
    }

    const dm = decodeMove(move);
    const cp = _state.currentPlayer;
    Update('STOP_TIMER');
    if (dm.type === 'draw') {
        Update('REMOVE_FROM_PILE', { count: dm.count });
    } else {
        Update('RENDER_HAND', {
            playerId: _mpDispId(cp),
            count:    Math.max(0, _popcount(_state.hands[cp]) - dm.cards.length),
        });
        const played = dm.cards;
        setTimeout(() => { for (const card of played) Update('ADD_TO_PILE', { card }); }, 150);
    }

    const newState = applyMove(_state, move);
    _state = newState;

    try   { await MP.pushMove(newState); }
    catch (e) { console.error('[MP] bot pushMove failed:', e); }
    engine.cleanup();

    // Echo is skipped on the host (same currentPlayer after local update),
    // so chain the next turn directly instead of waiting for Firebase.
    setTimeout(_startMPTurn, POST_MOVE_MS);
}

/**
 * Local human applies a move in multiplayer:
 * update UI immediately, apply locally, then push to Firebase.
 */
async function _applyMPMove(move) {
    if (_humanTimer) { clearTimeout(_humanTimer); _humanTimer = null; }

    Update('STOP_TIMER');
    Update('ENABLE_PLAY', { enabled: false });
    Update('ENABLE_DRAW', { enabled: false });
    Update('DESELECT_ALL');

    const dm        = decodeMove(move);
    const prevState = _state;              // pre-move state needed by engines
    if (dm.type !== 'draw' && dm.cards.length === 4) _humanFoursThisGame++;
    const newState  = applyMove(_state, move);
    _state = newState;

    const ds = decodeState(_state);
    if (dm.type === 'draw') {
        Update('REMOVE_FROM_PILE', { count: dm.count });
    } else {
        for (const card of dm.cards) Update('ADD_TO_PILE', { card });
    }
    // Re-render hand immediately — the echo is suppressed so without this the
    // hand only updates when the next opponent Firebase event arrives.
    Update('RENDER_HAND', { playerId: _mpDispId(_myMPIdx), cards: ds.hands[_myMPIdx] });

    // Yield to the browser before heavy engine work so the card appears on the
    // pile right away and _onDragEnd can remove the drag preview without delay.
    await new Promise(r => setTimeout(r, 0));

    for (const engine of Object.values(_engines)) {
        engine.observeMove(prevState, move);
        engine.advanceTree(move);
    }

    try   { await MP.pushMove(newState); }
    catch (e) { console.error('[MP] pushMove failed:', e); }

    // Chain the next turn directly.  The Firebase echo is always suppressed for
    // our own moves, so if the only other human is eliminated (or it's a bot's
    // turn next) nobody else will push and trigger _onMPStateUpdate → _startMPTurn.
    // The double-call when another human IS active is harmless: their branch just
    // highlights the other player and waits; the guard in _mpBotTurn prevents
    // duplicate bot execution.
    setTimeout(_startMPTurn, POST_MOVE_MS);
}
