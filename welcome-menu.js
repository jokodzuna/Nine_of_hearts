// ============================================================
// welcome-menu.js — Welcome screen, overlay panels, MP lobby
// Nine of Hearts
// ============================================================

import * as MP    from './multiplayer.js';
import * as Audio from './audio.js';
import { AVATAR_BG_POS, AVATAR_IMG_SRC } from './constants.js';

// ============================================================
// State
// ============================================================

let _playerName     = 'Player';
let _selectedAvatar = 0;
let _numPlayers     = 4;
let _difficulty     = 'easy';
let _gameMode       = 'bots';
let _mpTakenAvatars = new Set();

// ============================================================
// Callbacks (registered by ui-manager, forwarded from game-controller)
// ============================================================

let _cbGameStart   = null;
let _cbMPGameReady = null;
let _cbMPHostStart = null;
let _cbNewGame     = null;
let _cbMainMenu    = null;
let _cbHostLeft    = null;

/**
 * Register one or more game-level callbacks.
 * Call this from ui-manager whenever a callback is registered.
 */
export function setCallbacks(cbs) {
    if (cbs.onGameStart)   _cbGameStart   = cbs.onGameStart;
    if (cbs.onMPGameReady) _cbMPGameReady = cbs.onMPGameReady;
    if (cbs.onMPHostStart) _cbMPHostStart = cbs.onMPHostStart;
    if (cbs.onNewGame)     _cbNewGame     = cbs.onNewGame;
    if (cbs.onMainMenu)    _cbMainMenu    = cbs.onMainMenu;
    if (cbs.onHostLeft)    _cbHostLeft    = cbs.onHostLeft;
}

// ============================================================
// Public getters
// ============================================================

/** Returns the player configuration chosen on the welcome screen. */
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
// Welcome sequence (title card → doors open → menu)
// ============================================================

export function startWelcomeSequence() {
    const ws = document.getElementById('welcomeScreen');
    if (!ws) return;
    document.body.classList.add('welcome-active');

    try {
        Audio.initAndPlayWelcome();
    } catch (e) {
        Audio.setWelcomeSoundPending(true);
    }

    // Go fullscreen on the very first user interaction
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
// Panel helpers
// ============================================================

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

// ============================================================
// Multiplayer panel
// ============================================================

function _buildMPPanel() {
    const panel = _makePanelBase('multiplayer', 'Multiplayer');

    // -- Auth / loading section -----------------------------------------------
    const authSec = document.createElement('div');
    authSec.id = 'mp-auth';
    authSec.className = 'mp-section';
    const authMsg = document.createElement('p');
    authMsg.className = 'mp-status-msg';
    authMsg.textContent = 'Connecting\u2026';
    authSec.appendChild(authMsg);

    // -- Create / Join section ------------------------------------------------
    const choiceSec = document.createElement('div');
    choiceSec.id = 'mp-choice';
    choiceSec.className = 'mp-section hidden';

    const createBtn = document.createElement('button');
    createBtn.className = 'menu-btn';
    createBtn.textContent = '\uFF0B Create Room';
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
    divider.textContent = '\u2014 or join with code \u2014';

    const codeInput = document.createElement('input');
    codeInput.type = 'text';
    codeInput.id = 'mpCodeInput';
    codeInput.className = 'nickname-input mp-code-input';
    codeInput.maxLength = 4;
    codeInput.placeholder = '0000';
    codeInput.inputMode = 'numeric';

    const joinBtn = document.createElement('button');
    joinBtn.className = 'menu-btn';
    joinBtn.textContent = '\u2192 Join Room';
    joinBtn.addEventListener('click', async () => {
        const code = codeInput.value.trim();
        if (!/^\d{4}$/.test(code)) { _mpSetError('Enter a 4-digit room code'); return; }
        joinBtn.disabled = true;
        _mpSetError('');
        try {
            const result = await MP.joinRoom({ code, nickname: _playerName, avatarIdx: _selectedAvatar });
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
    minusBtn.textContent = '\u2212';
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
    startGameBtn.textContent = '\u25B6 Start Game';
    startGameBtn.addEventListener('click', () => {
        if (_cbMPHostStart) {
            _cbMPHostStart({ players: MP.getPlayers(), maxPlayers: MP.getMaxPlayers() });
        }
    });

    hostCtrl.append(maxRow, startGameBtn);

    const guestWait = document.createElement('div');
    guestWait.id = 'mp-guest-wait';
    guestWait.className = 'mp-status-msg hidden';
    guestWait.textContent = 'Waiting for host to start\u2026';

    lobbySec.append(codeRow, playerList, hostCtrl, guestWait);

    // -- Error display --------------------------------------------------------
    const errEl = document.createElement('div');
    errEl.id = 'mp-error';
    errEl.className = 'mp-error hidden';

    // -- Back button ----------------------------------------------------------
    const backBtn = _makePanelCloseBtn('\u2190 Back');
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

function _mpShowSection(id) {
    for (const sec of ['auth', 'choice', 'lobby']) {
        const el = document.getElementById(`mp-${sec}`);
        if (el) el.classList.toggle('hidden', sec !== id);
    }
    document.getElementById('mp-error')?.classList.add('hidden');
}

function _mpSetError(msg) {
    const el = document.getElementById('mp-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
}

async function _openMPPanel() {
    _openWelcomePanel('multiplayer');
    _mpShowSection('auth');
    try {
        await MP.initAuth();
        _mpShowSection('choice');
        const saved = MP.getLastRoom();
        if (saved) {
            const ci = document.getElementById('mpCodeInput');
            if (ci && !ci.value) ci.value = saved.code;
        }
    } catch (e) {
        _mpSetError('Connection failed: ' + e.message);
    }
}

// ---- Firebase event handlers ------------------------------------------------

function _onMPLobby(data) {
    const panel = document.getElementById('welcomePanel-multiplayer');
    if (!panel || panel.classList.contains('hidden')) return;

    const codeDisplay = document.getElementById('mp-code-display');
    if (codeDisplay) codeDisplay.textContent = data.code;

    const maxValEl = document.getElementById('mp-max-val');
    if (maxValEl) maxValEl.textContent = data.maxPlayers;

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
                row.textContent = `\u2014 Seat ${i + 1} (open) \u2014`;
            }
            list.appendChild(row);
        }
    }

    const hostCtrlEl = document.getElementById('mp-host-ctrl');
    const guestWait  = document.getElementById('mp-guest-wait');
    if (hostCtrlEl) hostCtrlEl.classList.toggle('hidden', !data.isHost);
    if (guestWait)  guestWait.classList.toggle('hidden',  data.isHost);

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

function _onMPGameStart(data) {
    const doStart = () => { if (_cbMPGameReady) _cbMPGameReady(data); };

    const gs = document.getElementById('gameOverScreen');
    if (gs) {
        const afterClose = () => {
            gs.querySelector('.post-game-menu')?.style.setProperty('display', 'none');
            setTimeout(() => {
                gs.classList.add('doors-open');
                setTimeout(() => {
                    doStart();
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

function _onMPHostLeft() {
    if (_cbHostLeft) _cbHostLeft();
    MP.clearLastRoom();
    const gs = document.getElementById('gameOverScreen');
    if (gs) {
        _doMainMenuTransition(gs);
    } else {
        showMainMenuScreen();
    }
}

// ============================================================
// Main menu / post-game transitions
// ============================================================

/** Build the post-game menu and wire up its buttons. */
export function buildPostGameMenu(gs, isMP, isHost) {
    const menu = document.createElement('div');
    menu.className = 'post-game-menu';

    const disableAll = () => menu.querySelectorAll('button').forEach(b => { b.disabled = true; });

    if (!isMP || isHost) {
        const newGameBtn = document.createElement('button');
        newGameBtn.className = 'menu-btn menu-btn-start post-game-btn';
        newGameBtn.textContent = '\u25B6 NEW GAME';
        newGameBtn.addEventListener('click', () => {
            disableAll();
            gs.classList.remove('doors-open');
            setTimeout(() => {
                menu.style.display = 'none';
                setTimeout(() => {
                    gs.classList.add('doors-open');
                    setTimeout(() => {
                        if (_cbNewGame) _cbNewGame();
                        setTimeout(() => gs.remove(), 800);
                    }, 500);
                }, 1000);
            }, 1300);
        });
        menu.appendChild(newGameBtn);
    } else {
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
        MP.clearLastRoom();
        refreshRejoinButton();
        _doMainMenuTransition(gs);
    });
    menu.appendChild(mainMenuBtn);

    return menu;
}

function _doMainMenuTransition(gs) {
    const ws = prepareMainMenuScreen(false);
    if (ws) {
        ws.style.zIndex = '18000';
        ws.classList.remove('doors-open');
    }

    gs.classList.remove('doors-open');
    setTimeout(() => {
        setTimeout(() => {
            gs.remove();
            if (ws) {
                ws.style.zIndex = '21000';
                requestAnimationFrame(() => requestAnimationFrame(() => ws.classList.add('doors-open')));
            }
            if (_cbMainMenu) _cbMainMenu();
            refreshRejoinButton();
        }, 1000);
    }, 1300);
}

/** Reset welcome screen state to main menu (not MP lobby). */
export function prepareMainMenuScreen(openDoors = true) {
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
    refreshRejoinButton();
    if (openDoors) {
        ws.style.zIndex = '21000';
        ws.classList.remove('doors-open');
        requestAnimationFrame(() => requestAnimationFrame(() => ws.classList.add('doors-open')));
    }
    return ws;
}

/** Show the main menu screen (called via Update('SHOW_MAIN_MENU')). */
export function showMainMenuScreen() {
    prepareMainMenuScreen(true);
}

// ============================================================
// Rejoin button
// ============================================================

export function refreshRejoinButton() {
    const existing = document.getElementById('rejoinBtn');
    const saved    = MP.getLastRoom();

    if (!saved) {
        if (existing) existing.remove();
        return;
    }

    if (existing) {
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
                _openWelcomePanel('multiplayer');
                _mpShowSection('lobby');
            }
        } catch (e) {
            MP.clearLastRoom();
            btn.remove();
            _openMPPanel();
            setTimeout(() => _mpSetError(`Could not rejoin room ${saved.code}: ${e.message}`), 400);
        }
    });

    const menu     = document.querySelector('.welcome-menu');
    const startBtn = document.getElementById('startButton');
    if (menu && startBtn) menu.insertBefore(btn, startBtn);
    else if (menu) menu.appendChild(btn);
}

// ============================================================
// Menu label sync
// ============================================================

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
        mb.textContent = on ? '\u2713 Multiplayer ON' : 'Multiplayer';
        mb.classList.toggle('menu-btn-toggled', on);
    }
}

// ============================================================
// Build overlay + register welcome-screen event listeners
// ============================================================

const _RULES_TEXT = [
    'Matching Rank: You must play a card (or a four-of-a-kind) that is of equal or higher rank than the card currently on top of the pile.',
    'Suits: Suits do not matter; only the rank (number/face) is important.',
    'The Triple-9 Opening: If you hold all three remaining 9s (Spades, Diamonds, and Clubs), you may play them all at once directly onto the 9 of Hearts.',
    'Drawing Cards: If you cannot play a legal card\u2014or if you strategically choose not to\u2014you must DRAW.',
    'You pick up the top 3 cards from the pile. If there are only 1 or 2 cards available above the 9 of Hearts, you pick up all of them.',
    'Remember: The 9 of Hearts stays on the table!',
].join('\n\n');

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
            if (_mpTakenAvatars.has(i)) return;
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

    // ---- Multiplayer ----
    const mpPanel = _buildMPPanel();

    ov.append(howPanel, nickPanel, avPanel, playersPanel, diffPanel, mpPanel);
    ws.appendChild(ov);
    _updateMenuBtnLabels();

    MP.on('lobby',     _onMPLobby);
    MP.on('gameStart', _onMPGameStart);
    MP.on('hostLeft',  _onMPHostLeft);
}

/**
 * Build the welcome overlay and register all welcome-screen button listeners.
 * Call once from ui-manager during init (replaces _setupListeners welcome section).
 */
export function setup() {
    _buildWelcomeOverlay();

    document.getElementById('howToPlayBtn') ?.addEventListener('click', () => _openWelcomePanel('how-to-play'));
    document.getElementById('nicknameBtn')  ?.addEventListener('click', () => _openWelcomePanel('nickname'));
    document.getElementById('avatarBtn')    ?.addEventListener('click', () => _openWelcomePanel('avatar'));
    document.getElementById('playersBtn')   ?.addEventListener('click', () => _openWelcomePanel('players'));
    document.getElementById('difficultyBtn')?.addEventListener('click', () => _openWelcomePanel('difficulty'));
    document.getElementById('exitButton')   ?.addEventListener('click', () => { /* no-op on web */ });

    document.getElementById('multiBtn')?.addEventListener('click', () => {
        _gameMode = _gameMode === 'multi' ? 'bots' : 'multi';
        _updateMenuBtnLabels();
        if (_gameMode === 'multi') _openMPPanel();
    });

    refreshRejoinButton();

    const startBtn = document.getElementById('startButton');
    if (startBtn) {
        startBtn.addEventListener('click', e => {
            e.stopPropagation();
            startBtn.blur();
            Audio.initAudio();
            if (Audio.isWelcomeSoundPending()) {
                Audio.setWelcomeSoundPending(false);
                Audio.playWelcomeSound();
            }
            document.getElementById('tapToStart')?.remove();

            if (_gameMode === 'multi') {
                _openMPPanel();
                return;
            }

            const ws = document.getElementById('welcomeScreen');
            if (!ws) { if (_cbGameStart) _cbGameStart(); return; }

            ws.style.zIndex = '21000';
            ws.classList.remove('doors-open');
            setTimeout(() => {
                ws.querySelectorAll('.welcome-menu, #welcomeOverlay').forEach(el => el.style.display = 'none');
                ws.classList.add('doors-open');
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
            Audio.initAudio();
            document.getElementById('welcomeScreen')?.remove();
            legacyTap.remove();
            if (_cbGameStart) _cbGameStart();
        });
    }
}
