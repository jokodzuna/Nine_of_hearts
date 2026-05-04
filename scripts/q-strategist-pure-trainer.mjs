// Stub window for headless MCTS (ai-engine.js references window.AI_DEBUG)
globalThis.window = globalThis.window || { AI_DEBUG: false };

// ================================================================
// scripts/q-strategist-pure-trainer.mjs
// Trains q-table-strategist-pure.json against HeuristicBot ONLY.
// Warm-starts from q-table-strategist.json if pure table doesn't exist yet.
//
// Usage:
//   node scripts/q-strategist-pure-trainer.mjs [--games N] [--epsilon N] [--log-every N]
//
// Flags:
//   --games N      number of games (default: 20000)
//   --epsilon N    start epsilon (default: 0.25)
//   --log-every N  report every N games (default: 500)
// ================================================================

import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { HeuristicBot } from '../heuristic-bot.js';
import { writeFileSync, existsSync, readFileSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir       = dirname(fileURLToPath(import.meta.url));
const PURE_PATH   = join(__dir, '..', 'q-table-strategist-pure.json');
const SEED_PATH   = join(__dir, '..', 'q-table-strategist.json');

// ---- CLI args -------------------------------------------------------
function getArg(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const GAMES      = parseInt(getArg('--games',   '20000'), 10);
const EPS_START  = parseFloat(getArg('--epsilon', '0.25'));
const EPS_MIN    = 0.03;

// ---- Warm start: copy seed if pure table missing --------------------
if (!existsSync(PURE_PATH) && existsSync(SEED_PATH)) {
    copyFileSync(SEED_PATH, PURE_PATH);
    console.log(`[Warm start] copied ${SEED_PATH} → ${PURE_PATH}`);
}

// ---- Hyper-parameters -----------------------------------------------
const ALPHA      = 0.20;
const GAMMA      = 0.997;
const WIN_R      =  50.0;
const LOSE_R     = -50.0;
const STEP_LIMIT = 150;
const SAVE_EVERY = 200;
const LOG_EVERY  = parseInt(getArg('--log-every', '500'), 10);
const BOT        = 1;

// ---- Action indices / constants ------------------------------------
const ACT_QUAD = 6, ACT_DRAW = 7, N_ACTS = 8;
const RM = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];

// ---- Bit helpers ---------------------------------------------------
function pop(x) {
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    return (Math.imul((x + (x >>> 4)) & 0x0F0F0F, 0x010101) >>> 16) & 0xFF;
}

// ---- V2 state encoding (perspective-aware) -------------------------
function pClass(rk) { return rk <= 1 ? 0 : rk <= 3 ? 1 : 2; }
function bkt(n)     { return n >= 3 ? 3 : n; }
function pdepth(ps) { const d = ps - 1; return d <= 0 ? 0 : d <= 2 ? 1 : 2; }

function encodeState(s, pid) {
    const h   = s.hands[pid];
    const oh  = s.hands[1 - pid];
    const p2  = s.pileSize >= 2 ? pClass(s.pile[s.pileSize - 2] >> 2) : 3;
    const p3  = s.pileSize >= 3 ? pClass(s.pile[s.pileSize - 3] >> 2) : 3;
    const myH = Math.min(pop(h),  12);
    const opH = Math.min(pop(oh), 12);
    const myA = pop(h & RM[5]);
    return `${s.topRankIdx}|${p2}|${p3}` +
           `|${bkt(pop(h  & (RM[0]|RM[1])))}|${bkt(pop(h  & (RM[2]|RM[3])))}` +
           `|${myA}|${myH}|${opH}|${pdepth(s.pileSize)}|${bkt(pop(oh & (RM[4]|RM[5])))}`;
}

// ---- Move / action helpers -----------------------------------------
function moveToAct(m) {
    if (m & DRAW_FLAG) return ACT_DRAW;
    const bits = m & 0xFFFFFF;
    if (pop(bits) >= 3) return ACT_QUAD;
    return (31 - Math.clz32(bits)) >> 2;
}

function actToMove(moves, act) {
    if (act === ACT_DRAW) {
        for (const m of moves) if (m & DRAW_FLAG) return m;
        return null;
    }
    if (act === ACT_QUAD) {
        for (const m of moves) {
            if (!(m & DRAW_FLAG) && pop(m & 0xFFFFFF) >= 3) return m;
        }
        return null;
    }
    for (const m of moves) {
        if (m & DRAW_FLAG) continue;
        if (((31 - Math.clz32(m & 0xFFFFFF)) >> 2) === act) return m;
    }
    return null;
}

function legalActs(moves) {
    const s = new Set();
    for (const m of moves) s.add(moveToAct(m));
    return [...s];
}

// ---- Q-table --------------------------------------------------------
const Q = new Map();   // key → Float64Array(N_ACTS)
let totalNewStates = 0;
let logQUpdates = 0;

function qRow(key) {
    if (!Q.has(key)) {
        Q.set(key, new Float64Array(N_ACTS));
        totalNewStates++;
    }
    return Q.get(key);
}

function updateQ(key, act, reward, nextKey, nextLegalActs) {
    const row = qRow(key);
    let maxNext = 0;
    if (nextKey !== null) {
        const nRow = Q.get(nextKey);
        if (nRow) {
            maxNext = -Infinity;
            for (const a of nextLegalActs) maxNext = Math.max(maxNext, nRow[a]);
            if (maxNext === -Infinity) maxNext = 0;
        }
    }
    const old = row[act];
    row[act] += ALPHA * (reward + GAMMA * maxNext - old);
    logQUpdates++;
}

function pickAction(key, legal, eps) {
    const row = Q.get(key);
    if (!row || Math.random() < eps) return legal[Math.floor(Math.random() * legal.length)];
    let best = legal[0], bv = row[best];
    for (let i = 1; i < legal.length; i++) {
        const a = legal[i];
        if (row[a] > bv) { bv = row[a]; best = a; }
    }
    return best;
}

// ---- Load existing table --------------------------------------------
if (existsSync(PURE_PATH)) {
    try {
        const snap = JSON.parse(readFileSync(PURE_PATH, 'utf-8'));
        if (snap.table) {
            for (const [k, v] of Object.entries(snap.table)) {
                const arr = new Float64Array(N_ACTS);
                for (let i = 0; i < N_ACTS; i++) arr[i] = (v[i] === null || v[i] === undefined) ? -Infinity : v[i];
                Q.set(k, arr);
            }
            console.log(`Loaded ${Q.size} states from ${PURE_PATH}`);
        }
    } catch (e) {
        console.warn('Failed to load pure table, starting fresh:', e.message);
    }
}

// ---- Opponent -------------------------------------------------------
const heuristicBot = new HeuristicBot();

// ---- Single game ----------------------------------------------------
function playGame(eps) {
    let s = createInitialState(2);
    heuristicBot.resetKnowledge();

    const hist      = [];
    let totalMoves  = 0;

    while (!isGameOver(s) && totalMoves < STEP_LIMIT) {
        const p     = s.currentPlayer;
        const moves = getPossibleMoves(s);
        const lActs = legalActs(moves);
        totalMoves++;

        if (p !== BOT) {
            const conc = heuristicBot.chooseMove(s);
            heuristicBot.observeMove(s, conc);
            s = applyMove(s, conc);
            continue;
        }

        // ---- BOT's turn (ε-greedy) ---------------------------------
        const key  = encodeState(s, BOT);
        const act  = pickAction(key, lActs, eps);
        const conc = actToMove(moves, act) ?? moves[0];

        heuristicBot.observeMove(s, conc);
        qRow(key);
        hist.push({ key, act, lActs, prev: s, move: conc });
        s = applyMove(s, conc);
    }

    const timedOut = !isGameOver(s);
    const winner   = timedOut ? -1 : (getResult(s, BOT) > 0 ? BOT : 1 - BOT);
    const termR    = winner === BOT ? WIN_R : LOSE_R;   // timeout = loss

    for (let i = 0; i < hist.length; i++) {
        const { key, act, lActs: curLActs, prev, move } = hist[i];
        const stepR = 0;   // no per-step shaping
        if (i < hist.length - 1) {
            const { key: nKey, lActs: nActs } = hist[i + 1];
            updateQ(key, act, stepR, nKey, nActs);
        } else {
            updateQ(key, act, stepR + termR, null, []);
        }
    }

    return { winner, totalMoves };
}

// ---- Serialise ------------------------------------------------------
function serialise() {
    const out = {};
    for (const [k, r] of Q)
        out[k] = Array.from(r).map(v => isFinite(v) ? +v.toFixed(5) : null);
    return out;
}

// ---- Main loop ------------------------------------------------------
console.log(`\nQ-Strategist PURE Trainer`);
console.log(`Opponent: HeuristicBot (Strategist) 100%`);
console.log(`Games: ${GAMES.toLocaleString()}  |  ε: ${EPS_START}→${EPS_MIN}  |  α=${ALPHA}  |  γ=${GAMMA}`);
console.log(`Reward: win=+50  loss/timeout=-50  (no per-step shaping)`);
console.log(`Output: ${PURE_PATH}\n`);

let logWins=0, logLoss=0, logTO=0, logN=0, logMoves=0, logNewStatesSnap=0;

for (let g = 1; g <= GAMES; g++) {
    const eps = EPS_MIN + (EPS_START - EPS_MIN) * Math.pow(1 - (g - 1) / (GAMES - 1 || 1), 2);

    const { winner, totalMoves } = playGame(eps);
    const botWon = winner === BOT;
    const to     = winner === -1;

    logMoves += totalMoves;
    logN++;
    if (to)     logTO++;
    else if (botWon) logWins++;
    else            logLoss++;

    if (g % SAVE_EVERY === 0) {
        const snap = JSON.stringify({ games: g, stateCount: Q.size, table: serialise() });
        writeFileSync(PURE_PATH, snap);
        process.stdout.write(`  [saved g${g}: ${Q.size} states]\n`);
    }

    if (g % LOG_EVERY === 0) {
        const pct = (n, d) => d > 0 ? (n / d * 100).toFixed(1).padStart(5) + '%' : '  n/a';
        const newSt = totalNewStates - logNewStatesSnap;
        console.log(
            `  game ${String(g).padStart(6)}  ε=${eps.toFixed(3)}` +
            `  avgMoves=${(logMoves / logN).toFixed(1).padStart(5)}` +
            `  +states=${newSt.toString().padStart(5)}  total=${Q.size}  Qups=${logQUpdates}`
        );
        console.log(
            `    vs Strategist(${logN}): win=${pct(logWins,logN)}` +
            `  loss=${pct(logLoss,logN)}  TO=${pct(logTO,logN)}`
        );

        logWins=0; logLoss=0; logTO=0; logN=0;
        logMoves=0; logQUpdates=0;
        logNewStatesSnap = totalNewStates;
    }
}

writeFileSync(PURE_PATH, JSON.stringify({ games: GAMES, stateCount: Q.size, table: serialise() }));
console.log(`\nDone. ${Q.size} states total (+${totalNewStates} new this run)  →  ${PURE_PATH}`);
