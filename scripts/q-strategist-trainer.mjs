// ================================================================
// scripts/q-strategist-trainer.mjs
// Fine-tunes q-table-strategist.json specifically against the
// HeuristicBot (Strategist) opponent.
//
// Opponent mix per game:
//   50%  vs HeuristicBot   (the target — adapts to its heuristics)
//   25%  vs Pure Q-bot     (q-table.json greedy — general skill)
//   25%  vs self           (q-table-strategist greedy — self-play)
//
// Only the Q-strategist (player 1) updates Q-values.
// Opponents play greedy / deterministic (no Q updates on their side).
//
// Usage:
//   node scripts/q-strategist-trainer.mjs [--games N] [--epsilon N]
//
// Recommended flags:
//   --games   10000   enough to see meaningful fine-tuning from warm start
//   --epsilon 0.15    moderate exploration; pre-trained table needs less than fresh
//
// Fixed hyper-parameters (tuned to match hybrid-trainer baseline):
//   α  = 0.05   (fine-tuning LR — avoids catastrophic forgetting of general skill)
//   γ  = 0.997  (same as hybrid-trainer)
//   WIN/LOSE = ±50 terminal, turn-penalty = -0.005 × turn_number
//   STEP_LIMIT = 150 total moves → counted as unfinished game in logs
// ================================================================

import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { HeuristicBot } from '../heuristic-bot.js';
import { writeFileSync, existsSync, readFileSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir       = dirname(fileURLToPath(import.meta.url));
const STRAT_PATH  = join(__dir, '..', 'q-table-strategist.json');
const QBOT_PATH   = join(__dir, '..', 'q-table.json');

// ---- CLI args -------------------------------------------------------
function getArg(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const GAMES     = parseInt(getArg('--games',   '10000'), 10);
const EPS_FIXED = parseFloat(getArg('--epsilon', '0.15'));

// ---- Hyper-parameters -----------------------------------------------
const ALPHA      = 0.05;    // fine-tuning LR (lower than fresh: 0.2)
const GAMMA      = 0.997;
const WIN_R      =  50.0;
const LOSE_R     = -50.0;
const STEP_LIMIT = 150;     // total moves before declaring unfinished
const SAVE_EVERY = 200;
const LOG_EVERY  = 500;
const BOT        = 1;       // Q-strategist is always player 1

// ---- Action indices / constants ------------------------------------
const ACT_QUAD = 6, ACT_DRAW = 7, N_ACTS = 8;
const RM = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];

// ---- Bit helpers ---------------------------------------------------
function pop(x) {
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    return (Math.imul((x + (x >>> 4)) & 0x0F0F0F, 0x010101) >>> 16) & 0xFF;
}

// ---- V2 state encoding (from any player's perspective) -------------
// Encoding is perspective-agnostic: "my hand" = pid's hand.
// This matches q-bot.js and hybrid-trainer.mjs exactly.
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

function legalActs(moves) { return [...new Set(moves.map(moveToAct))]; }

// ---- Q-table (Q-strategist, mutable) --------------------------------
const Q = new Map();
let totalNewStates = 0;

function qRow(key) {
    let r = Q.get(key);
    if (!r) { r = new Float64Array(N_ACTS).fill(0); Q.set(key, r); totalNewStates++; }
    return r;
}

function pickAction(key, lActs, eps) {
    if (Math.random() < eps) return lActs[(Math.random() * lActs.length) | 0];
    const r = qRow(key);
    let best = lActs[0], bv = -Infinity;
    for (const a of lActs) { if (r[a] > bv) { bv = r[a]; best = a; } }
    return best;
}

let logQUpdates = 0;

function updateQ(key, act, reward, nextKey, nextLActs) {
    const r   = qRow(key);
    const cur = r[act];
    let maxNext = 0;
    if (nextKey && nextLActs.length > 0) {
        const nr = Q.get(nextKey);
        if (nr) {
            maxNext = -Infinity;
            for (const a of nextLActs) { if (nr[a] > maxNext) maxNext = nr[a]; }
            if (!isFinite(maxNext)) maxNext = 0;
        }
    }
    r[act] = cur + ALPHA * (reward + GAMMA * maxNext - cur);
    logQUpdates++;
}

// ---- Load Q-strategist table (warm start) ---------------------------
if (existsSync(STRAT_PATH)) {
    const saved = JSON.parse(readFileSync(STRAT_PATH, 'utf8'));
    const data  = saved.table ?? saved;
    let loaded  = 0;
    for (const [k, arr] of Object.entries(data)) {
        const r = new Float64Array(N_ACTS);
        for (let i = 0; i < N_ACTS; i++) r[i] = arr[i] == null ? 0 : arr[i];
        Q.set(k, r); loaded++;
    }
    console.log(`Warm-start: loaded ${loaded} states from q-table-strategist.json`);
} else if (existsSync(QBOT_PATH)) {
    console.log('q-table-strategist.json not found — copying q-table.json as seed...');
    copyFileSync(QBOT_PATH, STRAT_PATH);
    const saved = JSON.parse(readFileSync(STRAT_PATH, 'utf8'));
    const data  = saved.table ?? saved;
    let loaded  = 0;
    for (const [k, arr] of Object.entries(data)) {
        const r = new Float64Array(N_ACTS);
        for (let i = 0; i < N_ACTS; i++) r[i] = arr[i] == null ? 0 : arr[i];
        Q.set(k, r); loaded++;
    }
    console.log(`Seeded from q-table.json: ${loaded} states`);
} else {
    console.log('No seed table found — starting fresh.');
}

// ---- Load Q-bot opponent (q-table.json, greedy, read-only) ----------
let qbotTable = null;
if (existsSync(QBOT_PATH)) {
    const saved = JSON.parse(readFileSync(QBOT_PATH, 'utf8'));
    qbotTable   = saved.table ?? saved;
    console.log(`Q-bot opponent table loaded (${Object.keys(qbotTable).length} states)`);
} else {
    console.warn('q-table.json not found — Q-bot opponent will play lowest-rank single');
}

// Greedy lookup in a plain JSON table (read-only opponent)
function greedyFromJSON(table, key, lActs) {
    if (!table) return lActs[(Math.random() * lActs.length) | 0];
    const qrow = table[key];
    if (!qrow) return lActs[(Math.random() * lActs.length) | 0];
    let best = lActs[0], bv = -Infinity;
    for (const a of lActs) {
        const v = qrow[a] ?? 0;
        if (v > bv) { bv = v; best = a; }
    }
    return best;
}

// Greedy lookup in the live Map (self-play opponent, ε=0)
function greedyFromMap(key, lActs) {
    const r = Q.get(key);
    if (!r) return lActs[(Math.random() * lActs.length) | 0];
    let best = lActs[0], bv = -Infinity;
    for (const a of lActs) { if (r[a] > bv) { bv = r[a]; best = a; } }
    return best;
}

// ---- Heuristic opponent (one shared instance, reset each game) ------
const heuristicBot = new HeuristicBot();

// ---- Single game ----------------------------------------------------
// oppType: 'heuristic' | 'qbot' | 'self'
// Returns: { winner (-1=timeout, 0=p0 won, 1=p1/BOT won), totalMoves }
function playGame(eps, oppType) {
    let s = createInitialState(2);
    heuristicBot.resetKnowledge();

    const hist      = [];    // BOT's decision history: {key, act, lActs, tPen}
    let totalMoves  = 0;
    const turnCount = [0, 0];

    while (!isGameOver(s) && totalMoves < STEP_LIMIT) {
        const p     = s.currentPlayer;
        const moves = getPossibleMoves(s);
        const lActs = legalActs(moves);
        totalMoves++;
        turnCount[p]++;

        if (p !== BOT) {
            // ---- Opponent turn (no Q update) -------------------------
            let act;
            if (oppType === 'heuristic') {
                const conc = heuristicBot.chooseMove(s);
                s = applyMove(s, conc);
                continue;
            } else if (oppType === 'qbot') {
                act = greedyFromJSON(qbotTable, encodeState(s, p), lActs);
            } else {
                // self: greedy Q-strategist (ε=0)
                act = greedyFromMap(encodeState(s, p), lActs);
            }
            const conc = actToMove(moves, act) ?? moves[0];
            s = applyMove(s, conc);
            continue;
        }

        // ---- BOT's turn (Q-strategist ε-greedy) ----------------------
        const key  = encodeState(s, BOT);
        const act  = pickAction(key, lActs, eps);
        const conc = actToMove(moves, act) ?? moves[0];
        // Turn penalty scales with how many turns BOT has taken
        const tPen = -(turnCount[BOT] * 0.005);
        qRow(key);   // pre-register so next-state bootstrap is never stale
        hist.push({ key, act, lActs, tPen });
        s = applyMove(s, conc);
    }

    const timedOut = !isGameOver(s);
    const winner   = timedOut ? -1 : (getResult(s, BOT) > 0 ? BOT : 1 - BOT);

    // ---- Retrospective Q-update for BOT only ------------------------
    let termR;
    if (winner === BOT) {
        termR = WIN_R;
    } else if (timedOut) {
        // Partial credit only as penalty: proportional card disadvantage
        const total = pop(s.hands[0]) + pop(s.hands[1]);
        const raw   = total > 0 ? 1.5 * (pop(s.hands[1 - BOT]) - pop(s.hands[BOT])) / total : 0;
        termR = Math.min(0, raw);
    } else {
        termR = LOSE_R;
    }

    for (let i = 0; i < hist.length; i++) {
        const { key, act, tPen, lActs: curLActs } = hist[i];
        const stepR = tPen;   // only turn penalty (no hand-shaping)
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
console.log(`\nQ-Strategist Trainer`);
console.log(`Games: ${GAMES.toLocaleString()}  |  ε=${EPS_FIXED} (fixed)  |  α=${ALPHA}  |  γ=${GAMMA}`);
console.log(`Opponent mix: 50% Strategist (HeuristicBot) | 25% Q-bot | 25% self`);
console.log(`WIN/LOSE = ±${WIN_R}  |  turn-penalty=0.005/turn  |  step-limit=${STEP_LIMIT}`);
console.log(`Output: ${STRAT_PATH}\n`);

// Per-log-window counters (reset every LOG_EVERY games)
let logHWins=0, logHLoss=0, logHTO=0, logHN=0;
let logQWins=0, logQLoss=0, logQTO=0, logQN=0;
let logSWins=0, logSLoss=0, logSTO=0, logSN=0;
let logMoves=0, logN=0, logNewStatesSnap=0;

for (let g = 1; g <= GAMES; g++) {
    const r = Math.random();
    const oppType = r < 0.50 ? 'heuristic' : r < 0.75 ? 'qbot' : 'self';
    const { winner, totalMoves } = playGame(EPS_FIXED, oppType);
    const botWon = winner === BOT;
    const to     = winner === -1;

    logMoves += totalMoves;
    logN++;

    if (oppType === 'heuristic') {
        logHN++;
        if      (to)     logHTO++;
        else if (botWon) logHWins++;
        else             logHLoss++;
    } else if (oppType === 'qbot') {
        logQN++;
        if      (to)     logQTO++;
        else if (botWon) logQWins++;
        else             logQLoss++;
    } else {
        logSN++;
        if      (to)     logSTO++;
        else if (botWon) logSWins++;
        else             logSLoss++;
    }

    if (g % SAVE_EVERY === 0) {
        const snap = JSON.stringify({ games: g, stateCount: Q.size, table: serialise() });
        writeFileSync(STRAT_PATH, snap);
        process.stdout.write(`  [saved g${g}: ${Q.size} states]\n`);
    }

    if (g % LOG_EVERY === 0) {
        const pct = (n, d) => d > 0 ? (n / d * 100).toFixed(1).padStart(5) + '%' : '  n/a';
        const newSt = totalNewStates - logNewStatesSnap;
        console.log(
            `  game ${String(g).padStart(6)}  ε=${EPS_FIXED.toFixed(2)}` +
            `  avgMoves=${(logMoves / logN).toFixed(1).padStart(5)}` +
            `  +states=${newSt.toString().padStart(5)}  total=${Q.size}  Qups=${logQUpdates}`
        );
        console.log(
            `    vs Strategist(${logHN}): win=${pct(logHWins,logHN)}` +
            `  loss=${pct(logHLoss,logHN)}  TO=${pct(logHTO,logHN)}`
        );
        console.log(
            `    vs Q-bot     (${logQN}): win=${pct(logQWins,logQN)}` +
            `  loss=${pct(logQLoss,logQN)}  TO=${pct(logQTO,logQN)}`
        );
        console.log(
            `    vs self      (${logSN}): win=${pct(logSWins,logSN)}` +
            `  loss=${pct(logSLoss,logSN)}  TO=${pct(logSTO,logSN)}`
        );

        logHWins=0; logHLoss=0; logHTO=0; logHN=0;
        logQWins=0; logQLoss=0; logQTO=0; logQN=0;
        logSWins=0; logSLoss=0; logSTO=0; logSN=0;
        logMoves=0; logN=0; logQUpdates=0;
        logNewStatesSnap = totalNewStates;
    }
}

writeFileSync(STRAT_PATH, JSON.stringify({ games: GAMES, stateCount: Q.size, table: serialise() }));
console.log(`\nDone. ${Q.size} states total (+${totalNewStates} new this run)  →  q-table-strategist.json`);
