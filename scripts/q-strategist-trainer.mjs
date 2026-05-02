// Stub window for headless MCTS (ai-engine.js references window.AI_DEBUG)
globalThis.window = globalThis.window || { AI_DEBUG: false };

// ================================================================
// scripts/q-strategist-trainer.mjs
// Fine-tunes q-table-strategist.json against HeuristicBot (Strategist).
//
// Discovered training protocol (burst-then-mix):
//   1. Pure burst vs HeuristicBot to anchor core knowledge:
//      node scripts/q-strategist-trainer.mjs --pure --games 20000 --epsilon 0.25
//   2. Mixed maintenance to broaden without catastrophic forgetting:
//      node scripts/q-strategist-trainer.mjs --games 10000
//   Repeat cycle whenever Strategist win rate drops below ~72%.
//
// Opponent mix per game (mixed mode):
//   25%  vs HeuristicBot   (target — learns its rule-based patterns)
//   25%  vs Pure Q-bot     (q-table.json + fast heuristic — keeps general skill)
//   25%  vs self           (greedy from frozen snapshot — self-play refinement)
//   25%  vs MCTS           (fast ISMCTS — tactical depth + anti-exploitation)
//
// Urgency mechanism: turn penalty escalates as game drags + hand-size shaping
// so the bot learns to FINISH games, not loop.
//
// Usage:
//   node scripts/q-strategist-trainer.mjs [--games N] [--epsilon N] [--pure [mode]] [--mcts-iters N] [--auto-cycle [N,M]]
//
// Flags:
//   --games N            number of games (default: 10000)
//   --epsilon N          start epsilon (default: 0.15)
//   --pure [mode]        100% vs one opponent: strategist | qbot | self | mcts
//   --mcts-iters N       MCTS iterations per move (default: 50)
//   --auto-cycle [N,M]   auto alternate anchor/generalize phases (default: 20000,10000)
// ================================================================

import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { HeuristicBot } from '../heuristic-bot.js';
import { ISMCTSEngine } from '../ai-engine.js';
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
const GAMES      = parseInt(getArg('--games',   '10000'), 10);
const EPS_START  = parseFloat(getArg('--epsilon', '0.15'));
const EPS_MIN    = 0.03;
const MCTS_ITERS = parseInt(getArg('--mcts-iters', '50'), 10);

// ---- Auto-cycle mode --------------------------------------------------
// Automatically alternates anchor (pure strategist) and generalize (mixed) phases.
// Default: 20k anchor, 10k generalize.  Override with --auto-cycle N,M
const AUTO_CYCLE = process.argv.includes('--auto-cycle');
let ANCHOR_GAMES = 20000;
let GEN_GAMES    = 10000;
if (AUTO_CYCLE) {
    const idx = process.argv.indexOf('--auto-cycle');
    const next = process.argv[idx + 1];
    if (next && next.includes(',')) {
        const [a, b] = next.split(',').map(s => parseInt(s.trim(), 10));
        if (a > 0) ANCHOR_GAMES = a;
        if (b > 0) GEN_GAMES = b;
    }
}
function cyclePhase(g) {
    if (!AUTO_CYCLE) return { anchor: false, phaseGames: GAMES, phaseStart: 1 };
    const cycleLen = ANCHOR_GAMES + GEN_GAMES;
    const pos = (g - 1) % cycleLen;
    const isAnchor = pos < ANCHOR_GAMES;
    const phaseGames = isAnchor ? ANCHOR_GAMES : GEN_GAMES;
    const phaseStart = g - pos + (isAnchor ? 0 : ANCHOR_GAMES);
    return { anchor: isAnchor, phaseGames, phaseStart };
}

// --pure [strategist|qbot|self|mcts]  — run 100% against one opponent (default: strategist)
function getPureMode() {
    const idx = process.argv.indexOf('--pure');
    if (idx === -1) return null;
    const next = process.argv[idx + 1];
    if (next && !next.startsWith('-')) {
        const m = next.toLowerCase();
        if (m === 'strategist' || m === 'heuristic') return 'heuristic';
        if (m === 'qbot' || m === 'q') return 'qbot';
        if (m === 'self' || m === 'mirror') return 'self';
        if (m === 'mcts') return 'mcts';
    }
    return 'heuristic'; // default when --pure has no value
}
const PURE_MODE = getPureMode();

// ---- Hyper-parameters -----------------------------------------------
const ALPHA      = 0.20;    // raised: needs to adapt quickly to strategist patterns
const GAMMA      = 0.997;
const WIN_R      =  50.0;
const LOSE_R     = -50.0;
const STEP_LIMIT = 150;     // total moves before declaring unfinished
const SAVE_EVERY = 200;
const LOG_EVERY  = 3000;
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

// ---- Frozen snapshot for self-play opponent -------------------------
let frozenSnapshot = new Map();   // copy of Q at last snapshot; self opponent reads this
function refreshSnapshot() {
    frozenSnapshot = new Map();
    for (const [k, r] of Q) frozenSnapshot.set(k, new Float64Array(r));
}

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
refreshSnapshot();   // seed frozen snapshot for self-play opponent

// ---- Fast heuristic fallback (used when Q-table misses) ------------
function fastHeuristic(state) {
    const moves = getPossibleMoves(state);
    const plays = moves.filter(m => !(m & DRAW_FLAG));
    if (plays.length === 0) return moves[0];
    let best = plays[0], bestRank = -1;
    for (const m of plays) {
        const rk = (31 - Math.clz32(m & 0xFFFFFF)) >> 2;
        if (rk > bestRank) { bestRank = rk; best = m; }
    }
    return best;
}

// ---- Headless Q-bot opponent (q-table.json + fast heuristic fallback)
class HeadlessQBot {
    constructor(tablePath) {
        this.table = null;
        if (existsSync(tablePath)) {
            const saved = JSON.parse(readFileSync(tablePath, 'utf8'));
            this.table = saved.table ?? saved;
            console.log(`Q-bot opponent loaded (${Object.keys(this.table).length} states)`);
        } else {
            console.warn('q-table.json not found — Q-bot opponent will use fast heuristic fallback');
        }
    }

    chooseMove(state) {
        const moves = getPossibleMoves(state);
        // q-table.json was trained with BOT=1 always — encode from player 1's perspective
        const key   = encodeState(state, 1);
        const lActs = legalActs(moves);

        if (!this.table) return fastHeuristic(state);
        const qrow = this.table[key];
        if (!qrow) return fastHeuristic(state);

        let best = lActs[0], bv = -Infinity;
        for (const a of lActs) {
            const v = qrow[a] ?? 0;
            if (v > bv) { bv = v; best = a; }
        }
        const conc = actToMove(moves, best);
        if (conc === null) return fastHeuristic(state);
        return conc;
    }
}

const qbotOpp = new HeadlessQBot(QBOT_PATH);

// ---- Heuristic opponent (shared instance, reset each game) ----------
const heuristicBot = new HeuristicBot();

// ---- Fast MCTS opponent (shared instance, reset each game) -----------
const MCTS_PROFILE = 'shark';
const BASE_MCTS = ISMCTSEngine.PROFILES[MCTS_PROFILE] ?? ISMCTSEngine.PROFILES.shark;
const FAST_MCTS = { ...BASE_MCTS, maxIterations: MCTS_ITERS, maxTime: MCTS_ITERS };
const mctsOpp = new ISMCTSEngine(MCTS_PROFILE);

// ---- Urgency + shaping reward ---------------------------------------
// isSelfPlay: when true, punish inaction harder (both bots share policy — loops likely)
function stepReward(prev, move, next, botTurnCount, totalMoves, isSelfPlay) {
    let r = 0;

    // 1. Escalating turn penalty
    const baseUrgency = 1 + Math.floor(totalMoves / 40);
    const urgencyMult = isSelfPlay ? 2.5 : 1.0;  // self-play: 2.5× harsher
    r -= botTurnCount * 0.015 * baseUrgency * urgencyMult;

    // 2. Hand-size shaping: small bonus for proactively playing cards (not drawing)
    // Drawing is strategically valid — we only reward playing to nudge the bot toward
    // finishing its hand, never punish drawing.
    if (!(move & DRAW_FLAG)) {
        const played = pop(move & 0xFFFFFF);
        r += (isSelfPlay ? 0.03 : 0.015) * played;
    }

    // 3. Blocking bonus
    const opp = 1 - BOT;
    const oppHand = next.hands[opp];
    if (pop(oppHand) > 0) {
        let oppCanPlay = false;
        for (let rk = next.topRankIdx; rk <= 5; rk++) {
            if (oppHand & RM[rk]) { oppCanPlay = true; break; }
        }
        if (!oppCanPlay) r += 0.06;
    }

    return r;
}

// ---- Single game ----------------------------------------------------
// oppType: 'heuristic' | 'qbot' | 'self' | 'mcts'
function playGame(eps, oppType) {
    const isSelfPlay = oppType === 'self';
    let s = createInitialState(2);
    heuristicBot.resetKnowledge();
    mctsOpp.resetKnowledge();

    const hist      = [];    // BOT's decision history
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
            let conc;
            if (oppType === 'heuristic') {
                conc = heuristicBot.chooseMove(s);
            } else if (oppType === 'qbot') {
                const act = qbotOpp.chooseMove(s);
                // qbotOpp.chooseMove returns a concrete move, not an action
                conc = act;  // HeadlessQBot already resolves to concrete move
            } else if (oppType === 'mcts') {
                conc = mctsOpp.chooseMove(s, FAST_MCTS);
            } else {
                // self: greedy from FROZEN snapshot (ε=0) — prevents policy chasing its own tail
                const key = encodeState(s, p);
                const r   = frozenSnapshot.get(key);
                if (r) {
                    let best = lActs[0], bv = -Infinity;
                    for (const a of lActs) { if (r[a] > bv) { bv = r[a]; best = a; } }
                    conc = actToMove(moves, best) ?? moves[0];
                } else {
                    conc = moves[0];
                }
            }

            // Notify heuristic bot and MCTS of opponent's move
            heuristicBot.observeMove(s, conc);
            mctsOpp.observeMove(s, conc);
            mctsOpp.advanceTree(conc);
            mctsOpp.cleanup();
            s = applyMove(s, conc);
            continue;
        }

        // ---- BOT's turn (Q-strategist ε-greedy) ----------------------
        const key  = encodeState(s, BOT);
        const act  = pickAction(key, lActs, eps);
        const conc = actToMove(moves, act) ?? moves[0];

        // Notify heuristic bot of our move too (so it tracks the game correctly)
        heuristicBot.observeMove(s, conc);

        qRow(key);   // pre-register state immediately
        hist.push({ key, act, lActs, prev: s, move: conc });
        s = applyMove(s, conc);
    }

    const timedOut = !isGameOver(s);
    const winner   = timedOut ? -1 : (getResult(s, BOT) > 0 ? BOT : 1 - BOT);

    // ---- Retrospective Q-update for BOT only ------------------------
    let termR;
    if (winner === BOT) {
        termR = WIN_R;
    } else if (timedOut) {
        const total = pop(s.hands[0]) + pop(s.hands[1]);
        const raw   = total > 0 ? 1.5 * (pop(s.hands[1 - BOT]) - pop(s.hands[BOT])) / total : 0;
        termR = Math.min(0, raw);
    } else {
        termR = LOSE_R;
    }

    for (let i = 0; i < hist.length; i++) {
        const { key, act, lActs: curLActs, prev, move } = hist[i];
        const stepR = stepReward(prev, move, s, turnCount[BOT], totalMoves, isSelfPlay);
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
if (PURE_MODE) {
    console.log(`PURE MODE: 100% vs ${PURE_MODE === 'heuristic' ? 'Strategist' : PURE_MODE === 'qbot' ? 'Q-bot' : PURE_MODE === 'mcts' ? 'MCTS-fast' : 'self (frozen snapshot)'}`);
} else if (AUTO_CYCLE) {
    console.log(`AUTO-CYCLE: anchor ${ANCHOR_GAMES.toLocaleString()} games → generalize ${GEN_GAMES.toLocaleString()} games (repeats)`);
} else {
    console.log(`Opponent mix: 25% Strategist | 25% Q-bot | 25% frozen-self | 25% MCTS-fast(${MCTS_ITERS}it/${MCTS_ITERS}ms)`);
}
console.log(`Games: ${GAMES.toLocaleString()}  |  ε: ${EPS_START}→${EPS_MIN} (smooth decay)  |  α=${ALPHA}  |  γ=${GAMMA}`);
if (AUTO_CYCLE) console.log(`Anchor phase: pure Strategist, ε=0.25  |  Generalize: mixed, ε=0.15`);
console.log(`Urgency: turn-penalty × urgency(1+floor(moves/40)) + hand-size shaping + blocking bonus`);
console.log(`Self-play: frozen snapshot opponent + 2.5× urgency`);
console.log(`Output: ${STRAT_PATH}\n`);

// Per-log-window counters
let logHWins=0, logHLoss=0, logHTO=0, logHN=0;
let logQWins=0, logQLoss=0, logQTO=0, logQN=0;
let logSWins=0, logSLoss=0, logSTO=0, logSN=0;
let logMWins=0, logMLoss=0, logMTO=0, logMN=0;
let logMoves=0, logN=0, logNewStatesSnap=0;

let lastPhase = null;
for (let g = 1; g <= GAMES; g++) {
    const { anchor: isAnchor, phaseGames, phaseStart } = cyclePhase(g);
    const phaseEpsStart = (AUTO_CYCLE && isAnchor) ? 0.25 : EPS_START;
    const eps = EPS_MIN + (phaseEpsStart - EPS_MIN) * Math.pow(1 - (g - phaseStart) / (phaseGames - 1 || 1), 2);
    const oppType = PURE_MODE ?? (AUTO_CYCLE && isAnchor ? 'heuristic' : ((r) => r < 0.25 ? 'heuristic' : r < 0.50 ? 'qbot' : r < 0.75 ? 'self' : 'mcts')(Math.random()));

    if (isAnchor !== lastPhase && AUTO_CYCLE) {
        console.log(`  [phase switch: ${isAnchor ? 'ANCHOR' : 'GENERALIZE'} at game ${g}]`);
        lastPhase = isAnchor;
    }

    const { winner, totalMoves } = playGame(eps, oppType);
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
    } else if (oppType === 'mcts') {
        logMN++;
        if      (to)     logMTO++;
        else if (botWon) logMWins++;
        else             logMLoss++;
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
        refreshSnapshot();   // freeze current policy for self-play opponent
    }

    if (g % LOG_EVERY === 0) {
        const pct = (n, d) => d > 0 ? (n / d * 100).toFixed(1).padStart(5) + '%' : '  n/a';
        const newSt = totalNewStates - logNewStatesSnap;
        const phaseTag = AUTO_CYCLE ? (cyclePhase(g).anchor ? ' [A]' : ' [G]') : '';
        console.log(
            `  game ${String(g).padStart(6)}${phaseTag}  ε=${eps.toFixed(3)}` +
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
        console.log(
            `    vs MCTS-fast (${logMN}): win=${pct(logMWins,logMN)}` +
            `  loss=${pct(logMLoss,logMN)}  TO=${pct(logMTO,logMN)}`
        );

        logHWins=0; logHLoss=0; logHTO=0; logHN=0;
        logQWins=0; logQLoss=0; logQTO=0; logQN=0;
        logSWins=0; logSLoss=0; logSTO=0; logSN=0;
        logMWins=0; logMLoss=0; logMTO=0; logMN=0;
        logMoves=0; logN=0; logQUpdates=0;
        logNewStatesSnap = totalNewStates;
    }
}

writeFileSync(STRAT_PATH, JSON.stringify({ games: GAMES, stateCount: Q.size, table: serialise() }));
console.log(`\nDone. ${Q.size} states total (+${totalNewStates} new this run)  →  q-table-strategist.json`);
