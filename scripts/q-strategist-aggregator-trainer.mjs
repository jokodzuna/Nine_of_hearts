// Stub window for headless MCTS (ai-engine.js references window.AI_DEBUG)
globalThis.window = globalThis.window || { AI_DEBUG: false };

// ================================================================
// scripts/q-strategist-aggregator-trainer.mjs
// Train or evaluate Q-strategist-aggregator against a mix of opponents.
//
// Usage (training):
//   node scripts/q-strategist-aggregator-trainer.mjs [--games N] [--duration H] [--epsilon N] [--pure profile] [--log-every N]
//
// Usage (evaluation / no learning):
//   node scripts/q-strategist-aggregator-trainer.mjs --test [--games N] [--duration H] [--pure profile]
//
// Flags:
//   --games N            number of games (default: 10000 train / 1000 test)
//   --duration H         run for H hours instead of fixed game count
//   --log-every N        report interval (default: 500 games, or 20 in duration mode)
//   --epsilon N          start epsilon (default: 0.15 train / 0.0 test)
//   --pure profile       100% vs one opponent:
//                        qstrat | qstratpure | qstratmcts | strategist | strategist2
//   --test               evaluation mode: no learning, ε=0, detailed per-profile stats
//
// Default opponent mix (training & mixed evaluation):
//   20%  Q-Strategist (q-table-strategist.json)
//   20%  Q-Strategist-Pure (q-table-strategist-pure.json)
//   20%  Q-Strategist-MCTS (q-table-strategist-mcts.json)
//   20%  Strategist (HeuristicBot)
//   20%  Strategist2 (Strategist2Bot)
//
// Output: q-table-aggregator.json
// Warm-start: loads q-table-aggregator.json if it exists,
//             otherwise seeds from q-table-strategist-mcts.json.
// ================================================================

import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { HeuristicBot } from '../heuristic-bot.js';
import { Strategist2Bot } from '../strategist2-bot.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir       = dirname(fileURLToPath(import.meta.url));
const OUT_PATH    = join(__dir, '..', 'q-table-aggregator.json');
const SEED_PATH   = join(__dir, '..', 'q-table-strategist-mcts.json');
const QSTRAT_PATH = join(__dir, '..', 'q-table-strategist.json');
const QSTRAT_PURE_PATH = join(__dir, '..', 'q-table-strategist-pure.json');
const QSTRAT_MCTS_PATH = join(__dir, '..', 'q-table-strategist-mcts.json');

// ---- CLI args -------------------------------------------------------
function getArg(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const TEST_MODE  = process.argv.includes('--test');
const DURATION_H = parseFloat(getArg('--duration', '0'));  // hours; 0 = use --games
const DEF_GAMES  = TEST_MODE ? '1000' : '10000';
const DEF_EPS    = TEST_MODE ? '0.0'  : '0.15';
const GAMES      = DURATION_H > 0 ? Infinity : parseInt(getArg('--games', DEF_GAMES), 10);
const EPS_START  = parseFloat(getArg('--epsilon', DEF_EPS));
const EPS_MIN    = TEST_MODE ? 0.0 : 0.03;

const END_TIME   = DURATION_H > 0 ? Date.now() + DURATION_H * 3600_000 : Infinity;

// --pure [qstrat|qstratpure|qstratmcts|strategist|strategist2]
function getPureMode() {
    const idx = process.argv.indexOf('--pure');
    if (idx === -1) return null;
    const next = process.argv[idx + 1];
    if (next && !next.startsWith('-')) {
        const m = next.toLowerCase();
        if (['qstrat','q-strategist','qstrategist'].includes(m)) return 'qstrat';
        if (['qstratpure','q-strategist-pure','qstrategistpure','pure'].includes(m)) return 'qstratpure';
        if (['qstratmcts','q-strategist-mcts','qstrategistmcts','mcts'].includes(m)) return 'qstratmcts';
        if (['strategist','heuristic','heuristicbot','strat'].includes(m)) return 'strategist';
        if (['strategist2','strat2','s2'].includes(m)) return 'strategist2';
    }
    return null;
}
const PURE_MODE = getPureMode();

// ---- Hyper-parameters -----------------------------------------------
const ALPHA      = 0.20;
const GAMMA      = 0.997;
const WIN_R      =  50.0;
const LOSE_R     = -50.0;
const STEP_LIMIT = 150;
const SAVE_EVERY = DURATION_H > 0 ? 50 : 1000;
const LOG_EVERY  = parseInt(getArg('--log-every', DURATION_H > 0 ? '20' : '500'), 10);
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

// ---- Q-table (Q-strategist-aggregator, mutable) --------------------
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
    if (TEST_MODE) return; // no learning in test mode
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

// ---- Load Q-table (warm start) --------------------------------------
if (existsSync(OUT_PATH)) {
    const saved = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    const data  = saved.table ?? saved;
    let loaded  = 0;
    for (const [k, arr] of Object.entries(data)) {
        const r = new Float64Array(N_ACTS);
        for (let i = 0; i < N_ACTS; i++) r[i] = arr[i] == null ? 0 : arr[i];
        Q.set(k, r); loaded++;
    }
    console.log(`Warm-start: loaded ${loaded} states from q-table-aggregator.json`);
} else if (existsSync(SEED_PATH)) {
    console.log('q-table-aggregator.json not found — seeding from q-table-strategist-mcts.json...');
    const saved = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
    const data  = saved.table ?? saved;
    let loaded  = 0;
    for (const [k, arr] of Object.entries(data)) {
        const r = new Float64Array(N_ACTS);
        for (let i = 0; i < N_ACTS; i++) r[i] = arr[i] == null ? 0 : arr[i];
        Q.set(k, r); loaded++;
    }
    console.log(`Seeded ${loaded} states from q-table-strategist-mcts.json`);
} else {
    console.log('No seed table found — starting fresh.');
}

// ---- Headless Q-Strategist opponents --------------------------------
class HeadlessQStrat {
    constructor(path, name) {
        this.table = null;
        if (existsSync(path)) {
            const saved = JSON.parse(readFileSync(path, 'utf8'));
            this.table = saved.table ?? saved;
            console.log(`${name} opponent loaded (${Object.keys(this.table).length} states)`);
        } else {
            console.warn(`${name} table not found — will use heuristic fallback`);
        }
    }

    chooseMove(state) {
        const moves = getPossibleMoves(state);
        const key   = encodeState(state, 0);
        const lActs = legalActs(moves);

        if (!this.table) return fastHeuristic(state);
        const qrow = this.table[key];
        if (!qrow) return fastHeuristic(state);

        let best = lActs[0], bv = -Infinity;
        for (const a of lActs) {
            const v = qrow[a] ?? 0;
            if (v > bv) { bv = v; best = a; }
        }
        return actToMove(moves, best) ?? fastHeuristic(state);
    }
}

const qstratOpp     = new HeadlessQStrat(QSTRAT_PATH, 'Q-Strategist');
const qstratPureOpp = new HeadlessQStrat(QSTRAT_PURE_PATH, 'Q-Strategist-Pure');
const qstratMCTSOpp = new HeadlessQStrat(QSTRAT_MCTS_PATH, 'Q-Strategist-MCTS');

// ---- HeuristicBot opponent -----------------------------------------
const heuristicBot = new HeuristicBot();
function heuristicChooseMove(state) {
    return heuristicBot.chooseMove(state);
}

// ---- Strategist2Bot opponent ----------------------------------------
const strategist2Bot = new Strategist2Bot();
function strategist2ChooseMove(state) {
    return strategist2Bot.chooseMove(state);
}

// ---- Fast heuristic fallback ----------------------------------------
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

// ---- Opponent selection ---------------------------------------------
function selectOpponent() {
    if (PURE_MODE) return PURE_MODE;
    const r = Math.random();
    if (r < 0.20) return 'qstrat';
    if (r < 0.40) return 'qstratpure';
    if (r < 0.60) return 'qstratmcts';
    if (r < 0.80) return 'strategist';
    return 'strategist2';
}

// ---- Urgency + shaping reward ---------------------------------------
function stepReward(prev, move, next, botTurnCount, totalMoves) {
    let r = 0;
    const baseUrgency = 1 + Math.floor(totalMoves / 35);
    r -= botTurnCount * 0.018 * baseUrgency;

    if (!(move & DRAW_FLAG)) {
        const played = pop(move & 0xFFFFFF);
        r += 0.015 * played;
    }

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
function playGame(eps, oppType) {
    let s = createInitialState(2);

    const hist      = [];
    let totalMoves  = 0;
    const turnCount = [0, 0];

    while (!isGameOver(s) && totalMoves < STEP_LIMIT) {
        const p     = s.currentPlayer;
        const moves = getPossibleMoves(s);
        const lActs = legalActs(moves);
        totalMoves++;
        turnCount[p]++;

        if (p !== BOT) {
            let conc;
            switch (oppType) {
                case 'qstrat':
                    conc = qstratOpp.chooseMove(s);
                    break;
                case 'qstratpure':
                    conc = qstratPureOpp.chooseMove(s);
                    break;
                case 'qstratmcts':
                    conc = qstratMCTSOpp.chooseMove(s);
                    break;
                case 'strategist':
                    conc = heuristicChooseMove(s);
                    break;
                case 'strategist2':
                    conc = strategist2ChooseMove(s);
                    break;
                default:
                    conc = fastHeuristic(s);
            }
            s = applyMove(s, conc);
            continue;
        }

        // ---- BOT's turn --------------------------------------------
        const key  = encodeState(s, BOT);
        const act  = pickAction(key, lActs, eps);
        const conc = actToMove(moves, act) ?? moves[0];

        qRow(key);
        hist.push({ key, act, lActs, prev: s, move: conc });
        s = applyMove(s, conc);
    }

    const timedOut = !isGameOver(s);
    const winner   = timedOut ? -1 : (getResult(s, BOT) > 0 ? BOT : 1 - BOT);

    // ---- Retrospective Q-update ----------------------------------
    let termR;
    if (winner === BOT) {
        termR = WIN_R;
    } else if (timedOut) {
        const total = pop(s.hands[0]) + pop(s.hands[1]);
        const diff  = total > 0 ? (pop(s.hands[1 - BOT]) - pop(s.hands[BOT])) / total : 0;
        termR = -30.0 + 5.0 * diff;
    } else {
        termR = LOSE_R;
    }

    for (let i = 0; i < hist.length; i++) {
        const { key, act, lActs: curLActs, prev, move } = hist[i];
        const stepR = stepReward(prev, move, s, turnCount[BOT], totalMoves);
        if (i < hist.length - 1) {
            const { key: nKey, lActs: nActs } = hist[i + 1];
            updateQ(key, act, stepR, nKey, nActs);
        } else {
            updateQ(key, act, stepR + termR, null, []);
        }
    }

    return { winner, totalMoves, oppType };
}

// ---- Serialise ------------------------------------------------------
function serialise() {
    const out = {};
    for (const [k, r] of Q)
        out[k] = Array.from(r).map(v => isFinite(v) ? +v.toFixed(5) : null);
    return out;
}

// ---- Main loop ------------------------------------------------------
console.log(`\nQ-Strategist-Aggregator Trainer ${TEST_MODE ? '(EVALUATION MODE)' : ''}`);
if (PURE_MODE) {
    console.log(`PURE MODE: 100% vs ${PURE_MODE}`);
} else {
    console.log(`Opponent mix: 20% Q-Strategist | 20% Q-Strategist-Pure | 20% Q-Strategist-MCTS | 20% Strategist | 20% Strategist2`);
}
if (DURATION_H > 0) {
    console.log(`Duration: ${DURATION_H}h  |  ε: ${EPS_START}→${EPS_MIN}  |  α=${ALPHA}  |  γ=${GAMMA}`);
} else {
    console.log(`Games: ${GAMES.toLocaleString()}  |  ε: ${EPS_START}→${EPS_MIN}  |  α=${ALPHA}  |  γ=${GAMMA}`);
}
if (TEST_MODE) console.log(`Test mode: no learning`);
else           console.log(`Training mode`);
console.log(`Output: ${OUT_PATH}\n`);

// Per-profile counters for test mode
const profCounters = {};
['qstrat','qstratpure','qstratmcts','strategist','strategist2'].forEach(p => {
    profCounters[p] = { n: 0, wins: 0, loss: 0, to: 0 };
});

let logMoves = 0, logN = 0, logNewStatesSnap = 0;
let logWins = 0, logLoss = 0, logTO = 0;

let g = 0;
while (g < GAMES && Date.now() < END_TIME) {
    g++;
    const elapsedFrac = DURATION_H > 0
        ? Math.min(1, (Date.now() - (END_TIME - DURATION_H * 3600_000)) / (DURATION_H * 3600_000))
        : (g - 1) / (GAMES - 1 || 1);
    const eps = EPS_MIN + (EPS_START - EPS_MIN) * Math.pow(1 - elapsedFrac, 2);
    const oppType = PURE_MODE ?? selectOpponent();

    const { winner, totalMoves } = playGame(eps, oppType);
    const botWon = winner === BOT;
    const to     = winner === -1;

    logMoves += totalMoves;
    logN++;
    if      (to)     logTO++;
    else if (botWon) logWins++;
    else             logLoss++;

    const pc = profCounters[oppType];
    pc.n++;
    if      (to)     pc.to++;
    else if (botWon) pc.wins++;
    else             pc.loss++;

    if (!TEST_MODE && g % SAVE_EVERY === 0) {
        const snap = JSON.stringify({ games: g, stateCount: Q.size, table: serialise() });
        writeFileSync(OUT_PATH, snap);
        process.stdout.write(`  [saved g${g}: ${Q.size} states]\n`);
    }

    if (g % LOG_EVERY === 0 || (TEST_MODE && g % Math.max(1, Math.floor(GAMES / 10)) === 0)) {
        const pct = (n, d) => d > 0 ? (n / d * 100).toFixed(1).padStart(5) + '%' : '  n/a';
        const newSt = totalNewStates - logNewStatesSnap;
        console.log(
            `  game ${String(g).padStart(6)}  ε=${eps.toFixed(3)}` +
            `  avgMoves=${(logMoves / logN).toFixed(1).padStart(5)}` +
            `  +states=${newSt.toString().padStart(5)}  total=${Q.size}  Qups=${logQUpdates}`
        );
        console.log(
            `    Overall(${logN}): win=${pct(logWins,logN)}  loss=${pct(logLoss,logN)}  TO=${pct(logTO,logN)}`
        );
        for (const [name, c] of Object.entries(profCounters)) {
            if (c.n > 0) console.log(
                `    vs ${name.padEnd(14)} (${String(c.n).padStart(4)}): win=${pct(c.wins,c.n)}` +
                `  loss=${pct(c.loss,c.n)}  TO=${pct(c.to,c.n)}`
            );
        }

        logMoves=0; logN=0; logWins=0; logLoss=0; logTO=0;
        logQUpdates=0;
        logNewStatesSnap = totalNewStates;
    }
}

// Final summary
console.log(`\n=== Final Summary (${g} games) ===`);
const totalWins = profCounters.qstrat.wins + profCounters.qstratpure.wins + profCounters.qstratmcts.wins + profCounters.strategist.wins + profCounters.strategist2.wins;
const totalLoss = profCounters.qstrat.loss + profCounters.qstratpure.loss + profCounters.qstratmcts.loss + profCounters.strategist.loss + profCounters.strategist2.loss;
const totalTO   = profCounters.qstrat.to + profCounters.qstratpure.to + profCounters.qstratmcts.to + profCounters.strategist.to + profCounters.strategist2.to;
const totalN    = totalWins + totalLoss + totalTO;
console.log(`  Overall win : ${totalWins}  (${(totalWins/totalN*100).toFixed(1)}%)`);
console.log(`  Overall loss: ${totalLoss}  (${(totalLoss/totalN*100).toFixed(1)}%)`);
if (totalTO) console.log(`  Overall TO  : ${totalTO}    (${(totalTO/totalN*100).toFixed(1)}%)`);

for (const [name, c] of Object.entries(profCounters)) {
    if (c.n > 0) {
        console.log(`  vs ${name.padEnd(14)}: ${c.n} games  win=${(c.wins/c.n*100).toFixed(1)}%  loss=${(c.loss/c.n*100).toFixed(1)}%${c.to ? '  TO='+((c.to/c.n*100).toFixed(1))+'%' : ''}`);
    }
}

if (!TEST_MODE) {
    writeFileSync(OUT_PATH, JSON.stringify({ games: g, stateCount: Q.size, table: serialise() }));
    console.log(`\nSaved → ${OUT_PATH}  (${Q.size} states, +${totalNewStates} new)`);
}
