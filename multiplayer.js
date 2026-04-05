// ============================================================
// multiplayer.js — Firebase Realtime Database multiplayer
// Nine of Hearts
// ============================================================

import { initializeApp }
    from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getDatabase, ref, set, get, update, onValue }
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
let _uid         = null;
let _roomCode    = null;
let _playerIndex = -1;
let _isHost      = false;
let _roomUnsub   = null;
let _prevStatus  = null;
let _maxPlayers  = 4;
let _players     = {};   // uid → { nickname, avatarIdx, idx, isBot }

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
            [_uid]: { nickname, avatarIdx, idx: 0, isBot: false },
        },
    });

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
    if (room.status !== 'lobby') throw new Error('Game already started');

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
        nickname, avatarIdx, idx: nextIdx, isBot: false,
    });

    _subscribeRoom(code);
    return nextIdx;
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
    if (_roomUnsub) { _roomUnsub(); _roomUnsub = null; }
    _roomCode    = null;
    _playerIndex = -1;
    _isHost      = false;
    _prevStatus  = null;
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
    _prevStatus = null;

    _roomUnsub = onValue(ref(_db, `rooms/${code}`), snap => {
        if (!snap.exists()) return;
        const room = snap.val();

        _maxPlayers = room.maxPlayers ?? _maxPlayers;
        _players    = room.players    ?? {};

        if (room.status === 'lobby') {
            _emit('lobby', {
                code,
                isHost:     _isHost,
                myIdx:      _playerIndex,
                maxPlayers: room.maxPlayers,
                players:    room.players ?? {},
            });
        }

        if (room.status === 'playing') {
            if (_prevStatus !== 'playing') {
                // First time we see 'playing' — fire gameStart on every client
                _emit('gameStart', {
                    rawState:   room.gameState,
                    players:    room.players ?? {},
                    myIdx:      _playerIndex,
                    maxPlayers: room.maxPlayers,
                });
            } else {
                // Subsequent move
                _emit('stateUpdate', room.gameState);
            }
        }

        _prevStatus = room.status;
    });
}
