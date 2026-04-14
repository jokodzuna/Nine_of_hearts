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
//   - Welcome/MP menu (see welcome-menu.js)
//   - Audio synthesis (see audio.js)
//   - Card DOM building / layout (see card-helpers.js)
//   - Animations (see animations.js)
// ============================================================

import { HUMAN_ID, SIDE_IDS, INFO_ID, TURN_DURATION_MS, AVATAR_BG_POS, AVATAR_IMG_SRC } from './constants.js';
import * as Audio        from './audio.js';
import * as CardHelpers  from './card-helpers.js';
import * as Animations   from './animations.js';
import * as WelcomeMenu  from './welcome-menu.js';

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

let _connOverlay = null;  // full-screen connection-lost overlay element

let _timer = { rafId: null, endTime: 0, isHuman: false, lastTick: null, container: null };

// ============================================================
// Bridge — Outgoing Callbacks
// (registered once by the external controller / ai_trainer)
// ============================================================

let _cbCardPlayed    = null;   // ([{rank, suit}]) => void
let _cbDrawRequested = null;   // () => void
let _cbDealComplete  = null;   // () => void

/** Fires when the human player drags/taps cards onto the pile. */
export function onCardPlayed(fn)    { _cbCardPlayed    = fn; }

/** Fires when the human player clicks the Draw button. */
export function onDrawRequested(fn) { _cbDrawRequested = fn; }

/** Fires once the deal animation has fully completed. */
export function onDealComplete(fn)  { _cbDealComplete  = fn; }

// ---- Callbacks owned by welcome-menu.js — forwarded on registration ---------

/** Fires when the START button on the welcome screen is pressed. */
export function onGameStart(fn)        { WelcomeMenu.setCallbacks({ onGameStart:   fn }); }

/** Fires after the MP door animation with the initial game payload. */
export function onMultiplayerReady(fn) { WelcomeMenu.setCallbacks({ onMPGameReady: fn }); }

/** Fires when the host clicks Start in the MP lobby. */
export function onMPHostStart(fn)      { WelcomeMenu.setCallbacks({ onMPHostStart: fn }); }

/** Fires when the player clicks NEW GAME on the post-game screen. */
export function onNewGame(fn)          { WelcomeMenu.setCallbacks({ onNewGame:     fn }); }

/** Fires when the player clicks MAIN MENU on the post-game screen. */
export function onMainMenu(fn)         { WelcomeMenu.setCallbacks({ onMainMenu:    fn }); }

/** Fires when the MP host returns to main menu, directing guests to follow. */
export function onHostLeft(fn)         { WelcomeMenu.setCallbacks({ onHostLeft:    fn }); }

/** Returns the current welcome-screen configuration chosen by the player. */
export function getPlayerConfig()      { return WelcomeMenu.getPlayerConfig(); }

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
            WelcomeMenu.showMainMenuScreen();
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
            Animations.animateDealing(payload.hands, payload.humanPlayerId).then(() => {
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
                    const pos = AVATAR_BG_POS[payload.avatarIdx] ?? AVATAR_BG_POS[0];
                    Object.assign(avatarEl.style, {
                        backgroundImage:    AVATAR_IMG_SRC,
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
        const pos = AVATAR_BG_POS[avatarIndex] ?? AVATAR_BG_POS[0];
        Object.assign(avatarEl.style, {
            backgroundImage:    AVATAR_IMG_SRC,
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
// Turn Timer  (visual only — progress ring)
// ============================================================

function _stopTimer() {
    if (_timer.rafId) cancelAnimationFrame(_timer.rafId);
    if (_timer.container) _timer.container.classList.remove('ring-warm', 'ring-hot');
    _timer = { rafId: null, endTime: 0, isHuman: false, lastTick: null, container: null };
}

function _startTimer(playerId, isHuman) {
    _stopTimer();
    const infoId = INFO_ID[playerId];
    const el     = infoId ? document.querySelector(`#${infoId} .avatar-container`) : null;
    if (!el) return;

    el.style.setProperty('--ring-progress', '1');
    _timer.container = el;
    _timer.isHuman   = isHuman;
    _timer.endTime   = performance.now() + TURN_DURATION_MS;
    _timer.lastTick  = null;

    const tick = () => {
        const rem      = Math.max(0, _timer.endTime - performance.now());
        const progress = rem / TURN_DURATION_MS;
        if (_timer.container) {
            _timer.container.style.setProperty('--ring-progress', String(progress));
            if (progress < 0.33) {
                _timer.container.classList.remove('ring-warm');
                _timer.container.classList.add('ring-hot');
            } else if (progress < 0.6) {
                _timer.container.classList.remove('ring-hot');
                _timer.container.classList.add('ring-warm');
            } else {
                _timer.container.classList.remove('ring-warm', 'ring-hot');
            }
        }

        if (_timer.isHuman) {
            const secs = Math.ceil(rem / 1000);
            if (secs <= 5 && secs >= 1 && _timer.lastTick !== secs) {
                _timer.lastTick = secs;
                Audio.playTickSound();
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
                const menu = WelcomeMenu.buildPostGameMenu(gs, isMP, isHost);
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
// Hand Rendering
// (Card DOM builders live in card-helpers.js)
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

    const _handlers = {
        onToggle:     _toggleSelection,
        onMouseDown:  _onCardMouseDown,
        onTouchStart: _onCardTouchStart,
        onTouchMove:  _onCardTouchMove,
        onTouchEnd:   _onCardTouchEnd,
    };

    if (isHuman && cards) {
        cards.forEach(cardData => {
            const el = CardHelpers.createFaceUpCard(cardData, true, _handlers);
            el.classList.add('dealt');
            container.appendChild(el);
        });
        requestAnimationFrame(() => {
            container.classList.remove('no-anim');
            requestAnimationFrame(CardHelpers.updateHandLayout);
            requestAnimationFrame(CardHelpers.updateTopHandLayout);
        });
    } else {
        for (let i = 0; i < n; i++) {
            const el = CardHelpers.createCardBack();
            el.classList.add('dealt');
            container.appendChild(isSide ? CardHelpers.createSideWrap(el) : el);
        }
        if (isSide) {
            container.getBoundingClientRect(); // force synchronous layout so margins are set before first paint
            CardHelpers.updateSideHandLayout(playerId);
            container.classList.remove('no-anim');
        } else {
            requestAnimationFrame(() => {
                container.classList.remove('no-anim');
                if (playerId === 'player2Cards') {
                    requestAnimationFrame(CardHelpers.updateTopHandLayout);
                }
            });
        }
    }
}

// ============================================================
// Pile
// ============================================================

function _addCardToPile(cardData) {
    const pile = document.getElementById('pile');
    if (!pile || !cardData) return;
    const card = CardHelpers.createFaceUpCard(cardData, false);
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
    WelcomeMenu.setup();  // builds overlay + wires all welcome-screen buttons

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
        CardHelpers.updateHandLayout();
        CardHelpers.updateTopHandLayout();
        CardHelpers.updateSideHandLayout('player1Cards');
        CardHelpers.updateSideHandLayout('player3Cards');
        _updateLayoutDebug();
    });
    window.addEventListener('orientationchange', () => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            CardHelpers.updateHandLayout();
            CardHelpers.updateTopHandLayout();
            CardHelpers.updateSideHandLayout('player1Cards');
            CardHelpers.updateSideHandLayout('player3Cards');
            _updateLayoutDebug();
        }));
    });
}

// ============================================================
// Init  (module is deferred — DOM is ready)
// ============================================================

Animations.setCardHandlers({
    onToggle:     _toggleSelection,
    onMouseDown:  _onCardMouseDown,
    onTouchStart: _onCardTouchStart,
    onTouchMove:  _onCardTouchMove,
    onTouchEnd:   _onCardTouchEnd,
});

_setupListeners();
WelcomeMenu.startWelcomeSequence();
_updateLayoutDebug();

if (location.search.includes('debug=1') || /#debug\b/i.test(location.hash)) {
    setInterval(_updateLayoutDebug, 250);
}
