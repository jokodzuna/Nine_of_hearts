// ============================================================
// scripts/q-trainer.mjs
// Q-table trainer for the Botfather (player 1, black cards)
//
// Usage:  node scripts/q-trainer.mjs [episodes]
// Output: q-table.json  (project root)
//
// Algorithm: Q-learning  Q(s,a) ← Q(s,a) + α[r + γ·maxQ(s') − Q(s,a)]
// Exploration: untried actions always picked first (optimistic init);
//              once all actions tried → ε-greedy decay.
// Opponent:    random (fast; upgrade to heuristic in Phase 2)
// ============================================================

import { createBotfatherState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dir      = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(__dir, '..', 'q-table.json');

// ---- Hyper-parameters -----------------------------------------------
const EPISODES   = parseInt(process.argv[2] ?? '500000', 10);
const ALPHA      = 0.2;    // learning rate
const GAMMA      = 0.97;   // discount factor
const EPS_START  = 1.0;
const EPS_MIN    = 0.05;
const EPS_DECAY  = Math.pow(EPS_MIN / EPS_START, 1 / (EPISODES * 0.8));
const SAVE_EVERY = 25000;
const LOG_EVERY  = 10000;

const BOT = 1;   // Botfather = player 1 (black cards), opponent = player 0

// ---- Action indices -------------------------------------------------
//  0-5 map directly to rank index (9, 10, J, Q, K, A)
const ACT_QUAD = 6;
const ACT_DRAW = 7;
const N_ACTS   = 8;

// ---- Bit helpers ----------------------------------------------------
const RM = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];

function pop(x) {
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    return (Math.imul((x + (x >>> 4)) & 0x0F0F0F, 0x010101) >>> 16) & 0xFF;
}

// ---- State encoding  (8 features → pipe-separated string key) -------
//
//  topRankIdx  (0-5)         exact top card rank
//  pile2class  (0-3)         2nd pile card: L=0 F=1 A=2 empty=3
//  pile3class  (0-3)         3rd pile card
//  myLiab      (0-3)         count 9s+10s  (capped at 3+)
//  myFill      (0-3)         count Js+Qs
//  myAsset     (0-3)         count Ks+As
//  myDist      (0-2)         cards left: 1→0  2→1  3+→2
//  oppDist     (0-2)         opp cards left: same buckets

function pClass(rk) { return rk <= 1 ? 0 : rk <= 3 ? 1 : 2; }
function bkt(n)     { return n >= 3 ? 3 : n; }
function dst(n)     { return n <= 1 ? 0 : n === 2 ? 1 : 2; }

function encodeState(s) {
    const h  = s.hands[BOT];
    const oh = s.hands[1 - BOT];
    const p2 = s.pileSize >= 2 ? pClass(s.pile[s.pileSize - 2] >> 2) : 3;
    const p3 = s.pileSize >= 3 ? pClass(s.pile[s.pileSize - 3] >> 2) : 3;
    return `${s.topRankIdx}|${p2}|${p3}|${bkt(pop(h & (RM[0]|RM[1])))}|${bkt(pop(h & (RM[2]|RM[3])))}|${bkt(pop(h & (RM[4]|RM[5])))}|${dst(pop(h))}|${dst(pop(oh))}`;
}

// ---- Action ↔ concrete move mapping --------------------------------

function moveToAct(m) {
    if (m & DRAW_FLAG) return ACT_DRAW;
    const bits = m & 0xFFFFFF;
    if (pop(bits) >= 3) return ACT_QUAD;
    return (31 - Math.clz32(bits)) >> 2;   // rank index 0-5
}

function actToMove(moves, act) {
    if (act === ACT_DRAW) {
        for (const m of moves) if (m & DRAW_FLAG) return m;
        return null;
    }
    if (act === ACT_QUAD) {
        for (const m of moves) if (!(m & DRAW_FLAG) && pop(m & 0xFFFFFF) >= 3) return m;
        return null;
    }
    for (const m of moves) {
        if (m & DRAW_FLAG) continue;
        const bits = m & 0xFFFFFF;
        if (pop(bits) === 1 && ((31 - Math.clz32(bits)) >> 2) === act) return m;
    }
    return null;
}

// ---- Q-table  (Infinity = untried — always chosen over tried actions) ---
const Q = new Map();   // key → Float64Array(N_ACTS)

function row(key) {
    let r = Q.get(key);
    if (!r) { r = new Float64Array(N_ACTS).fill(Infinity); Q.set(key, r); }
    return r;
}

function legalActs(moves) {
    return [...new Set(moves.map(moveToAct))];
}

function pickAction(key, legal, eps) {
    const r       = row(key);
    const untried = legal.filter(a => !isFinite(r[a]));
    if (untried.length > 0) {
        // Always exhaust untried actions first (user spec)
        return untried[(Math.random() * untried.length) | 0];
    }
    // All tried: ε-greedy
    if (Math.random() < eps) return legal[(Math.random() * legal.length) | 0];
    let best = legal[0], bv = -Infinity;
    for (const a of legal) { if (r[a] > bv) { bv = r[a]; best = a; } }
    return best;
}

function updateQ(key, act, r, nextKey, nextLegal) {
    const qrow = row(key);
    const cur  = isFinite(qrow[act]) ? qrow[act] : 0;
    let maxNext = 0;
    if (nextKey) {
        const nr = row(nextKey);
        for (const a of nextLegal) { const v = isFinite(nr[a]) ? nr[a] : 0; if (v > maxNext) maxNext = v; }
    }
    qrow[act] = cur + ALPHA * (r + GAMMA * maxNext - cur);
}

// ---- Reward function ------------------------------------------------

function stepReward(prev, move, next) {
    let r = 0;
    const opp = 1 - BOT;

    if (move & DRAW_FLAG) {
        const ph = prev.hands[BOT], nh = next.hands[BOT];
        const drawn = (nh & ~ph) & 0xFFFFFF;
        const p9  = pop(ph & RM[0]);
        const p10 = pop(ph & RM[1]);

        let mask = drawn;
        while (mask) {
            const lb = mask & (-mask); mask &= ~lb;
            const rk = (31 - Math.clz32(lb)) >> 2;
            if (rk >= 4) {
                r += 0.08;   // K or A — quality gain
            } else if (rk === 0) {
                // 9: positive only if it completes triple 9s
                r += (p9 < 3 && pop(nh & RM[0]) >= 3) ? 0.03 : -0.06;
            } else if (rk === 1) {
                // 10: positive only if it completes four 10s
                r += (p10 < 4 && pop(nh & RM[1]) >= 4) ? 0.03 : -0.02;
            }
            // J / Q: neutral (0)
        }

        // 4-of-a-kind completion bonus for J/Q/K/A
        for (let rk = 2; rk <= 5; rk++) {
            if (pop(ph & RM[rk]) < 4 && pop(nh & RM[rk]) === 4) { r += 0.03; break; }
        }

        // Passivity penalty: drew while opp has ≤2 cards AND can immediately play
        const oh = next.hands[opp], ot = pop(oh);
        if (ot > 0 && ot <= 2) {
            for (let rk = next.topRankIdx; rk <= 5; rk++) {
                if (oh & RM[rk]) { r -= 0.06; break; }
            }
        }

    } else {
        // Play move
        if (pop(next.hands[BOT]) < pop(prev.hands[BOT])) r += 0.02;   // hand shrunk

        const oh = next.hands[opp], ot = pop(oh);
        if (ot > 0) {
            let oppCanPlay = false;
            for (let rk = next.topRankIdx; rk <= 5; rk++) {
                if (oh & RM[rk]) { oppCanPlay = true; break; }
            }
            if (!oppCanPlay) {
                if      (ot === 1) r += 0.10;   // blocked opp's last card
                else if (ot <= 3)  r += 0.06;   // forced draw when ≤3 cards
            }
        }
    }
    return r;
}

// ---- Random opponent (fast; suitable for Phase 1 training) ----------
function randMove(s) {
    const m = getPossibleMoves(s);
    return m[(Math.random() * m.length) | 0];
}

// ---- Single episode -------------------------------------------------
function episode(eps) {
    let s = createBotfatherState();

    for (let step = 0; step < 300; step++) {
        if (isGameOver(s)) break;

        // Opponent turn: random move
        if (s.currentPlayer !== BOT) {
            s = applyMove(s, randMove(s));
            continue;
        }

        // Bot turn
        const key   = encodeState(s);
        const moves = getPossibleMoves(s);
        const legal = legalActs(moves);
        const act   = pickAction(key, legal, eps);

        let conc = actToMove(moves, act);
        if (conc === null) conc = moves[0];   // safety fallback

        const ns = applyMove(s, conc);

        // Terminal after bot's move?
        if (isGameOver(ns)) {
            const r = getResult(ns, BOT) > 0 ? 1.0 : -1.0;
            updateQ(key, act, r, null, []);
            return r > 0 ? 1 : 0;
        }

        // Fast-forward opponent turns to reach the next BOT decision point
        let ns2 = ns;
        while (!isGameOver(ns2) && ns2.currentPlayer !== BOT) {
            ns2 = applyMove(ns2, randMove(ns2));
        }

        const r = stepReward(s, conc, ns);

        if (isGameOver(ns2)) {
            const termR = getResult(ns2, BOT) > 0 ? 1.0 : -1.0;
            updateQ(key, act, r + termR, null, []);
            return termR > 0 ? 1 : 0;
        }

        const nKey   = encodeState(ns2);
        const nMoves = getPossibleMoves(ns2);
        updateQ(key, act, r, nKey, legalActs(nMoves));

        s = ns2;
    }
    return 0;
}

// ---- Serialise table (nulls preserve "untried" slots visually) ------
function serialise() {
    const out = {};
    for (const [k, r] of Q) {
        out[k] = Array.from(r).map(v => isFinite(v) ? +v.toFixed(5) : null);
    }
    return out;
}

// ---- Main -----------------------------------------------------------
console.log(`\nQ-trainer  |  episodes=${EPISODES.toLocaleString()}  α=${ALPHA}  γ=${GAMMA}  ε: ${EPS_START}→${EPS_MIN}`);
console.log(`Output: ${TABLE_PATH}\n`);

let eps = EPS_START, wins = 0;
for (let ep = 1; ep <= EPISODES; ep++) {
    wins += episode(eps);
    eps   = Math.max(EPS_MIN, eps * EPS_DECAY);

    if (ep % LOG_EVERY === 0) {
        const wr = (wins / LOG_EVERY * 100).toFixed(1);
        console.log(`  ep ${String(ep).padStart(9)}  ε=${eps.toFixed(4)}  winRate=${wr.padStart(5)}%  states=${Q.size}`);
        wins = 0;
    }
    if (ep % SAVE_EVERY === 0) {
        writeFileSync(TABLE_PATH, JSON.stringify(
            { episodes: ep, epsilon: +eps.toFixed(6), stateCount: Q.size, table: serialise() }
        ));
        process.stdout.write(`  → checkpoint saved (${Q.size} states)\n`);
    }
}

writeFileSync(TABLE_PATH, JSON.stringify(
    { episodes: EPISODES, epsilon: +eps.toFixed(6), stateCount: Q.size, table: serialise() }
));
console.log(`\nDone. ${Q.size} states discovered. Table → q-table.json`);
