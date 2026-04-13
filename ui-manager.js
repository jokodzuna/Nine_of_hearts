import * as MP from './multiplayer.js';

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

// ---- Welcome menu config ----
let _playerName     = 'Player';
let _selectedAvatar = 0;
let _numPlayers     = 4;
let _difficulty     = 'easy';
let _gameMode       = 'bots';
let _mpTakenAvatars = new Set();   // avatarIdx values taken by OTHER lobby players

const _AVATAR_BG_POS = [
    '14% 15%', '50% 15%', '86% 15%',
    '14% 50%', '50% 50%', '86% 50%',
    '14% 85%', '50% 85%', '86% 85%',
];

let _lastTap  = { time: 0, card: null };
let _touchTap = { time: 0, card: null, startX: 0, startY: 0 };
let _mouseTap = { card: null, startX: 0, startY: 0 };

let _connOverlay = null;  // full-screen connection-lost overlay element

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
let _cbMPGameReady   = null;   // ({rawState,players,myIdx,maxPlayers}) => void
let _cbMPHostStart   = null;   // ({players,maxPlayers}) => void
let _cbNewGame       = null;   // () => void
let _cbMainMenu      = null;   // () => void
let _cbHostLeft      = null;   // () => void

/** Fires when the human player drags/taps cards onto the pile. */
export function onCardPlayed(fn)    { _cbCardPlayed    = fn; }

/** Fires when the human player clicks the Draw button. */
export function onDrawRequested(fn) { _cbDrawRequested = fn; }

/** Fires when the START button on the welcome screen is pressed. */
export function onGameStart(fn)     { _cbGameStart     = fn; }

/** Fires once the deal animation has fully completed. */
export function onDealComplete(fn)  { _cbDealComplete  = fn; }

/** Fires after the MP door animation with the initial game payload. */
export function onMultiplayerReady(fn) { _cbMPGameReady = fn; }

/** Fires when the host clicks Start in the MP lobby. */
export function onMPHostStart(fn)      { _cbMPHostStart = fn; }

/** Fires when the player clicks NEW GAME on the post-game screen. */
export function onNewGame(fn)          { _cbNewGame  = fn; }

/** Fires when the player clicks MAIN MENU on the post-game screen. */
export function onMainMenu(fn)         { _cbMainMenu = fn; }

/** Fires when the MP host returns to main menu, directing guests to follow. */
export function onHostLeft(fn)         { _cbHostLeft = fn; }

/** Returns the current welcome-screen configuration chosen by the player. */
export function getPlayerConfig() {
    return {
        playerName:  _playerName,
        avatarIndex: _selectedAvatar,
        numPlayers:  _numPlayers,
        difficulty:  _difficulty,
        gameMode:    _gameMode,
    };
}

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
        case 'SHOW_GAME_OVER_BANNER':
            _showGameOverBanner(payload.text ?? '', payload.isMP ?? false, payload.isHost ?? false);
            break;
        case 'SHOW_MAIN_MENU':
            _showMainMenuScreen();
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
            _animateDealing(payload.hands, payload.humanPlayerId).then(() => {
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
        case 'SETUP_PLAYERS':
            _setupPlayers(payload.numPlayers ?? 4, payload.playerName ?? 'Player', payload.avatarIndex ?? 0);
            break;
        case 'SET_PLAYER_NAME': {
            const infoId = INFO_ID[payload.playerId];
            if (infoId) {
                const nameEl = document.querySelector(`#${infoId} .player-name`);
                if (nameEl) nameEl.textContent = payload.name ?? '';
            }
            break;
        }
        case 'SETUP_PLAYER_AREAS': {
            const rightArea = document.querySelector('.player-area.player-right');
            const topArea   = document.querySelector('.player-area.player-top');
            const leftArea  = document.querySelector('.player-area.player-left');
            if (rightArea) rightArea.style.display = payload.showRight ? '' : 'none';
            if (topArea)   topArea.style.display   = payload.showTop   ? '' : 'none';
            if (leftArea)  leftArea.style.display  = payload.showLeft  ? '' : 'none';
            break;
        }
        case 'PLAYER_STATUS': {
            const infoId = INFO_ID[payload.playerId];
            if (!infoId) break;
            const infoEl = document.getElementById(infoId);
            if (!infoEl) break;
            infoEl.classList.toggle('player-disconnected', !!payload.disconnected);
            break;
        }
        case 'SHOW_CONNECTION_OVERLAY': {
            _showConnectionOverlay(payload.mode);
            break;
        }
        case 'HIDE_CONNECTION_OVERLAY': {
            _hideConnectionOverlay();
            break;
        }
        case 'SET_PLAYER_AVATAR': {
            const infoId = INFO_ID[payload.playerId];
            if (infoId) {
                const avatarEl = document.querySelector(`#${infoId} .avatar`);
                if (avatarEl) {
                    avatarEl.textContent = '';
                    const pos = _AVATAR_BG_POS[payload.avatarIdx] ?? _AVATAR_BG_POS[0];
                    Object.assign(avatarEl.style, {
                        backgroundImage:    "url('Images/avatars/cartoon-pack-workers-avatars/155153-OUMT5G-397.jpg')",
                        backgroundSize:     '435% 435%',
                        backgroundPosition: pos,
                        backgroundRepeat:   'no-repeat',
                    });
                }
            }
            break;
        }
        default:
            console.warn(`[ui-manager] Unknown command: "${command}"`);
    }
}

// ---- Connection-lost overlay ------------------------------------------------

function _showConnectionOverlay(mode) {
    if (_connOverlay) return;   // already visible
    _connOverlay = document.createElement('div');
    _connOverlay.className = 'connection-overlay';

    const line1 = document.createElement('p');
    const line2 = document.createElement('p');

    if (mode === 'host') {
        line1.textContent = 'Lost connection to Host\u2026';
        line2.textContent = "Attempting to resume game\u2026 Please don't close the app!";
    } else {
        line1.textContent = 'Connection lost.';
        line2.textContent = 'Attempting to rejoin\u2026';
    }

    _connOverlay.append(line1, line2);
    document.body.appendChild(_connOverlay);
}

function _hideConnectionOverlay() {
    if (!_connOverlay) return;
    _connOverlay.remove();
    _connOverlay = null;
}

// ---- Player setup -----------------------------------------------------------

function _setupPlayers(numPlayers, playerName, avatarIndex) {
    // Clear disconnect indicators from any previous game
    for (const id of Object.values(INFO_ID)) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('player-disconnected');
    }

    const nameEl = document.querySelector('#yourInfo .player-name');
    if (nameEl) nameEl.textContent = playerName;

    const avatarEl = document.querySelector('#yourInfo .avatar');
    if (avatarEl) {
        avatarEl.textContent = '';
        const pos = _AVATAR_BG_POS[avatarIndex] ?? _AVATAR_BG_POS[0];
        Object.assign(avatarEl.style, {
            backgroundImage:    "url('Images/avatars/cartoon-pack-workers-avatars/155153-OUMT5G-397.jpg')",
            backgroundSize:     '435% 435%',
            backgroundPosition: pos,
            backgroundRepeat:   'no-repeat',
        });
    }

    const topArea  = document.querySelector('.player-area.player-top');
    const leftArea = document.querySelector('.player-area.player-left');
    if (topArea)  topArea.style.display  = numPlayers >= 3 ? '' : 'none';
    if (leftArea) leftArea.style.display = numPlayers >= 4 ? '' : 'none';
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

    try {
        _initAudio();
        if (_audioCtx && _audioCtx.state === 'suspended') {
            _audioCtx.resume().then(_playWelcomeSound).catch(() => { _welcomeSoundPending = true; });
        } else {
            _playWelcomeSound();
        }
    } catch (e) { _welcomeSoundPending = true; }

    // Go fullscreen on the very first user interaction — happens on the static
    // title card before any animation, so any viewport shake is imperceptible
    const _tryFullscreen = () => {
        const r = document.documentElement;
        if (r.requestFullscreen)            r.requestFullscreen().catch(() => {});
        else if (r.webkitRequestFullscreen) r.webkitRequestFullscreen();
    };
    document.addEventListener('pointerdown', _tryFullscreen, { once: true });

    // Title screen shows for 2 s, then doors slide open to reveal the menu
    setTimeout(() => {
        ws.classList.add('doors-open');
        document.body.classList.remove('welcome-active');
    }, 2000);
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
    document.querySelectorAll('.active-hand').forEach(a => a.classList.remove('active-hand'));
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

    if (playerId === HUMAN_ID) {
        const cardsEl = document.getElementById(playerId);
        if (cardsEl) {
            cardsEl.classList.add('active-hand');
            navigator.vibrate?.([100, 50, 100]);
        }
    }
}

// ============================================================
// Message
// ============================================================

function _showMessage(text) {
    const el = document.getElementById('message');
    if (el) el.textContent = text;
}

function _showGameOverBanner(text, isMP, isHost) {
    // Banner sits on top of the game table and stays until covered by closing doors
    const banner = document.createElement('div');
    banner.className = 'game-over-banner';
    const inner = document.createElement('div');
    inner.className = 'go-banner-inner';
    const textEl = document.createElement('div');
    textEl.className = 'go-banner-text';
    textEl.textContent = text;
    inner.appendChild(textEl);
    banner.appendChild(inner);
    document.body.appendChild(banner);

    // Door overlay — created with doors-open BEFORE appending so no opening animation fires
    const gs = document.createElement('div');
    gs.id = 'gameOverScreen';
    const doorLeft  = document.createElement('div');
    doorLeft.className = 'lift-door lift-door-left';
    doorLeft.appendChild(_createDoorInner());
    const doorRight = document.createElement('div');
    doorRight.className = 'lift-door lift-door-right';
    doorRight.appendChild(_createDoorInner());
    gs.appendChild(doorLeft);
    gs.appendChild(doorRight);
    gs.classList.add('doors-open');  // instantly open (off-screen) — no transition yet
    document.body.appendChild(gs);

    // After 3 s: close doors over the banner + game table
    setTimeout(() => {
        gs.classList.remove('doors-open');  // 1.2 s close animation
        setTimeout(() => {
            banner.remove();  // safely hidden behind closed doors
            // 1 s pause while doors are closed
            setTimeout(() => {
                // Build post-game menu and reveal it by opening doors
                const menu = _buildPostGameMenu(gs, isMP, isHost);
                gs.appendChild(menu);
                gs.classList.add('doors-open');  // 1.2 s open animation
            }, 1000);
        }, 1300);
    }, 3000);
}

/** Build a door-inner element with the full Nine of Hearts title content. */
function _createDoorInner() {
    const inner   = document.createElement('div');
    inner.className = 'door-inner';
    const content = document.createElement('div');
    content.className = 'door-content';
    const titleEl = document.createElement('div');
    titleEl.className = 'door-title';
    const nine = document.createElement('div'); nine.textContent = 'NINE';
    const ofRow = document.createElement('div'); ofRow.className = 'door-of';
    const ofSpan = document.createElement('span'); ofSpan.textContent = 'OF'; ofRow.appendChild(ofSpan);
    const hearts = document.createElement('div'); hearts.textContent = 'HEARTS';
    titleEl.append(nine, ofRow, hearts);
    const tagline = document.createElement('div');
    tagline.className = 'door-tagline';
    tagline.textContent = "DON'T BE A LOSER!";
    content.append(titleEl, tagline);
    inner.appendChild(content);
    return inner;
}

/** Build the post-game menu div and attach button handlers. */
function _buildPostGameMenu(gs, isMP, isHost) {
    const menu = document.createElement('div');
    menu.className = 'post-game-menu';

    const disableAll = () => menu.querySelectorAll('button').forEach(b => { b.disabled = true; });

    if (!isMP || isHost) {
        // Local game or MP host: show NEW GAME button
        const newGameBtn = document.createElement('button');
        newGameBtn.className = 'menu-btn menu-btn-start post-game-btn';
        newGameBtn.textContent = '\u25B6 NEW GAME';
        newGameBtn.addEventListener('click', () => {
            disableAll();
            gs.classList.remove('doors-open');  // 1.2 s close
            setTimeout(() => {
                menu.style.display = 'none';
                // 1 s pause, then open doors
                setTimeout(() => {
                    gs.classList.add('doors-open');  // 1.2 s open
                    setTimeout(() => {
                        if (_cbNewGame) _cbNewGame();  // start game 500 ms into opening
                        setTimeout(() => gs.remove(), 800);
                    }, 500);
                }, 1000);
            }, 1300);
        });
        menu.appendChild(newGameBtn);
    } else {
        // MP guest: waiting message
        const waitMsg = document.createElement('div');
        waitMsg.className = 'post-game-wait-msg';
        waitMsg.textContent = 'Waiting for host to start a new game\u2026';
        menu.appendChild(waitMsg);
    }

    const mainMenuBtn = document.createElement('button');
    mainMenuBtn.className = 'menu-btn post-game-btn';
    mainMenuBtn.textContent = 'MAIN MENU';
    mainMenuBtn.addEventListener('click', () => {
        disableAll();
        MP.clearLastRoom();      // clear immediately — before welcome screen is pre-rendered
        _refreshRejoinButton();  // remove button now so it never appears during transition
        _doMainMenuTransition(gs);
    });
    menu.appendChild(mainMenuBtn);

    return menu;
}

/** Shared door-close → 1 s pause → welcome-screen-open transition for main menu. */
function _doMainMenuTransition(gs) {
    // Pre-position welcome screen behind the door overlay (lower z-index)
    const ws = _prepareMainMenuScreen(false);
    if (ws) {
        ws.style.zIndex = '18000';
        ws.classList.remove('doors-open');
    }

    gs.classList.remove('doors-open');  // close door overlay (1.2 s)
    setTimeout(() => {
        // 1 s pause
        setTimeout(() => {
            gs.remove();
            if (ws) {
                ws.style.zIndex = '21000';
                requestAnimationFrame(() => requestAnimationFrame(() => ws.classList.add('doors-open')));
            }
            if (_cbMainMenu) _cbMainMenu();
            _refreshRejoinButton();   // clearLastRoom may have been called above — sync now
        }, 1000);
    }, 1300);
}

// ---- Rejoin button ---------------------------------------------------------

/**
 * Creates or removes the 'Rejoin Game' button on the welcome menu depending
 * on whether localStorage has a saved room code.
 */
function _refreshRejoinButton() {
    const existing = document.getElementById('rejoinBtn');
    const saved    = MP.getLastRoom();

    if (!saved) {
        if (existing) existing.remove();
        return;
    }

    if (existing) {
        // Update label in case code changed
        existing.textContent = `\u21A9 Rejoin Game (${saved.code})`;
        existing.disabled = false;
        return;
    }

    const btn = document.createElement('button');
    btn.id        = 'rejoinBtn';
    btn.className = 'menu-btn rejoin-btn';
    btn.textContent = `\u21A9 Rejoin Game (${saved.code})`;

    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            await MP.initAuth();
            const result = await MP.joinRoom({
                code:      saved.code,
                nickname:  _playerName,
                avatarIdx: _selectedAvatar,
            });
            if (result && result.reconnected) {
                _onMPGameStart({
                    rawState:    result.rawState,
                    players:     result.players,
                    myIdx:       result.playerIdx,
                    maxPlayers:  result.maxPlayers,
                    isReconnect: true,
                    turnsMissed: result.turnsMissed,
                });
            } else {
                // Joined a lobby that's still waiting
                _openWelcomePanel('multiplayer');
                _mpShowSection('lobby');
            }
        } catch (e) {
            // Room is gone or inaccessible — clear the stale data
            MP.clearLastRoom();
            btn.remove();
            _openMPPanel();
            setTimeout(() => _mpSetError(`Could not rejoin room ${saved.code}: ${e.message}`), 400);
        }
    });

    // Insert above the main START button so it's prominent
    const menu     = document.querySelector('.welcome-menu');
    const startBtn = document.getElementById('startButton');
    if (menu && startBtn) menu.insertBefore(btn, startBtn);
    else if (menu) menu.appendChild(btn);
}

/** Reset welcome screen state to main menu (not MP lobby panel). */
function _prepareMainMenuScreen(openDoors = true) {
    _gameMode = 'bots';
    _mpTakenAvatars = new Set();
    _updateMenuBtnLabels();
    document.querySelector('#welcomePanel-avatar .avatar-grid')
        ?.querySelectorAll('.avatar-preview').forEach(el => el.classList.remove('taken'));
    const ov = document.getElementById('welcomeOverlay');
    if (ov) { ov.classList.add('hidden'); ov.style.removeProperty('display'); }

    const ws = document.getElementById('welcomeScreen');
    if (!ws) return null;
    ws.style.display = '';
    ws.querySelector('.welcome-menu')?.style.removeProperty('display');
    _refreshRejoinButton();   // sync rejoin button with localStorage state
    if (openDoors) {
        ws.style.zIndex = '21000';
        ws.classList.remove('doors-open');
        requestAnimationFrame(() => requestAnimationFrame(() => ws.classList.add('doors-open')));
    }
    return ws;
}

/** Called via Update('SHOW_MAIN_MENU') — direct show without intermediate overlay. */
function _showMainMenuScreen() {
    _prepareMainMenuScreen(true);
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

// Maps game rank/suit tokens to image filename segments
const _RANK_IMG = { '9':'9', '10':'10', 'J':'Jack', 'Q':'Queen', 'K':'King', 'A':'Ace' };
const _SUIT_IMG = { '\u2660':'Spades', '\u2665':'Hearts', '\u2666':'Diamonds', '\u2663':'Clubs' };

function _cardImageSrc(rank, suit) {
    return `Images/Cards/${_RANK_IMG[rank]}_${_SUIT_IMG[suit]}.png`;
}

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
 * Creates a face-up card element using the card image from Images/Cards/.
 * @param {{rank:string, suit:string}} cardData
 * @param {boolean} interactive  — if true, wires up click/drag for the human player
 */
function _createFaceUpCard(cardData, interactive = false) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.rank = cardData.rank;
    card.dataset.suit = cardData.suit;

    const front = document.createElement('div');
    front.className = 'card-front';

    const img = document.createElement('img');
    img.src       = _cardImageSrc(cardData.rank, cardData.suit);
    img.alt       = `${cardData.rank}${cardData.suit}`;
    img.draggable = false;
    front.appendChild(img);
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

    // Suppress card entrance transitions during re-renders (prevents blink)
    container.classList.add('no-anim');
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
            container.classList.remove('no-anim');
            requestAnimationFrame(_updateHandLayout);
            requestAnimationFrame(_updateTopHandLayout);
        });
    } else {
        for (let i = 0; i < n; i++) {
            const el = _createCardBack();
            el.classList.add('dealt');
            container.appendChild(isSide ? _createSideWrap(el) : el);
        }
        requestAnimationFrame(() => {
            container.classList.remove('no-anim');
            if (playerId === 'player2Cards') {
                requestAnimationFrame(_updateTopHandLayout);
            }
            if (isSide) {
                requestAnimationFrame(() => _updateSideHandLayout(playerId));
            }
        });
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
    // Never remove the first child — the 9♥ is the permanent base card
    const maxRemovable = Math.max(0, pile.children.length - 1);
    const n = Math.min(count, maxRemovable);
    for (let i = 0; i < n; i++) {
        if (pile.lastElementChild !== pile.firstElementChild) pile.lastElementChild.remove();
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

/**
 * Dynamically compute the vertical card step for left/right side players so
 * their cards never overflow the container bounds regardless of hand size.
 *
 * Each .side-card-wrap has height = other-card-width (the card's physical width,
 * since it is rotated 90°).  The step controls how far apart adjacent cards sit.
 * The CSS default ratio is ~55.8 % (10.6u / 19u).  When there are too many cards
 * to fit at that ratio the step is compressed to fill the container exactly.
 *
 * @param {string} playerId  'player1Cards' or 'player3Cards'
 */
function _updateSideHandLayout(playerId) {
    const container = document.getElementById(playerId);
    if (!container) return;
    const wraps = Array.from(container.querySelectorAll('.side-card-wrap'));
    const n = wraps.length;
    if (n < 2) { wraps.forEach(w => { w.style.marginTop = ''; }); return; }

    const wrapH = wraps[0].getBoundingClientRect().height;  // other-card-width in px
    const areaH = container.clientHeight;                   // available height in px
    if (wrapH <= 0 || areaH <= 0) return;

    const maxStep = (areaH - wrapH) / (n - 1);  // step that exactly fills container
    const defStep = wrapH * 0.558;               // CSS default ratio (10.6u / 19u)
    const step    = Math.min(defStep, Math.max(4, maxStep));
    const neg     = -(wrapH - step);

    wraps[0].style.marginTop = '0';
    for (let i = 1; i < n; i++) wraps[i].style.marginTop = `${neg}px`;
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

async function _animateDealing(hands, humanId = HUMAN_ID) {
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
            const isHuman   = targetId === humanId;
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
// Welcome Menu — Overlay Panels
// ============================================================

const _RULES_TEXT = [
    'Matching Rank: You must play a card (or a four-of-a-kind) that is of equal or higher rank than the card currently on top of the pile.',
    'Suits: Suits do not matter; only the rank (number/face) is important.',
    'The Triple-9 Opening: If you hold all three remaining 9s (Spades, Diamonds, and Clubs), you may play them all at once directly onto the 9 of Hearts.',
    'Drawing Cards: If you cannot play a legal card\u2014or if you strategically choose not to\u2014you must DRAW.',
    'You pick up the top 3 cards from the pile. If there are only 1 or 2 cards available above the 9 of Hearts, you pick up all of them.',
    'Remember: The 9 of Hearts stays on the table!',
].join('\n\n');

function _makePanelBase(id, titleText) {
    const panel = document.createElement('div');
    panel.id = `welcomePanel-${id}`;
    panel.className = 'welcome-panel hidden';
    const h = document.createElement('div');
    h.className = 'panel-title';
    h.textContent = titleText;
    panel.appendChild(h);
    return panel;
}

function _makePanelCloseBtn(label = 'Close') {
    const btn = document.createElement('button');
    btn.className = 'menu-btn';
    btn.textContent = label;
    btn.addEventListener('click', _closeWelcomePanel);
    return btn;
}

function _buildWelcomeOverlay() {
    const ws = document.getElementById('welcomeScreen');
    if (!ws || document.getElementById('welcomeOverlay')) return;

    const ov = document.createElement('div');
    ov.id = 'welcomeOverlay';
    ov.className = 'welcome-overlay hidden';
    ov.addEventListener('click', e => { if (e.target === ov) _closeWelcomePanel(); });

    // ---- How to Play ----
    const howPanel = _makePanelBase('how-to-play', 'How to Play');
    const body = document.createElement('div');
    body.className = 'panel-body';
    body.innerHTML = _RULES_TEXT.split('\n\n').map(p => `<p>${p}</p>`).join('');
    howPanel.appendChild(body);
    howPanel.appendChild(_makePanelCloseBtn('Close'));

    // ---- Nickname ----
    const nickPanel = _makePanelBase('nickname', 'Your Nickname');
    const inp = document.createElement('input');
    inp.type = 'text'; inp.id = 'nicknameInput'; inp.className = 'nickname-input';
    inp.maxLength = 20; inp.placeholder = 'Enter nickname\u2026'; inp.value = _playerName;
    inp.addEventListener('input', () => { _playerName = inp.value.trim() || 'Player'; _updateMenuBtnLabels(); });
    nickPanel.appendChild(inp);
    nickPanel.appendChild(_makePanelCloseBtn('Save'));

    // ---- Avatar ----
    const avPanel = _makePanelBase('avatar', 'Choose Avatar');
    const grid = document.createElement('div');
    grid.className = 'avatar-grid';
    for (let i = 0; i < 9; i++) {
        const av = document.createElement('div');
        av.className = `avatar-preview avatar-pos-${i}${i === _selectedAvatar ? ' selected' : ''}`;
        av.addEventListener('click', () => {
            if (_mpTakenAvatars.has(i)) return;   // taken by another lobby player
            _selectedAvatar = i;
            grid.querySelectorAll('.avatar-preview').forEach((el, idx) => el.classList.toggle('selected', idx === i));
            if (MP.isInRoom()) MP.updateAvatar(i).catch(console.error);
        });
        grid.appendChild(av);
    }
    avPanel.appendChild(grid);
    avPanel.appendChild(_makePanelCloseBtn('Done'));

    // ---- Number of Players ----
    const playersPanel = _buildOptionPanel('players', 'Number of Players',
        [['2','2 Players'],['3','3 Players'],['4','4 Players']],
        () => String(_numPlayers),
        v => { _numPlayers = Number(v); _updateMenuBtnLabels(); }
    );

    // ---- Difficulty ----
    const diffPanel = _buildOptionPanel('difficulty', 'Difficulty',
        [['easy','Easy'],['medium','Medium'],['hard','Hard']],
        () => _difficulty,
        v => { _difficulty = v; _updateMenuBtnLabels(); }
    );

    // ---- Multiplayer panel ----
    const mpPanel = _buildMPPanel();

    ov.append(howPanel, nickPanel, avPanel, playersPanel, diffPanel, mpPanel);
    ws.appendChild(ov);
    _updateMenuBtnLabels();

    // Firebase: lobby updates → refresh lobby UI
    MP.on('lobby', _onMPLobby);
    // Firebase: game starts → door animation then hand off to game-controller
    MP.on('gameStart', _onMPGameStart);
    MP.on('hostLeft', _onMPHostLeft);
}

function _buildOptionPanel(id, title, options, getCurrent, onChange, disabledValues = new Set()) {
    const panel = _makePanelBase(id, title);
    const list  = document.createElement('div');
    list.className = 'option-list';
    for (const [value, label] of options) {
        const btn = document.createElement('button');
        const disabled = disabledValues.has(value);
        btn.className = `option-btn${value === getCurrent() ? ' selected' : ''}${disabled ? ' coming-soon' : ''}`;
        btn.textContent = label;
        btn.dataset.value = value;
        btn.disabled = disabled;
        if (!disabled) {
            btn.addEventListener('click', () => {
                list.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                onChange(value);
            });
        }
        list.appendChild(btn);
    }
    panel.appendChild(list);
    panel.appendChild(_makePanelCloseBtn('Done'));
    return panel;
}

function _openWelcomePanel(id) {
    const ov = document.getElementById('welcomeOverlay');
    if (!ov) return;
    ov.querySelectorAll('.welcome-panel').forEach(p => p.classList.add('hidden'));
    const panel = document.getElementById(`welcomePanel-${id}`);
    if (!panel) return;
    panel.classList.remove('hidden');
    ov.classList.remove('hidden');
    if (id === 'nickname') {
        const inp = panel.querySelector('.nickname-input');
        if (inp) { inp.value = _playerName; requestAnimationFrame(() => { inp.focus(); inp.select(); }); }
    }
}

function _closeWelcomePanel() {
    const ov = document.getElementById('welcomeOverlay');
    if (!ov) return;
    ov.classList.add('hidden');
    ov.querySelectorAll('.welcome-panel').forEach(p => p.classList.add('hidden'));
    _updateMenuBtnLabels();
}

// ============================================================
// Multiplayer Panel
// ============================================================

function _buildMPPanel() {
    const panel = _makePanelBase('multiplayer', 'Multiplayer');

    // -- Auth / loading section -----------------------------------------------
    const authSec = document.createElement('div');
    authSec.id = 'mp-auth';
    authSec.className = 'mp-section';
    const authMsg = document.createElement('p');
    authMsg.className = 'mp-status-msg';
    authMsg.textContent = 'Connecting…';
    authSec.appendChild(authMsg);

    // -- Create / Join section ------------------------------------------------
    const choiceSec = document.createElement('div');
    choiceSec.id = 'mp-choice';
    choiceSec.className = 'mp-section hidden';

    const createBtn = document.createElement('button');
    createBtn.className = 'menu-btn';
    createBtn.textContent = '＋ Create Room';
    createBtn.addEventListener('click', async () => {
        createBtn.disabled = true;
        _mpSetError('');
        try {
            await MP.createRoom({
                nickname:   _playerName,
                avatarIdx:  _selectedAvatar,
                maxPlayers: _numPlayers,
            });
            _mpShowSection('lobby');
        } catch (e) {
            _mpSetError(e.message);
            createBtn.disabled = false;
        }
    });

    const divider = document.createElement('div');
    divider.className = 'mp-divider';
    divider.textContent = '— or join with code —';

    const codeInput = document.createElement('input');
    codeInput.type = 'text';
    codeInput.id = 'mpCodeInput';
    codeInput.className = 'nickname-input mp-code-input';
    codeInput.maxLength = 4;
    codeInput.placeholder = '0000';
    codeInput.inputMode = 'numeric';

    const joinBtn = document.createElement('button');
    joinBtn.className = 'menu-btn';
    joinBtn.textContent = '→ Join Room';
    joinBtn.addEventListener('click', async () => {
        const code = codeInput.value.trim();
        if (!/^\d{4}$/.test(code)) { _mpSetError('Enter a 4-digit room code'); return; }
        joinBtn.disabled = true;
        _mpSetError('');
        try {
            const result = await MP.joinRoom({ code, nickname: _playerName, avatarIdx: _selectedAvatar });
            if (result && result.reconnected) {
                // Rejoin an in-progress game via the normal door animation
                _onMPGameStart({
                    rawState:    result.rawState,
                    players:     result.players,
                    myIdx:       result.playerIdx,
                    maxPlayers:  result.maxPlayers,
                    isReconnect: true,
                    turnsMissed: result.turnsMissed,
                });
            } else {
                _mpShowSection('lobby');
            }
        } catch (e) {
            _mpSetError(e.message);
            joinBtn.disabled = false;
        }
    });

    choiceSec.append(createBtn, divider, codeInput, joinBtn);

    // -- Lobby section --------------------------------------------------------
    const lobbySec = document.createElement('div');
    lobbySec.id = 'mp-lobby';
    lobbySec.className = 'mp-section hidden';

    const codeRow = document.createElement('div');
    codeRow.className = 'mp-code-row';
    codeRow.innerHTML = 'Room code: <span id="mp-code-display" class="mp-code-val">----</span>';

    const playerList = document.createElement('div');
    playerList.id = 'mp-player-list';
    playerList.className = 'mp-player-list';

    const hostCtrl = document.createElement('div');
    hostCtrl.id = 'mp-host-ctrl';
    hostCtrl.className = 'mp-host-ctrl hidden';

    const maxRow = document.createElement('div');
    maxRow.className = 'mp-max-row';
    const maxLabel = document.createElement('span');
    maxLabel.textContent = 'Max players: ';
    const minusBtn = document.createElement('button');
    minusBtn.className = 'mp-count-btn';
    minusBtn.textContent = '−';
    minusBtn.addEventListener('click', () => {
        const n = Math.max(2, MP.getMaxPlayers() - 1);
        MP.setMaxPlayers(n);
        document.getElementById('mp-max-val').textContent = n;
    });
    const maxVal = document.createElement('span');
    maxVal.id = 'mp-max-val';
    maxVal.textContent = String(_numPlayers);
    const plusBtn = document.createElement('button');
    plusBtn.className = 'mp-count-btn';
    plusBtn.textContent = '+';
    plusBtn.addEventListener('click', () => {
        const n = Math.min(4, MP.getMaxPlayers() + 1);
        MP.setMaxPlayers(n);
        document.getElementById('mp-max-val').textContent = n;
    });
    maxRow.append(maxLabel, minusBtn, maxVal, plusBtn);

    const startGameBtn = document.createElement('button');
    startGameBtn.id = 'mp-start-game-btn';
    startGameBtn.className = 'menu-btn menu-btn-start';
    startGameBtn.textContent = '▶ Start Game';
    startGameBtn.addEventListener('click', () => {
        if (_cbMPHostStart) {
            _cbMPHostStart({ players: MP.getPlayers(), maxPlayers: MP.getMaxPlayers() });
        }
    });

    hostCtrl.append(maxRow, startGameBtn);

    const guestWait = document.createElement('div');
    guestWait.id = 'mp-guest-wait';
    guestWait.className = 'mp-status-msg hidden';
    guestWait.textContent = 'Waiting for host to start…';

    lobbySec.append(codeRow, playerList, hostCtrl, guestWait);

    // -- Error display --------------------------------------------------------
    const errEl = document.createElement('div');
    errEl.id = 'mp-error';
    errEl.className = 'mp-error hidden';

    // -- Back button ----------------------------------------------------------
    const backBtn = _makePanelCloseBtn('← Back');
    backBtn.addEventListener('click', () => {
        MP.leaveRoom();
        _mpTakenAvatars = new Set();
        const avGrid = document.querySelector('#welcomePanel-avatar .avatar-grid');
        if (avGrid) avGrid.querySelectorAll('.avatar-preview').forEach(el => el.classList.remove('taken'));
        _mpShowSection('choice');
    });

    panel.append(authSec, choiceSec, lobbySec, errEl, backBtn);
    return panel;
}

/** Show one MP sub-section and hide the others. */
function _mpShowSection(id) {
    for (const sec of ['auth', 'choice', 'lobby']) {
        const el = document.getElementById(`mp-${sec}`);
        if (el) el.classList.toggle('hidden', sec !== id);
    }
    document.getElementById('mp-error')?.classList.add('hidden');
}

/** Set (or clear) the MP error message. */
function _mpSetError(msg) {
    const el = document.getElementById('mp-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
}

/** Open the MP panel and begin async auth. */
async function _openMPPanel() {
    _openWelcomePanel('multiplayer');
    _mpShowSection('auth');
    try {
        await MP.initAuth();
        _mpShowSection('choice');
        // Auto-fill saved room code if present
        const saved = MP.getLastRoom();
        if (saved) {
            const ci = document.getElementById('mpCodeInput');
            if (ci && !ci.value) ci.value = saved.code;
        }
    } catch (e) {
        _mpSetError('Connection failed: ' + e.message);
    }
}

/** Firebase 'lobby' event — update the lobby player list. */
function _onMPLobby(data) {
    const panel = document.getElementById('welcomePanel-multiplayer');
    if (!panel || panel.classList.contains('hidden')) return;

    const codeDisplay = document.getElementById('mp-code-display');
    if (codeDisplay) codeDisplay.textContent = data.code;

    const maxVal = document.getElementById('mp-max-val');
    if (maxVal) maxVal.textContent = data.maxPlayers;

    // Build player rows
    const list = document.getElementById('mp-player-list');
    if (list) {
        list.innerHTML = '';
        const sorted = Object.values(data.players).sort((a, b) => a.idx - b.idx);
        for (let i = 0; i < data.maxPlayers; i++) {
            const row = document.createElement('div');
            row.className = 'mp-player-row';
            const p = sorted.find(x => x.idx === i);
            if (p) {
                const av = document.createElement('div');
                av.className = `mp-player-avatar avatar-pos-${p.avatarIdx ?? 0}`;
                const name = document.createElement('span');
                name.textContent = (p.idx === data.myIdx ? '(You) ' : '') + (p.nickname || `Player ${i + 1}`);
                row.append(av, name);
            } else {
                row.classList.add('mp-player-empty');
                row.textContent = `— Seat ${i + 1} (open) —`;
            }
            list.appendChild(row);
        }
    }

    // Show/hide host controls
    const hostCtrl = document.getElementById('mp-host-ctrl');
    const guestWait = document.getElementById('mp-guest-wait');
    if (hostCtrl)  hostCtrl.classList.toggle('hidden',  !data.isHost);
    if (guestWait) guestWait.classList.toggle('hidden', data.isHost);

    // Refresh taken-avatar state so the avatar picker greys out other players' choices
    _mpTakenAvatars = new Set(
        Object.values(data.players)
            .filter(p => p.idx !== data.myIdx)
            .map(p => p.avatarIdx)
    );
    const avGrid = document.querySelector('#welcomePanel-avatar .avatar-grid');
    if (avGrid) {
        avGrid.querySelectorAll('.avatar-preview').forEach((el, i) => {
            el.classList.toggle('taken', _mpTakenAvatars.has(i));
        });
    }
}

/** Firebase 'gameStart' event — run the lift-door transition, then call _cbMPGameReady. */
function _onMPGameStart(data) {
    const doStart = () => { if (_cbMPGameReady) _cbMPGameReady(data); };

    const gs = document.getElementById('gameOverScreen');
    if (gs) {
        // Guest's post-game screen is showing; animate into the new game
        const afterClose = () => {
            gs.querySelector('.post-game-menu')?.style.setProperty('display', 'none');
            // 1 s pause, then open doors and start game (mirroring initial start)
            setTimeout(() => {
                gs.classList.add('doors-open');  // 1.2 s open
                setTimeout(() => {
                    doStart();  // 500 ms into opening — deal visible through doors
                    setTimeout(() => gs.remove(), 800);
                }, 500);
            }, 1000);
        };
        if (gs.classList.contains('doors-open')) {
            gs.classList.remove('doors-open');
            setTimeout(afterClose, 1300);
        } else {
            afterClose();
        }
        return;
    }

    const ws = document.getElementById('welcomeScreen');
    if (!ws) { doStart(); return; }

    // First-time game start from lobby — existing animation
    ws.style.zIndex = '21000';
    ws.classList.remove('doors-open');
    setTimeout(() => {
        ws.querySelectorAll('.welcome-menu, #welcomeOverlay').forEach(el => el.style.display = 'none');
        ws.classList.add('doors-open');
        setTimeout(() => {
            doStart();
            setTimeout(() => { ws.style.display = 'none'; }, 1300);
        }, 500);
    }, 1300);
}

/** Firebase 'hostLeft' event — guide guests back to main menu via door animation. */
function _onMPHostLeft() {
    if (_cbHostLeft) _cbHostLeft();
    MP.clearLastRoom();   // host ended the session — room is gone
    const gs = document.getElementById('gameOverScreen');
    if (gs) {
        _doMainMenuTransition(gs);
    } else {
        _showMainMenuScreen();
    }
}

function _updateMenuBtnLabels() {
    const diffLabel = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
    const nb = document.getElementById('nicknameBtn');
    if (nb) nb.textContent = `Nickname: ${_playerName}`;
    const pb = document.getElementById('playersBtn');
    if (pb) pb.textContent = `Players: ${_numPlayers}`;
    const db = document.getElementById('difficultyBtn');
    if (db) db.textContent = `Difficulty: ${diffLabel[_difficulty] ?? _difficulty}`;
    const mb = document.getElementById('multiBtn');
    if (mb) {
        const on = _gameMode === 'multi';
        mb.textContent = on ? '✓ Multiplayer ON' : 'Multiplayer';
        mb.classList.toggle('menu-btn-toggled', on);
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
    _buildWelcomeOverlay();

    document.getElementById('howToPlayBtn') ?.addEventListener('click', () => _openWelcomePanel('how-to-play'));
    document.getElementById('nicknameBtn')  ?.addEventListener('click', () => _openWelcomePanel('nickname'));
    document.getElementById('avatarBtn')    ?.addEventListener('click', () => _openWelcomePanel('avatar'));
    document.getElementById('playersBtn')   ?.addEventListener('click', () => _openWelcomePanel('players'));
    document.getElementById('difficultyBtn')?.addEventListener('click', () => _openWelcomePanel('difficulty'));
    document.getElementById('multiBtn')?.addEventListener('click', () => {
        _gameMode = _gameMode === 'multi' ? 'bots' : 'multi';
        _updateMenuBtnLabels();
        if (_gameMode === 'multi') _openMPPanel();
    });
    document.getElementById('exitButton')   ?.addEventListener('click', () => { /* no-op on web */ });

    _refreshRejoinButton();  // show rejoin button on first load if a room was saved

    const startBtn = document.getElementById('startButton');
    if (startBtn) {
        startBtn.addEventListener('click', e => {
            e.stopPropagation();
            startBtn.blur();                           // kill focus highlight
            _initAudio();
            if (_welcomeSoundPending) { _welcomeSoundPending = false; _playWelcomeSound(); }
            document.getElementById('tapToStart')?.remove();

            if (_gameMode === 'multi') {
                _openMPPanel();
                return;
            }

            const ws = document.getElementById('welcomeScreen');
            if (!ws) { if (_cbGameStart) _cbGameStart(); return; }

            // Raise above deal-fly (z:20000) so card-backs never flash over the doors
            ws.style.zIndex = '21000';
            ws.classList.remove('doors-open');             // close lift doors (1.2 s)
            setTimeout(() => {
                ws.querySelectorAll('.welcome-menu, #welcomeOverlay').forEach(el => el.style.display = 'none');
                ws.classList.add('doors-open');            // re-open (1.2 s)
                setTimeout(() => {
                    if (_cbGameStart) _cbGameStart();
                    setTimeout(() => { ws.style.display = 'none'; }, 1300);
                }, 500);
            }, 1300);
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

    document.getElementById('drawButton')
        ?.addEventListener('click', () => { if (_cbDrawRequested) _cbDrawRequested(); });

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
