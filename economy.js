// ============================================================
// economy.js — Coins, Stats, Achievements
// Nine of Hearts
// ============================================================

import { ref, get, update } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';
import { getDB }             from './multiplayer.js';
import { playAchievementSound } from './audio.js';

// ============================================================
// Achievement Definitions
// ============================================================

const _ACHIEVEMENTS = [
    {
        id:    'first_survival',
        title: 'First Survival',
        desc:  'Survive your first game',
        coins: 50,
        check: (stats, _r) => stats.gamesSurvived >= 1,
    },
    {
        id:    'comeback_king',
        title: 'Comeback King',
        desc:  'Survive after holding 15+ cards at once',
        coins: 100,
        check: (_s, r) => r.survived && r.maxCardsHeld >= 15,
    },
    {
        id:    'speed_demon',
        title: 'Speed Demon',
        desc:  'Clear your hand in under 3 minutes',
        coins: 100,
        check: (_s, r) => r.survived && r.gameTimeMs < 3 * 60_000,
    },
    {
        id:    'streak_master',
        title: 'Streak Master',
        desc:  'Survive 10 games in a row',
        coins: 75,
        check: (stats, _r) => stats.longestSurvivalStreak >= 10,
    },
    {
        id:    'quad_squad',
        title: 'Quad Squad',
        desc:  'Play a four-of-a-kind 10 times total',
        coins: 125,
        check: (stats, _r) => stats.foursPlayed >= 10,
    },
];

// ============================================================
// State
// ============================================================

function _defaultStats() {
    return {
        gamesPlayed:           0,
        gamesSurvived:         0,
        gamesLost:             0,
        survivalRate:          0,
        longestSurvivalStreak: 0,
        currentSurvivalStreak: 0,
        foursPlayed:           0,
    };
}

let _uid          = null;
let _coins        = 0;
let _stats        = _defaultStats();
let _achievements = {};
let _ready        = false;
let _readyCbs     = [];

// ============================================================
// Public API
// ============================================================

export function getCoins()                { return _coins; }
export function getStats()                { return { ..._stats }; }
export function getUnlockedAchievements() { return { ..._achievements }; }
export function isEconomyReady()          { return _ready; }

export function onEconomyReady(cb) {
    if (_ready) { Promise.resolve().then(cb); return; }
    _readyCbs.push(cb);
}

/**
 * Call once per finished game.
 * @param {boolean} p.survived             — true if the human cleared their hand
 * @param {number}  p.foursPlayedThisGame  — four-of-a-kind plays by the human this game
 * @param {number}  p.gameTimeMs           — elapsed ms since game start
 * @param {number}  p.maxCardsHeld         — peak hand size the human reached
 */
export async function recordGameResult({
    survived,
    foursPlayedThisGame = 0,
    gameTimeMs          = 0,
    maxCardsHeld        = 0,
}) {
    if (!_uid) return;

    // ---- Update stats ----
    const s = { ..._stats };
    s.gamesPlayed++;
    s.foursPlayed += foursPlayedThisGame;

    if (survived) {
        s.gamesSurvived++;
        s.currentSurvivalStreak++;
        if (s.currentSurvivalStreak > s.longestSurvivalStreak)
            s.longestSurvivalStreak = s.currentSurvivalStreak;
    } else {
        s.gamesLost++;
        s.currentSurvivalStreak = 0;
    }
    s.survivalRate = s.gamesPlayed > 0
        ? Math.round((s.gamesSurvived / s.gamesPlayed) * 100)
        : 0;

    // ---- Grant base coins ----
    let earned = survived ? 10 : 2;

    // ---- Check achievements ----
    const result        = { survived, foursPlayedThisGame, gameTimeMs, maxCardsHeld };
    const newlyUnlocked = [];
    for (const ach of _ACHIEVEMENTS) {
        if (_achievements[ach.id]) continue;
        if (ach.check(s, result)) {
            newlyUnlocked.push(ach);
            _achievements[ach.id] = true;
            earned += ach.coins;
        }
    }

    // ---- Apply locally ----
    _stats  = s;
    _coins += earned;
    _updateCoinDisplay();

    // ---- Persist to Firebase ----
    const updates = {
        coins:                         _coins,
        'stats/gamesPlayed':           s.gamesPlayed,
        'stats/gamesSurvived':         s.gamesSurvived,
        'stats/gamesLost':             s.gamesLost,
        'stats/survivalRate':          s.survivalRate,
        'stats/longestSurvivalStreak': s.longestSurvivalStreak,
        'stats/currentSurvivalStreak': s.currentSurvivalStreak,
        'stats/foursPlayed':           s.foursPlayed,
    };
    for (const ach of newlyUnlocked) updates[`achievements/${ach.id}`] = true;

    try { await update(ref(getDB(), `users/${_uid}`), updates); }
    catch (e) { console.error('[Economy] Firebase update failed:', e); }

    // ---- Show achievement popups (staggered) ----
    for (let i = 0; i < newlyUnlocked.length; i++) {
        const ach = newlyUnlocked[i];
        setTimeout(() => {
            playAchievementSound();
            _showAchievementPopup(ach);
        }, i * 1400);
    }
}

/**
 * Wipe all progress for the current user.
 */
export async function resetAllData() {
    if (!_uid) return;
    _coins        = 0;
    _stats        = _defaultStats();
    _achievements = {};
    _updateCoinDisplay();
    try {
        await update(ref(getDB(), `users/${_uid}`), {
            coins:        0,
            stats:        _defaultStats(),
            achievements: {},
        });
    } catch (e) { console.error('[Economy] reset failed:', e); }
}

// ============================================================
// Private helpers
// ============================================================

function _updateCoinDisplay() {
    const el = document.getElementById('coinBalance');
    if (el) el.textContent = _coins;
}

function _showAchievementPopup(ach) {
    const el = document.createElement('div');
    el.className = 'achievement-popup';
    el.innerHTML =
        `<span class="ach-icon">&#127942;</span>` +
        `<div class="ach-body">` +
        `<div class="ach-unlocked">Achievement Unlocked!</div>` +
        `<div class="ach-title">${ach.title}</div>` +
        `<div class="ach-desc">${ach.desc}</div>` +
        `<div class="ach-reward">+${ach.coins} &#129689;</div>` +
        `</div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() =>
        requestAnimationFrame(() => el.classList.add('achievement-popup--in'))
    );
    setTimeout(() => {
        el.classList.remove('achievement-popup--in');
        setTimeout(() => el.remove(), 500);
    }, 3800);
}

async function _initEconomy(uid) {
    _uid = uid;
    try {
        const snap = await get(ref(getDB(), `users/${uid}`));
        if (snap.exists()) {
            const d       = snap.val();
            _coins        = d.coins                             ?? 0;
            _stats        = { ..._defaultStats(), ...(d.stats        ?? {}) };
            _achievements = { ...(d.achievements ?? {}) };
        }
    } catch (e) { console.error('[Economy] load failed:', e); }
    _ready = true;
    for (const cb of _readyCbs) cb();
    _readyCbs = [];
    _updateCoinDisplay();
}

// Auto-init once Firebase auth + profile is ready
window.addEventListener('profileReady', e => _initEconomy(e.detail.uid), { once: true });
