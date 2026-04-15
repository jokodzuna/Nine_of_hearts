// ============================================================
// user-profile.js — Firebase Auth & persistent user profile
// Nine of Hearts
//
// Responsibilities:
//   - Sign in anonymously on app load (idempotent via multiplayer.js)
//   - Read or create the player's profile at /users/{uid}/
//   - Expose uid, displayName, avatarPath to all other modules
// ============================================================

import { ref, get, set }   from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';
import { initAuth, getDB } from './multiplayer.js';

// ============================================================
// Profile State
// ============================================================

const DEFAULT_AVATAR_PATH = 'Images/user-avatars/default-man_result.webp';

let _uid         = null;
let _displayName = null;
let _avatarPath  = null;
let _ready       = false;

// ---- Public API -------------------------------------------------------------

/** Returns the current profile. Values are null until init completes. */
export function getProfile() {
    return { uid: _uid, displayName: _displayName, avatarPath: _avatarPath };
}

/** True once initProfile() has resolved successfully. */
export function isReady() { return _ready; }

/**
 * Register a callback that fires as soon as the profile is ready.
 * If already ready, fires synchronously on the next microtask.
 */
export function onReady(cb) {
    if (_ready) { Promise.resolve().then(() => cb(getProfile())); return; }
    window.addEventListener('profileReady', e => cb(e.detail), { once: true });
}

/**
 * Persist a profile field update to /users/{uid}/.
 * Pass any subset of { displayName, avatarPath }.
 */
export async function updateProfile(changes) {
    if (!_uid) throw new Error('Profile not initialised');
    const db = getDB();
    const allowed = {};
    if (changes.displayName !== undefined) { _displayName = changes.displayName; allowed.displayName = _displayName; }
    if (changes.avatarPath  !== undefined) { _avatarPath  = changes.avatarPath;  allowed.avatarPath  = _avatarPath;  }
    if (Object.keys(allowed).length === 0) return;
    await set(ref(db, `users/${_uid}`), {
        displayName: _displayName,
        avatarPath:  _avatarPath,
    });
}

// ---- Init -------------------------------------------------------------------

async function _initProfile() {
    const db   = getDB();
    const snap = await get(ref(db, `users/${_uid}`));

    if (snap.exists()) {
        const data   = snap.val();
        _displayName = data.displayName ?? `player${Math.floor(1000 + Math.random() * 9000)}`;
        _avatarPath  = data.avatarPath  ?? DEFAULT_AVATAR_PATH;
    } else {
        _displayName = `player${Math.floor(1000 + Math.random() * 9000)}`;
        _avatarPath  = DEFAULT_AVATAR_PATH;
        await set(ref(db, `users/${_uid}`), {
            displayName: _displayName,
            avatarPath:  _avatarPath,
            createdAt:   { '.sv': 'timestamp' },
        });
    }

    _ready = true;
    console.log(`[UserProfile] uid=${_uid}  name=${_displayName}  avatar=${_avatarPath}`);
    window.dispatchEvent(new CustomEvent('profileReady', { detail: getProfile() }));
}

// Auto-run on module load — silently retries nothing; errors are logged only.
(async () => {
    try {
        _uid = await initAuth();
        await _initProfile();
    } catch (e) {
        console.error('[UserProfile] initialisation failed:', e);
    }
})();
