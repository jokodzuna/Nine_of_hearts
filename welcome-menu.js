// ============================================================
// welcome-menu.js — Welcome screen, overlay panels, MP lobby
// Nine of Hearts
// ============================================================

import * as MP    from './multiplayer.js';
import * as Audio from './audio.js';
import { USER_AVATARS, DEFAULT_AVATAR } from './constants.js';
import { getProfile, updateProfile, onReady } from './user-profile.js';
import * as Economy from './economy.js';

// ============================================================
// State
// ============================================================

let _playerName     = 'Player';
let _avatarPath     = DEFAULT_AVATAR;
let _numPlayers     = 4;
let _difficulty     = 'easy';
let _gameMode       = 'bots';
let _mpTakenAvatars = new Set();

// ============================================================
// Callbacks (registered by ui-manager, forwarded from game-controller)
// ============================================================

let _cbGameStart   = null;
let _cbDealStart   = null;
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
    if (cbs.onDealStart)   _cbDealStart   = cbs.onDealStart;
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
        avatarPath: _avatarPath,
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
    if (id === 'profile') {
        const inp = panel.querySelector('.profile-name-input');
        if (inp) inp.value = _playerName;
        const prev = panel.querySelector('.profile-current-avatar');
        if (prev) prev.src = _avatarPath;
    }
    if (id === 'avatar-select') _refreshAvatarShopGrid();
    if (id === 'stats')          _refreshStatsPanel();
    if (id === 'achievements')   _refreshAchievementsPanel();
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
                avatarPath: _avatarPath,
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
            const result = await MP.joinRoom({
                code:      code,
                nickname:   _playerName,
                avatarPath: _avatarPath,
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
        const avGrid = document.querySelector('#welcomePanel-avatar-select .avatar-select-grid');
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
                const av = document.createElement('img');
                av.src = p.avatarPath ?? DEFAULT_AVATAR;
                av.className = 'mp-player-avatar-img';
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
            .map(p => p.avatarPath)
    );
    const avGrid = document.querySelector('#welcomePanel-avatar-select .avatar-select-grid');
    if (avGrid) {
        avGrid.querySelectorAll('.avatar-preview').forEach(el => {
            el.classList.toggle('taken', _mpTakenAvatars.has(el.dataset.path));
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
    document.querySelector('#welcomePanel-avatar-select .avatar-select-grid')
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
                nickname:   _playerName,
                avatarPath: _avatarPath,
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

function _updateProfileWidget() {
    const img = document.getElementById('profileWidgetImg');
    if (img) img.src = _avatarPath;
    const nameEl = document.getElementById('profileWidgetName');
    if (nameEl) nameEl.textContent = _playerName;
}

function _updateMenuBtnLabels() {
    const diffLabel = { easy: 'Easy', medium: 'Medium', hard: 'Hard', botfather: 'The Botfather' };
    _updateProfileWidget();
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
// Profile panel builders
// ============================================================

function _buildProfilePanel() {
    const panel = _makePanelBase('profile', 'Profile');

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'profile-panel-avatar-wrap';
    const avatarImg = document.createElement('img');
    avatarImg.className = 'profile-current-avatar';
    avatarImg.src = _avatarPath;
    avatarWrap.appendChild(avatarImg);
    panel.appendChild(avatarWrap);

    const nameLabel = document.createElement('div');
    nameLabel.className = 'profile-field-label';
    nameLabel.textContent = 'Player Name';
    const nameInp = document.createElement('input');
    nameInp.type = 'text';
    nameInp.className = 'nickname-input profile-name-input';
    nameInp.maxLength = 20;
    nameInp.placeholder = 'Enter name…';
    nameInp.value = _playerName;
    nameInp.addEventListener('input', () => { _playerName = nameInp.value.trim() || 'Player'; });
    panel.append(nameLabel, nameInp);

    const saveNameBtn = document.createElement('button');
    saveNameBtn.className = 'menu-btn';
    saveNameBtn.textContent = 'Save Name';
    saveNameBtn.addEventListener('click', async () => {
        _playerName = nameInp.value.trim() || 'Player';
        _updateProfileWidget();
        try { await updateProfile({ displayName: _playerName }); }
        catch (e) { console.error('[Profile] save name failed:', e); }
    });
    panel.appendChild(saveNameBtn);

    const changeAvBtn = document.createElement('button');
    changeAvBtn.className = 'menu-btn';
    changeAvBtn.textContent = 'Change Avatar';
    changeAvBtn.addEventListener('click', () => _openWelcomePanel('avatar-select'));
    panel.appendChild(changeAvBtn);

    const statsBtn = document.createElement('button');
    statsBtn.className = 'menu-btn';
    statsBtn.textContent = '\u{1F4CA}  Stats';
    statsBtn.addEventListener('click', () => _openWelcomePanel('stats'));
    panel.appendChild(statsBtn);

    const achBtn = document.createElement('button');
    achBtn.className = 'menu-btn';
    achBtn.textContent = '\u{1F3C6}  Achievements';
    achBtn.addEventListener('click', () => _openWelcomePanel('achievements'));
    panel.appendChild(achBtn);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'menu-btn menu-btn-danger';
    resetBtn.textContent = 'Reset All Data';
    resetBtn.addEventListener('click', () => {
        const confirmed = window.confirm('Reset ALL progress?\nCoins, stats, and achievements will be wiped. This cannot be undone.');
        if (!confirmed) return;
        Economy.resetAllData().then(() => {
            const el = document.getElementById('coinBalance');
            if (el) el.textContent = '0';
            window.alert('All data has been reset.');
        }).catch(console.error);
    });
    panel.appendChild(resetBtn);

    panel.appendChild(_makePanelCloseBtn('Close'));
    return panel;
}

// ============================================================
// Stats panel
// ============================================================

function _buildStatsPanel() {
    const panel = _makePanelBase('stats', 'Stats');
    const content = document.createElement('div');
    content.className = 'stats-content';
    panel.appendChild(content);
    const backBtn = document.createElement('button');
    backBtn.className = 'menu-btn';
    backBtn.textContent = '\u2190 Back to Profile';
    backBtn.addEventListener('click', () => _openWelcomePanel('profile'));
    panel.appendChild(backBtn);
    return panel;
}

function _refreshStatsPanel() {
    const content = document.querySelector('#welcomePanel-stats .stats-content');
    if (!content) return;
    const s = Economy.isEconomyReady() ? Economy.getStats() : {
        gamesPlayed: 0, gamesSurvived: 0, gamesLost: 0,
        survivalRate: 0, currentSurvivalStreak: 0,
        longestSurvivalStreak: 0, foursPlayed: 0,
    };

    const row = (icon, label, value, barPct = null) => {
        const bar = barPct !== null
            ? `<div class="stat-bar-track"><div class="stat-bar-fill" style="width:${barPct}%"></div></div>`
            : '';
        return `<div class="stat-row">
            <span class="stat-row-icon">${icon}</span>
            <div class="stat-row-body"><div class="stat-row-label">${label}</div>${bar}</div>
            <span class="stat-row-value">${value}</span>
        </div>`;
    };

    content.innerHTML = [
        row('\u{1F3AE}', 'Games Played',    s.gamesPlayed),
        row('\u{1F3C6}', 'Survived',         s.gamesSurvived, s.survivalRate),
        row('\u{1F480}', 'Lost',              s.gamesLost),
        row('\u{1F4C8}', 'Survival Rate',    `${s.survivalRate}%`, s.survivalRate),
        row('\u{1F525}', 'Current Streak',   s.currentSurvivalStreak),
        row('\u2B50',    'Best Streak',       s.longestSurvivalStreak),
    ].join('');
}

// ============================================================
// Achievements panel
// ============================================================

const _ACH_DISPLAY = [
    { id: 'first_survival', icon: '\u{1F947}', title: 'First Survival',  desc: 'Survive your first game',                  coins: 50  },
    { id: 'comeback_king',  icon: '\u2694\uFE0F',  title: 'Comeback King',   desc: 'Survive after holding 15+ cards at once',  coins: 100 },
    { id: 'speed_demon',    icon: '\u26A1',    title: 'Speed Demon',     desc: 'Clear your hand in under 3 minutes',        coins: 100 },
    { id: 'streak_master',  icon: '\u{1F525}', title: 'Streak Master',   desc: 'Survive 10 games in a row',                 coins: 75  },
    { id: 'quad_squad',     icon: '\u{1F0CF}', title: 'Quad Squad',      desc: 'Play a four-of-a-kind 10 times total',      coins: 125 },
];

function _buildAchievementsPanel() {
    const panel = _makePanelBase('achievements', 'Achievements');
    const list = document.createElement('div');
    list.className = 'ach-list';
    panel.appendChild(list);
    const backBtn = document.createElement('button');
    backBtn.className = 'menu-btn';
    backBtn.textContent = '\u2190 Back to Profile';
    backBtn.addEventListener('click', () => _openWelcomePanel('profile'));
    panel.appendChild(backBtn);
    return panel;
}

function _refreshAchievementsPanel() {
    const list = document.querySelector('#welcomePanel-achievements .ach-list');
    if (!list) return;
    const unlocked = Economy.isEconomyReady() ? Economy.getUnlockedAchievements() : {};
    const s = Economy.isEconomyReady() ? Economy.getStats() : { currentSurvivalStreak: 0, foursPlayed: 0 };
    list.innerHTML = _ACH_DISPLAY.map(a => {
        const on = !!unlocked[a.id];
        let progress = '';
        if (!on) {
            if (a.id === 'streak_master') progress = `<span class="ach-item-progress">${s.currentSurvivalStreak}\u200a/\u200a10</span>`;
            if (a.id === 'quad_squad')    progress = `<span class="ach-item-progress">${s.foursPlayed}\u200a/\u200a10</span>`;
        }
        return `<div class="ach-item ${on ? 'ach-item--on' : 'ach-item--off'}">
            <span class="ach-item-icon">${on ? a.icon : '\u{1F512}'}</span>
            <div class="ach-item-body">
                <div class="ach-item-title">${a.title}</div>
                <div class="ach-item-desc">${a.desc}</div>
                <div class="ach-item-coins">+${a.coins} \u{1FA99}</div>
            </div>
            ${on ? '<span class="ach-item-check">&#10003;</span>' : progress}
        </div>`;
    }).join('');
}

function _buildAvatarSelectPanel() {
    const panel = _makePanelBase('avatar-select', 'Choose Avatar');
    const grid = document.createElement('div');
    grid.id = 'avatarShopGrid';
    grid.className = 'avatar-shop-grid';
    panel.appendChild(grid);
    const backBtn = document.createElement('button');
    backBtn.className = 'menu-btn';
    backBtn.textContent = '\u2190 Back to Profile';
    backBtn.addEventListener('click', () => _openWelcomePanel('profile'));
    panel.appendChild(backBtn);
    return panel;
}

function _refreshAvatarShopGrid() {
    const grid = document.getElementById('avatarShopGrid');
    if (!grid) return;
    grid.innerHTML = '';
    for (const path of USER_AVATARS) {
        const owned      = Economy.isAvatarUnlocked(path);
        const isTaken    = _mpTakenAvatars.has(path);
        const price      = Economy.AVATAR_PRICES.get(path) ?? 0;
        const isSelected = path === _avatarPath;

        const item = document.createElement('div');
        item.className = 'avatar-shop-item'
            + (owned      ? ' avatar-shop-item--owned'    : ' avatar-shop-item--locked')
            + (isSelected ? ' avatar-shop-item--selected' : '')
            + (isTaken    ? ' avatar-shop-item--taken'    : '');

        const imgWrap = document.createElement('div');
        imgWrap.className = 'avatar-shop-img-wrap';

        const img = document.createElement('img');
        img.src = path;
        img.className = 'avatar-shop-img' + (!owned ? ' avatar-shop-img--locked' : '');
        imgWrap.appendChild(img);
        item.appendChild(imgWrap);

        if (!owned) {
            const priceRow = document.createElement('div');
            priceRow.className = 'avatar-shop-price-row';
            priceRow.innerHTML = `\u{1F512} ${price} \u{1FA99}`;
            item.appendChild(priceRow);
        }

        if (owned && !isTaken) {
            item.addEventListener('click', async () => {
                if (isSelected) return;
                _avatarPath = path;
                _refreshAvatarShopGrid();
                const prev = document.querySelector('.profile-current-avatar');
                if (prev) prev.src = path;
                _updateProfileWidget();
                try { await updateProfile({ avatarPath: path }); }
                catch (e) { console.error('[Profile] save avatar failed:', e); }
                if (MP.isInRoom()) MP.updateAvatar(path).catch(console.error);
            });
        } else if (!owned) {
            item.addEventListener('click', () => _showBuyConfirm(path, price));
        }

        grid.appendChild(item);
    }
}

function _showBuyConfirm(path, price) {
    const panel = document.getElementById('welcomePanel-avatar-select');
    if (!panel) return;
    const existing = panel.querySelector('.buy-confirm-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'buy-confirm-overlay';

    const box = document.createElement('div');
    box.className = 'buy-confirm-box';

    const img = document.createElement('img');
    img.src = path;
    img.className = 'buy-confirm-avatar';

    const msg = document.createElement('p');
    msg.className = 'buy-confirm-msg';
    msg.innerHTML = `Purchase for <strong>${price} \u{1FA99}</strong>?`;

    const btns = document.createElement('div');
    btns.className = 'buy-confirm-btns';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'menu-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const buyBtn = document.createElement('button');
    buyBtn.className = 'menu-btn menu-btn-start';
    buyBtn.textContent = `Buy: ${price} \u{1FA99}`;
    buyBtn.addEventListener('click', async () => {
        overlay.remove();
        const result = await Economy.buyAvatar(path);
        if (result.success) {
            _refreshAvatarShopGrid();
        } else if (result.reason === 'not_enough_coins') {
            Audio.playBuzzerSound();
            _showToast(`Not enough coins! Need ${price} \u{1FA99}`, 'error');
        }
    });

    btns.append(cancelBtn, buyBtn);
    box.append(img, msg, btns);
    overlay.appendChild(box);
    panel.appendChild(overlay);
}

function _showToast(msg, type = 'info') {
    const existing = document.getElementById('shopToast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = 'shopToast';
    el.className = `shop-toast shop-toast--${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('shop-toast--in')));
    setTimeout(() => {
        el.classList.remove('shop-toast--in');
        setTimeout(() => el.remove(), 400);
    }, 2800);
}

// ============================================================
// Settings panel
// ============================================================

const _VIP_CODE = 'VIP';

function _buildSettingsPanel() {
    const panel = _makePanelBase('settings', 'Settings');

    const vibRow = document.createElement('div');
    vibRow.className = 'settings-toggle-row';
    const vibLabel = document.createElement('span');
    vibLabel.textContent = '\u{1F4F3} Vibration';
    const vibToggle = document.createElement('button');
    vibToggle.className = 'settings-toggle-btn' + (Audio.isHapticEnabled() ? ' settings-toggle-btn--on' : '');
    vibToggle.textContent = Audio.isHapticEnabled() ? 'ON' : 'OFF';
    vibToggle.addEventListener('click', () => {
        const newVal = !Audio.isHapticEnabled();
        Audio.setHapticEnabled(newVal);
        vibToggle.textContent = newVal ? 'ON' : 'OFF';
        vibToggle.classList.toggle('settings-toggle-btn--on', newVal);
        if (newVal) Audio.triggerHaptic('light');
    });
    vibRow.append(vibLabel, vibToggle);
    panel.appendChild(vibRow);

    const codeInp = document.createElement('input');
    codeInp.type = 'text';
    codeInp.className = 'nickname-input';
    codeInp.placeholder = 'Enter secret code\u2026';
    codeInp.maxLength = 30;

    const applyBtn = document.createElement('button');
    applyBtn.className = 'menu-btn';
    applyBtn.textContent = 'Apply Code';
    applyBtn.addEventListener('click', async () => {
        const code = codeInp.value.trim().toUpperCase();
        if (code === _VIP_CODE) {
            if (Economy.isPremium()) {
                _showToast('You already have VIP access!', 'info');
                return;
            }
            await Economy.grantVIP();
            Audio.playVIPFanfareSound();
            _showVIPNotification();
            codeInp.value = '';
            _refreshAvatarShopGrid();
        } else {
            Audio.playBuzzerSound();
            _showToast('Invalid code.', 'error');
        }
    });
    codeInp.addEventListener('keydown', e => { if (e.key === 'Enter') applyBtn.click(); });

    panel.appendChild(codeInp);
    panel.appendChild(applyBtn);
    panel.appendChild(_makePanelCloseBtn('Close'));
    return panel;
}

function _showVIPNotification() {
    const el = document.createElement('div');
    el.className = 'achievement-popup';
    el.innerHTML =
        `<span class="ach-icon">\u{1F451}</span>` +
        `<div class="ach-body">` +
        `<div class="ach-unlocked">VIP Access Granted!</div>` +
        `<div class="ach-title">All avatars unlocked</div>` +
        `<div class="ach-desc">You now have access to all content.</div>` +
        `</div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('achievement-popup--in')));
    setTimeout(() => {
        el.classList.remove('achievement-popup--in');
        setTimeout(() => el.remove(), 500);
    }, 4500);
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

    // ---- Profile ----
    const profilePanel = _buildProfilePanel();

    // ---- Avatar Select ----
    const avatarSelectPanel = _buildAvatarSelectPanel();

    // ---- Number of Players ----
    const playersPanel = _buildOptionPanel('players', 'Number of Players',
        [['2','2 Players'],['3','3 Players'],['4','4 Players']],
        () => String(_numPlayers),
        v => { _numPlayers = Number(v); _updateMenuBtnLabels(); }
    );

    // ---- Difficulty ----
    const diffPanel = _buildOptionPanel('difficulty', 'Difficulty',
        [['easy','Easy'],['medium','Medium'],['hard','Hard'],['botfather','The Botfather']],
        () => _difficulty,
        v => { _difficulty = v; _updateMenuBtnLabels(); }
    );

    // ---- Multiplayer ----
    const mpPanel = _buildMPPanel();

    const statsPanel    = _buildStatsPanel();
    const achPanel      = _buildAchievementsPanel();
    const settingsPanel = _buildSettingsPanel();
    ov.append(howPanel, profilePanel, avatarSelectPanel, playersPanel, diffPanel, mpPanel, statsPanel, achPanel, settingsPanel);
    ws.appendChild(ov);
    _updateMenuBtnLabels();

    MP.on('lobby',     _onMPLobby);
    MP.on('gameStart', _onMPGameStart);
    MP.on('hostLeft',  _onMPHostLeft);
}

// ============================================================
// Botfather intro sequence
// ============================================================

function _applyBotfatherClipPaths() {
    const doorLeft  = document.getElementById('doorLeft');
    const doorRight = document.getElementById('doorRight');
    if (!doorLeft || !doorRight) return;
    const W = window.innerWidth, H = window.innerHeight;
    const cx = W / 2, cy = H / 2;
    const r  = Math.min(W, H) * 0.10;
    const lp = `M 0,0 L ${cx},0 L ${cx},${cy - r} ` +
               `A ${r},${r} 0 0,1 ${cx},${cy + r} ` +
               `L ${cx},${H} L 0,${H} Z`;
    const rp = `M ${cx},0 L ${W},0 L ${W},${H} ` +
               `L ${cx},${H} L ${cx},${cy + r} ` +
               `A ${r},${r} 0 0,0 ${cx},${cy - r} ` +
               `L ${cx},0 Z`;
    doorLeft.style.clipPath  = `path('${lp}')`;
    doorRight.style.clipPath = `path('${rp}')`;
}

// Video is already playing (started in the click handler inside the user-gesture
// tick).  This function just sets up the 9.8 s crossfade → door image → tap.
// onReady fires as soon as the metal door is fully visible so the game arena
// can render behind it before the user opens the door.
function _setupBotfatherCrossfade(onReady) {
    const overlay = document.getElementById('botfatherOverlay');
    const video   = document.getElementById('botfatherVideo');
    const door    = document.getElementById('botfatherDoor');
    if (!overlay || !video || !door) { onReady(); return; }

    let crossed = false;
    const _crossfade = () => {
        if (crossed) return;
        crossed = true;
        clearTimeout(timer);
        // Show door instantly behind the video (no opacity transition)
        door.classList.add('bf-preshow');
        // Glitch sound + visual, synchronized — both last ~430 ms
        Audio.playGlitchSound();
        video.classList.add('bf-glitch');
        setTimeout(() => {
            video.classList.remove('bf-glitch');
            video.classList.add('bf-fade-out');   // lock video opacity at 0
            door.classList.remove('bf-preshow');
            door.classList.add('bf-visible');     // now properly tappable
            door.addEventListener('click', _onDoorTap);
        }, 430);
    };

    // Calculate remaining play time from current video position
    const remaining = (!video.paused && !video.error)
        ? Math.max(0, (9.8 - video.currentTime) * 1000)
        : 0;
    const timer = setTimeout(_crossfade, remaining);
    video.addEventListener('ended', () => _crossfade(), { once: true });
    video.addEventListener('error',  () => _crossfade(), { once: true });

    function _onDoorTap() {
        door.removeEventListener('click', _onDoorTap);
        Audio.playDoorOpenSound();
        door.classList.add('bf-doors-open');
        // Set up game room NOW (table, avatars, pile) while door slides open
        onReady();
        setTimeout(() => {
            // Door fully open — reveal veil covers the game at 0.6 opacity
            overlay.style.display = 'none';
            video.pause();
            video.currentTime = 0;
            video.classList.remove('bf-fade-out');
            door.classList.remove('bf-visible', 'bf-doors-open');
            const darkVeil = document.getElementById('bfDarkVeil');
            if (darkVeil) darkVeil.classList.remove('veil-clear');
            const revealVeil = document.getElementById('bfRevealVeil');
            if (revealVeil) {
                revealVeil.style.display = '';
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    revealVeil.classList.add('clearing');
                    // Veil reaches opacity 0 after 2s — start dealing then
                    setTimeout(() => {
                        revealVeil.style.display = 'none';
                        revealVeil.classList.remove('clearing');
                        if (_cbDealStart) _cbDealStart();
                    }, 2100);
                }));
            } else {
                // Fallback: no veil element, deal immediately
                if (_cbDealStart) _cbDealStart();
            }
        }, 2600);  // 2.5s door animation + 100ms buffer
    }
}

/**
 * Build the welcome overlay and register all welcome-screen button listeners.
 * Call once from ui-manager during init (replaces _setupListeners welcome section).
 */
export function setup() {
    _buildWelcomeOverlay();

    document.getElementById('howToPlayBtn') ?.addEventListener('click', () => _openWelcomePanel('how-to-play'));
    document.getElementById('playersBtn')   ?.addEventListener('click', () => _openWelcomePanel('players'));
    document.getElementById('difficultyBtn')?.addEventListener('click', () => _openWelcomePanel('difficulty'));
    document.getElementById('exitButton')   ?.addEventListener('click', () => { /* no-op on web */ });

    document.getElementById('multiBtn')?.addEventListener('click', () => {
        _gameMode = _gameMode === 'multi' ? 'bots' : 'multi';
        _updateMenuBtnLabels();
        if (_gameMode === 'multi') _openMPPanel();
    });

    document.getElementById('settingsBtn')?.addEventListener('click', () => _openWelcomePanel('settings'));

    document.addEventListener('click', e => {
        const btn = e.target.closest('.menu-btn, .nav-btn');
        if (btn && !btn.disabled) {
            Audio.triggerHaptic('light');
            Audio.playClickSound();
        } else if (e.target.closest('.avatar-shop-item')) {
            Audio.triggerHaptic('light');
            Audio.playClickSound();
        }
    });

    const profileWidget = document.getElementById('profileWidget');
    if (profileWidget) profileWidget.addEventListener('click', () => {
        Audio.triggerHaptic('light');
        Audio.playClickSound();
        _openWelcomePanel('profile');
    });

    const _applyProfile = ({ displayName, avatarPath }) => {
        if (displayName) _playerName = displayName;
        if (avatarPath)  _avatarPath = avatarPath;
        _updateMenuBtnLabels();
    };
    window.addEventListener('profileCached', e => _applyProfile(e.detail), { once: true });
    onReady(_applyProfile);
    Economy.onEconomyReady(() => {
        const el = document.getElementById('coinBalance');
        if (el) el.textContent = Economy.getCoins();
    });

    refreshRejoinButton();

    const startBtn = document.getElementById('startButton');
    if (startBtn) {
        startBtn.addEventListener('click', e => {
            e.stopPropagation();
            startBtn.blur();
            Audio.initAudio();
            Audio.triggerHaptic('light');
            Audio.playClickSound();
            if (Audio.isWelcomeSoundPending()) {
                Audio.setWelcomeSoundPending(false);
                Audio.playWelcomeSound();
            }
            document.getElementById('tapToStart')?.remove();

            if (_gameMode === 'multi') {
                _openMPPanel();
                return;
            }

            const ws          = document.getElementById('welcomeScreen');
            const isBotfather = _difficulty === 'botfather';
            const bfOverlay   = isBotfather ? document.getElementById('botfatherOverlay') : null;
            const bfVideo     = isBotfather ? document.getElementById('botfatherVideo')   : null;

            // Launch video NOW — still inside the user-gesture tick, so
            // autoplay with audio is permitted without restriction.
            if (bfVideo && bfOverlay) {
                _applyBotfatherClipPaths();
                bfOverlay.style.display = '';
                bfVideo.currentTime = 0;
                bfVideo.play().catch(() => {});  // failure surfaced via video.paused check
            }

            if (!ws) {
                if (isBotfather) _setupBotfatherCrossfade(() => { if (_cbGameStart) _cbGameStart(); });
                else if (_cbGameStart) _cbGameStart();
                return;
            }

            ws.style.zIndex = '21000';  // welcome screen stays above overlay (20000)
            ws.classList.remove('doors-open');
            setTimeout(() => {
                ws.querySelectorAll('.welcome-menu, #welcomeOverlay').forEach(el => el.style.display = 'none');
                ws.classList.add('doors-open');  // green doors lift — video visible behind
                setTimeout(() => {
                    ws.style.display = 'none';   // welcome screen fully gone
                    if (isBotfather) {
                        // Fade the dark veil to reveal the video already in progress
                        const veil = document.getElementById('bfDarkVeil');
                        if (veil) veil.classList.add('veil-clear');
                        _setupBotfatherCrossfade(() => { if (_cbGameStart) _cbGameStart(); });
                    } else {
                        if (_cbGameStart) _cbGameStart();
                    }
                }, 1300);  // wait for the full 1.2 s door-open animation
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

    // Preload botfather assets so there is zero buffering delay at game start
    const _bfVid = document.getElementById('botfatherVideo');
    if (_bfVid && !_bfVid.src) {
        _bfVid.preload = 'auto';
        _bfVid.src     = 'video/botfather-intro.mp4';
    }
    ['Images/botfather-door.jpg', 'Images/bot-avatars/botfather.webp']
        .forEach(src => { const img = new Image(); img.src = src; });
}
