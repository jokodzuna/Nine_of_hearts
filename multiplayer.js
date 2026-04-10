// ============================================================
// multiplayer.js — Firebase Realtime Database multiplayer
// Nine of Hearts
// ============================================================

import { initializeApp }
    from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getDatabase, ref, set, get, update, onValue, onDisconnect }
    from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';
import { getAuth, signInAnonymously }
    from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';

const _config = {
    apiKey:            'AIzaSyDC33g7aIfkEkT4fI5vskN-vQuCdi6LDkU',
    authDomain:        'nine-of-hearts.firebaseapp.com',
    databaseURL:       'https://nine-of-hearts-default-rtdb.europe-west1.firebasedatabase.app',
    projectId:         'nine-of-hearts',
    storageBucket:     'nine-of-hearts.firebasestorage.app',
    messagingSenderId: '460072662640',
    appId:             '1:460072662640:web:2280de49969e632f86a6b5',
};

const _app  = initializeApp(_config);
const _db   = getDatabase(_app);
const _auth = getAuth(_app);

// ---- Session ----------------------------------------------------------------
let _uid          = null;
let _roomCode     = null;
let _playerIndex  = -1;
let _isHost       = false;
let _roomUnsub    = null;
let _prevStatus   = null;
let _maxPlayers   = 4;
let _players      = {};   // uid → { nickname, avatarIdx, idx, isBot }
let _restartCount = -1;

// ---- Presence / Disconnect --------------------------------------------------
let _myOnDisconnect = null;   // OnDisconnect handle — cancelled on intentional leave
let _prevPlayers    = {};     // uid → player snapshot for diff detection
let _prevHost       = null;   // previous room.host uid

// ---- Lightweight event bus --------------------------------------------------
const _listeners = {};

export function on(event, fn) {
    (_listeners[event] ??= []).push(fn);
}
export function off(event, fn) {
    if (_listeners[event])
        _listeners[event] = _listeners[event].filter(f => f !== fn);
}
function _emit(event, data) {
    for (const fn of (_listeners[event] ?? [])) {
        try { fn(data); } catch (e) { console.error('[MP]', event, e); }
    }
}

// ---- Auth -------------------------------------------------------------------

/** Sign in anonymously (idempotent). Resolves with the uid. */
export async function initAuth() {
    if (_uid) return _uid;
    const cred = await signInAnonymously(_auth);
    _uid = cred.user.uid;
    return _uid;
}

// ---- Getters ----------------------------------------------------------------
export const getUID         = () => _uid;
export const getPlayerIndex = () => _playerIndex;
export const getRoomCode    = () => _roomCode;
export const isHost         = () => _isHost;
export const isInRoom       = () => _roomCode !== null;
export const getMaxPlayers  = () => _maxPlayers;
export const getPlayers     = () => _players;

/** Any player: update own avatarIdx in the lobby (real-time exclusion). */
export async function updateAvatar(avatarIdx) {
    if (!_roomCode || !_uid) return;
    await update(ref(_db, `rooms/${_roomCode}/players/${_uid}`), { avatarIdx });
}

// ---- Room management --------------------------------------------------------

/**
 * Create a room as host. Returns the 4-digit code.
 * @param {{ nickname:string, avatarIdx:number, maxPlayers?:number }} opts
 */
export async function createRoom({ nickname, avatarIdx, maxPlayers = 4 }) {
    if (!_uid) throw new Error('Not authenticated');

    // Pick an unused 4-digit code
    let code;
    for (;;) {
        code = String(Math.floor(1000 + Math.random() * 9000));
        const snap = await get(ref(_db, `rooms/${code}/status`));
        if (!snap.exists()) break;
    }

    _roomCode    = code;
    _isHost      = true;
    _playerIndex = 0;
    _maxPlayers  = maxPlayers;

    await set(ref(_db, `rooms/${code}`), {
        host:       _uid,
        maxPlayers,
        status:     'lobby',
        createdAt:  Date.now(),
        players: {
            [_uid]: { nickname, avatarIdx, idx: 0, isBot: false, connected: true,
                      isAI: false, wasHuman: false, disconnectedAt: null, turnsMissed: 0 },
        },
    });

    _setupPresence(code);
    _subscribeRoom(code);
    return code;
}

/**
 * Join an existing room as guest. Returns assigned player index.
 * @param {{ code:string, nickname:string, avatarIdx:number }} opts
 */
export async function joinRoom({ code, nickname, avatarIdx }) {
    if (!_uid) throw new Error('Not authenticated');

    const snap = await get(ref(_db, `rooms/${code}`));
    if (!snap.exists())          throw new Error('Room not found');

    const room = snap.val();

    // Reconnect path: game in progress and our UID has a reclaimable slot
    if (room.status === 'playing') {
        const mySlot = (room.players ?? {})[_uid];
        if (mySlot?.wasHuman) return _doReconnect(code, room, mySlot);
        throw new Error('Game already started');
    }

    if (room.status !== 'lobby') throw new Error('Room not available');

    const players  = room.players ?? {};
    const usedIdxs = Object.values(players).map(p => p.idx);
    let   nextIdx  = 0;
    while (usedIdxs.includes(nextIdx)) nextIdx++;
    if (nextIdx >= room.maxPlayers) throw new Error('Room is full');

    _roomCode    = code;
    _isHost      = false;
    _playerIndex = nextIdx;
    _maxPlayers  = room.maxPlayers;

    await update(ref(_db, `rooms/${code}/players/${_uid}`), {
        nickname, avatarIdx, idx: nextIdx, isBot: false, connected: true,
        isAI: false, wasHuman: false, disconnectedAt: null, turnsMissed: 0,
    });

    _setupPresence(code);
    _subscribeRoom(code);
    return { playerIdx: nextIdx, reconnected: false };
}

/** Host-only: update maxPlayers. */
export async function setMaxPlayers(n) {
    if (!_isHost || !_roomCode) return;
    _maxPlayers = n;
    await update(ref(_db, `rooms/${_roomCode}`), { maxPlayers: n });
}

/** Host-only: write initial state and flip status to 'playing'. */
export async function startGame(gameState) {
    if (!_isHost || !_roomCode) return;
    await update(ref(_db, `rooms/${_roomCode}`), {
        status:    'playing',
        gameState: _serial(gameState),
    });
}

/** Any player: push updated state after applying a move locally. */
export async function pushMove(newState) {
    if (!_roomCode) return;
    await update(ref(_db, `rooms/${_roomCode}`), {
        gameState: _serial(newState),
    });
}

/** Detach listener and reset session. */
export function leaveRoom() {
    if (_myOnDisconnect) { _myOnDisconnect.cancel().catch(() => {}); _myOnDisconnect = null; }
    if (_roomUnsub) { _roomUnsub(); _roomUnsub = null; }
    _roomCode     = null;
    _playerIndex  = -1;
    _isHost       = false;
    _prevStatus   = null;
    _restartCount = -1;
    _prevPlayers  = {};
    _prevHost     = null;
}

/** Convert native game state to Firebase-serialisable object. */
export function serialiseState(s) {
    return {
        hands:         Array.from(s.hands),
        pile:          Array.from(s.pile.slice(0, s.pileSize)),
        pileSize:      s.pileSize,
        topRankIdx:    s.topRankIdx,
        currentPlayer: s.currentPlayer,
        eliminated:    s.eliminated,
        numPlayers:    s.numPlayers,
    };
}

/** Host-only: start a fresh game in the same room (keeps players/settings). */
export async function restartGame(gameState) {
    if (!_isHost || !_roomCode) return;
    const rc = _restartCount + 1;
    _restartCount = rc;   // pre-update so our own echo is NOT treated as gameStart
    await update(ref(_db, `rooms/${_roomCode}`), {
        status:       'playing',
        restartCount: rc,
        gameState:    serialiseState(gameState),
    });
}

// ---- Presence helpers ------------------------------------------------------

/** Register an onDisconnect write so Firebase marks us disconnected on drop. */
function _setupPresence(code) {
    if (!_uid || !code) return;
    const dc = onDisconnect(ref(_db, `rooms/${code}/players/${_uid}`));
    dc.update({ connected: false, disconnectedAt: { '.sv': 'timestamp' } });
    _myOnDisconnect = dc;
}

/**
 * Handle reconnect: player's UID already has a wasHuman slot in an active game.
 * Restores connected status and returns game data to the caller.
 */
async function _doReconnect(code, room, slot) {
    _roomCode    = code;
    _isHost      = false;
    _playerIndex = slot.idx;
    _maxPlayers  = room.maxPlayers;
    _players     = room.players ?? {};

    // Prevent _subscribeRoom from re-emitting gameStart on first fire
    _prevStatus   = 'playing';
    _restartCount = Number(room.restartCount ?? 0);

    await update(ref(_db, `rooms/${code}/players/${_uid}`), {
        connected: true, isAI: false, wasHuman: false, disconnectedAt: null,
    });

    _setupPresence(code);
    _subscribeRoom(code);

    return {
        reconnected: true,
        playerIdx:   slot.idx,
        turnsMissed: slot.turnsMissed ?? 0,
        rawState:    room.gameState,
        players:     room.players,
        maxPlayers:  room.maxPlayers,
    };
}

// ---- Host-managed disconnect/reconnect exports ------------------------------

/** Host: mark a disconnected player's slot as AI-controlled. */
export async function convertToBot(uid) {
    if (!_isHost || !_roomCode) return;
    await update(ref(_db, `rooms/${_roomCode}/players/${uid}`), {
        isAI: true, wasHuman: true, isBot: true, connected: false,
    });
}

/** Host: permanently convert a timed-out slot (no further reconnect allowed). */
export async function permanentBot(uid, newNickname) {
    if (!_isHost || !_roomCode) return;
    await update(ref(_db, `rooms/${_roomCode}/players/${uid}`), {
        isAI: true, wasHuman: false, isBot: true, nickname: newNickname,
    });
}

/** Host: increment the turnsMissed counter for a disconnected player's slot. */
export async function incrementTurnsMissed(uid) {
    if (!_isHost || !_roomCode || !uid) return;
    const cur = Number((_players[uid] ?? {}).turnsMissed ?? 0);
    await update(ref(_db, `rooms/${_roomCode}/players/${uid}`), { turnsMissed: cur + 1 });
}

/**
 * Any non-host player: if the current host disconnected, the eligible player
 * with the lowest seat index promotes themselves to host.
 */
export async function tryPromoteHost() {
    if (_isHost || !_roomCode || !_uid) return;
    const candidates = Object.entries(_players)
        .filter(([, p]) => p.connected !== false && !p.isAI)
        .sort((a, b) => a[1].idx - b[1].idx);
    if (!candidates.length) return;
    const [candidateUid] = candidates[0];
    if (candidateUid !== _uid) return;
    _isHost = true;
    await update(ref(_db, `rooms/${_roomCode}`), { host: _uid });
}

/** Host-only: signal all guests to return to main menu, then leave room. */
export async function hostReturnToMenu() {
    if (!_isHost || !_roomCode) return;
    const code = _roomCode;
    await update(ref(_db, `rooms/${code}`), { status: 'hostLeft' });
    leaveRoom();
}

// ---- State serialisation / deserialisation ----------------------------------

function _serial(s) {
    return {
        hands:         Array.from(s.hands),
        pile:          Array.from(s.pile.slice(0, s.pileSize)),
        pileSize:      s.pileSize,
        topRankIdx:    s.topRankIdx,
        currentPlayer: s.currentPlayer,
        eliminated:    s.eliminated,
        numPlayers:    s.numPlayers,
    };
}

/**
 * Convert a raw Firebase snapshot back to the typed-array format used by
 * game-logic.js.  Handles Firebase's object-key encoding of arrays.
 */
export function deserialiseState(raw) {
    const toArr = v =>
        v ? (Array.isArray(v) ? v : Object.values(v)).map(Number) : [];

    const pileRaw  = toArr(raw.pile);
    const handsRaw = toArr(raw.hands);

    const pile = new Uint8Array(52);
    pileRaw.forEach((v, i) => { pile[i] = v; });

    return {
        hands:         new Int32Array(handsRaw.length ? handsRaw : [0, 0, 0, 0]),
        pile,
        pileSize:      Number(raw.pileSize)       || 0,
        topRankIdx:    Number(raw.topRankIdx)      || 0,
        currentPlayer: Number(raw.currentPlayer)   || 0,
        eliminated:    Number(raw.eliminated)      || 0,
        numPlayers:    Number(raw.numPlayers)       || 4,
    };
}

// ---- Internal — Firebase room listener --------------------------------------

function _subscribeRoom(code) {
    if (_roomUnsub) _roomUnsub();
    // _prevStatus and _prevPlayers are intentionally NOT reset here —
    // _doReconnect sets them before calling _subscribeRoom to suppress a
    // spurious gameStart event on the first listener fire.

    _roomUnsub = onValue(ref(_db, `rooms/${code}`), snap => {
        if (!snap.exists()) return;
        const room    = snap.val();
        const players = room.players ?? {};

        _maxPlayers = room.maxPlayers ?? _maxPlayers;
        _players    = players;

        // ---- Player connect / AI-status diff detection ----------------------
        const duringGame = room.status === 'playing' || _prevStatus === 'playing';
        if (duringGame) {
            for (const [uid, player] of Object.entries(players)) {
                if (uid === _uid) continue;   // skip self
                const prev = _prevPlayers[uid];
                if (!prev) continue;          // no baseline yet

                const wasConn = prev.connected !== false;
                const nowConn = player.connected !== false;
                const wasAI   = !!prev.isAI;
                const nowAI   = !!player.isAI;

                if (wasConn && !nowConn) {
                    _emit('playerDisconnected', {
                        uid,
                        playerIdx: player.idx,
                        nickname:  player.nickname,
                        wasHost:   uid === (room.host ?? _prevHost),
                    });
                }
                if (!wasAI && nowAI) {
                    _emit('playerBotTakeover', {
                        uid, playerIdx: player.idx, nickname: player.nickname,
                    });
                }
                if (wasAI && !nowAI) {
                    _emit('playerReconnected', {
                        uid,
                        playerIdx:   player.idx,
                        nickname:    player.nickname,
                        turnsMissed: prev.turnsMissed ?? 0,
                    });
                }
            }

            // Host change
            if (_prevHost && room.host && room.host !== _prevHost) {
                if (room.host === _uid) _isHost = true;
                _emit('hostChanged', { newHostUid: room.host, isMe: room.host === _uid });
            }
        }

        // Update snapshots for next diff
        _prevPlayers = {};
        for (const [uid, p] of Object.entries(players)) _prevPlayers[uid] = { ...p };
        _prevHost = room.host ?? _prevHost;

        // ---- Status handling ------------------------------------------------
        if (room.status === 'lobby') {
            _emit('lobby', {
                code,
                isHost:     _isHost,
                myIdx:      _playerIndex,
                maxPlayers: room.maxPlayers,
                players,
            });
        }

        if (room.status === 'hostLeft') {
            if (!_isHost) _emit('hostLeft');
        }

        if (room.status === 'playing') {
            const rc = Number(room.restartCount ?? 0);
            const isNewGame = _prevStatus !== 'playing' || rc !== _restartCount;
            _restartCount = rc;
            if (isNewGame) {
                _emit('gameStart', {
                    rawState:   room.gameState,
                    players,
                    myIdx:      _playerIndex,
                    maxPlayers: room.maxPlayers,
                });
            } else {
                _emit('stateUpdate', room.gameState);
            }
        }

        _prevStatus = room.status;
    });
}
