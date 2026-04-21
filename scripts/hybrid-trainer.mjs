// ================================================================
// scripts/hybrid-trainer.mjs
// Hybrid MCTS-Q Self-Play Trainer — Nine of Hearts
//
// Both bots share one Q-table (hive-mind) and play each other.
// Move-selection per turn:
//   Opening  (first 5 bot-turns each)  → Shark MCTS 500 iters
//   Endgame  (virtual count ≤ 4)       → Shark MCTS 500 iters
//   Mid-game (state known in Q-table)  → Q-table ε-greedy
//   Mid-game (state unknown)           → MCTS 30-iter fallback
//   Ace Safety Lock                    → lone Ace blocked, force draw
//
// Game history from ALL phases is collected; Q updated retrospectively
// so the table learns from MCTS expert decisions too.
//
// Usage: node scripts/hybrid-trainer.mjs [--games N] [--epsilon N] [--vs-heuristic N]
//   --games N          total games to run (default 5000)
//   --epsilon N        fixed exploration rate 0-1 (overrides built-in schedule)
//   --vs-heuristic N   % of games played vs balanced heuristic (default 0)
// ================================================================

import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { ISMCTSEngine } from '../ai-engine.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dir      = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(__dir, '..', 'q-table.json');

// ---- CLI / config ---------------------------------------------------
function getArg(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const GAMES          = parseInt(getArg('--games',        '5000'), 10);
const VS_HEURISTIC   = parseFloat(getArg('--vs-heuristic', '0'));    // 0-100 %
const EPS_FIXED      = parseFloat(getArg('--epsilon', '0.1'));        // fixed epsilon (default 0.1)
const ALPHA_ARG      = getArg('--alpha',        '0.2');              // fixed alpha (default 0.2)
const ALPHA_WARM_ARG = getArg('--alpha-warm',   null);               // higher α for early games
const ALPHA_SWITCH   = parseInt(getArg('--alpha-switch', '2000'), 10); // games to use warm α
const EPS_START_ARG  = getArg('--eps-start',    null);               // enables smooth decay
const PURE_Q         = process.argv.includes('--pure-q');             // skip opening/endgame MCTS for Q-bot
const HYBRID_SELFPLAY = process.argv.includes('--hybrid-selfplay');    // in self-play, p0=hybrid p1=pure-Q
const EVAL_EVERY     = parseInt(getArg('--eval-every', '500'),  10);   // run eval diagnostic every N games
const EVAL_GAMES     = parseInt(getArg('--eval-games', '20'),   10);   // number of eval games per diagnostic
const EVAL_ITERS     = parseInt(getArg('--eval-iters', '100'),  10);   // MCTS iters for hybrid side in eval
const SAVE_EVERY = 50;
const LOG_EVERY  = 100;

// ---- Hyper-parameters -----------------------------------------------
const ALPHA      = parseFloat(ALPHA_ARG);
const ALPHA_WARM = ALPHA_WARM_ARG !== null ? parseFloat(ALPHA_WARM_ARG) : ALPHA;
const GAMMA      = 0.997;
const EPS_START  = EPS_START_ARG !== null ? parseFloat(EPS_START_ARG) : null; // smooth decay (optional)
const EPS_MIN    = parseFloat(getArg('--eps-min', '0.05'));                    // decay floor

const OPENING_MOVES       = 5;     // first N bot-turns per player → MCTS
const MCTS_MAIN_ITERS     = 800;
const MCTS_FALLBACK_ITERS = 10;   // Q-miss fallback: shark-10 — fast but rational
const GAME_STEP_LIMIT     = 2000;  // hard cap on total moves per game

const WIN_R  =  50.0;
const LOSE_R = -50.0;

// ---- MCTS training profiles -----------------------------------------
// useCardTracking / useTreeReuse disabled: headless training knows all
// cards and doesn't persist state between turns.
const MCTS_MAIN_PROF = {
    ...ISMCTSEngine.PROFILES.shark,
    maxIterations:   MCTS_MAIN_ITERS,
    maxTime:         5000,
    useTreeReuse:    false,
    useCardTracking: false,
};
const MCTS_FALLBACK_PROF = {
    ...ISMCTSEngine.PROFILES.shark,   // shark UCB params, 10 iters
    maxIterations:   MCTS_FALLBACK_ITERS,
    maxTime:         500,
    useTreeReuse:    false,
    useCardTracking: false,
};

const MCTS_EVAL_PROF = {
    ...ISMCTSEngine.PROFILES.shark,
    maxIterations:   EVAL_ITERS,
    maxTime:         2000,
    useTreeReuse:    false,
    useCardTracking: false,
};

// One engine pair per player seat
const mctsMain     = [new ISMCTSEngine(MCTS_MAIN_PROF),     new ISMCTSEngine(MCTS_MAIN_PROF)];
const mctsFallback = [new ISMCTSEngine(MCTS_FALLBACK_PROF), new ISMCTSEngine(MCTS_FALLBACK_PROF)];
const mctsEval     = new ISMCTSEngine(MCTS_EVAL_PROF);   // hybrid side in eval (player 0)

// ---- Balanced heuristic opponent ------------------------------------
// Ported from q-tournament.mjs — used when --vs-heuristic > 0.
function heuristicBalanced(s) {
    const P        = s.currentPlayer;
    const myHand   = s.hands[P];
    const myCount  = pop(myHand);
    const oppCount = pop(s.hands[1 - P]);
    const moves    = getPossibleMoves(s);
    const plays    = moves.filter(m => !(m & DRAW_FLAG));
    if (plays.length === 0) return moves[0];
    const danger     = oppCount < 3;
    const hasLastA   = pop(myHand & RM[5]) === 1;
    const hasLastK   = pop(myHand & RM[4]) === 1;
    const preserveAK = !danger && myCount >= 4;
    const rankOf     = m => (31 - Math.clz32(m & 0xFFFFFF)) >> 2;
    const isQuad     = m => pop(m & 0xFFFFFF) === 4;
    const wouldWin   = m => pop(myHand & ~(m & 0xFFFFFF)) === 0;
    plays.sort((a, b) => rankOf(a) - rankOf(b));
    let opts = [...plays];
    if (preserveAK) {
        const filtered = opts.filter(m => {
            if (wouldWin(m)) return true;
            const rk = rankOf(m);
            if (hasLastA && rk === 5) return false;
            if (hasLastK && rk === 4) return false;
            return true;
        });
        if (filtered.length > 0) opts = filtered;
    }
    const quad = opts.find(m => isQuad(m));
    if (quad) {
        let minRank = 6;
        for (let rk = 0; rk <= 5; rk++) { if (myHand & RM[rk]) { minRank = rk; break; } }
        if (rankOf(quad) === minRank) return quad;
    }
    if (myCount > 4) {
        const singles = opts.filter(m => pop(m & 0xFFFFFF) === 1);
        if (singles.length > 0) return singles[0];
    }
    return opts[0];
}

// ---- Bit helpers ----------------------------------------------------
const RM = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];

function pop(x) {
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    return (Math.imul((x + (x >>> 4)) & 0x0F0F0F, 0x010101) >>> 16) & 0xFF;
}

// ---- Virtual card count (mirrors ai-engine.js _virtualCount) --------
function virtualCount(hand) {
    let c = pop(hand);
    const aces = pop(hand & RM[5]);
    if (aces > 0) c -= (aces - 1);           // any Aces → count as 1
    for (let r = 3; r <= 4; r++)             // quad Q or K → subtract 3
        if (pop(hand & RM[r]) === 4) c -= 3;
    return c;
}

// ---- Ace Safety Lock ------------------------------------------------
function isAceBlocked(move, hand) {
    if (move & DRAW_FLAG) return false;
    if (pop(hand & RM[5]) !== 1) return false;  // not exactly 1 Ace
    if (pop(hand) <= 2)          return false;  // endgame exception
    return (move & RM[5]) !== 0;                // move involves an Ace
}

// Returns moves with lone-Ace plays removed; preserves draws and all
// other play moves.  Falls back to full list if nothing remains.
function filterMoves(rawMoves, hand) {
    if (pop(hand & RM[5]) !== 1 || pop(hand) <= 2) return rawMoves;
    const safe = rawMoves.filter(m => (m & DRAW_FLAG) || (m & RM[5]) === 0);
    return safe.length > 0 ? safe : rawMoves;
}

// ---- State encoding (from player pid's perspective) -----------------
// V2: exact hand sizes (0-12) and exact ace count replace the old coarse
// hdist/bkt buckets — dramatically expands the reachable state space.
function pClass(rk) { return rk <= 1 ? 0 : rk <= 3 ? 1 : 2; }
function bkt(n)     { return n >= 3 ? 3 : n; }
function pdepth(ps) { const d = ps - 1; return d <= 0 ? 0 : d <= 2 ? 1 : 2; }

function encodeState(s, pid) {
    const h   = s.hands[pid];
    const oh  = s.hands[1 - pid];
    const p2  = s.pileSize >= 2 ? pClass(s.pile[s.pileSize - 2] >> 2) : 3;
    const p3  = s.pileSize >= 3 ? pClass(s.pile[s.pileSize - 3] >> 2) : 3;
    const myH = Math.min(pop(h),  12);   // exact card count, capped at 12
    const opH = Math.min(pop(oh), 12);
    const myA = pop(h & RM[5]);           // exact ace count, 0-4
    return `${s.topRankIdx}|${p2}|${p3}` +
           `|${bkt(pop(h  & (RM[0]|RM[1])))}|${bkt(pop(h  & (RM[2]|RM[3])))}` +
           `|${myA}|${myH}|${opH}|${pdepth(s.pileSize)}|${bkt(pop(oh & (RM[4]|RM[5])))}`;
}

// ---- Action indices -------------------------------------------------
const ACT_QUAD = 6, ACT_DRAW = 7, N_ACTS = 8;

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

// ---- Q-table (hive-mind: shared by both players) --------------------
const Q = new Map();

let totalStatesAdded = 0;   // diagnostic: new states discovered this run

function row(key) {
    let r = Q.get(key);
    if (!r) { r = new Float64Array(N_ACTS).fill(0); Q.set(key, r); totalStatesAdded++; }
    return r;
}

function pickAction(key, lActs, eps) {
    if (Math.random() < eps) return lActs[(Math.random() * lActs.length) | 0];
    const r = row(key);
    let best = lActs[0], bv = -Infinity;
    for (const a of lActs) { if (r[a] > bv) { bv = r[a]; best = a; } }
    return best;
}

let logQUpdates = 0;   // diagnostic: Q-value writes per log interval

function updateQ(key, act, reward, nextKey, nextLActs, alpha) {
    const qrow = row(key);
    const cur  = isFinite(qrow[act]) ? qrow[act] : 0;
    let maxNext = 0;
    if (nextKey && nextLActs.length > 0) {
        const nr = row(nextKey);
        maxNext = -Infinity;
        for (const a of nextLActs) { if (nr[a] > maxNext) maxNext = nr[a]; }
        if (maxNext === -Infinity) maxNext = 0;
    }
    qrow[act] = cur + alpha * (reward + GAMMA * maxNext - cur);
    logQUpdates++;
}

// ---- Warm-start: load existing table --------------------------------
const WARM_START = existsSync(TABLE_PATH);
if (WARM_START) {
    const saved = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
    const data  = saved.table ?? saved;
    for (const [k, arr] of Object.entries(data)) {
        const r = new Float64Array(N_ACTS);
        for (let i = 0; i < N_ACTS; i++) r[i] = arr[i] == null ? Infinity : arr[i];
        Q.set(k, r);
    }
    console.log(`Warm-start: loaded ${Q.size} states from q-table.json`);
}

// ---- Step reward — terminal + turn-penalty only ---------------------
// All intermediate shaping (shedding, draw, block bonuses) removed.
// The Q-table learns purely from Win/Loss outcomes guided by MCTS.
function stepReward(_prev, _move, _next, _pid) {
    return 0;   // only turn penalty (applied at call site) + terminal rewards
}

// ---- Play one game, collect full history, update Q ------------------
// vsHeuristic: player 0 uses balanced heuristic; player 1 uses hybrid Q/MCTS.
// Q is still updated for BOTH players so heuristic trajectories teach the table.
// Returns: { winner (-1=timeout, 0 or 1), starter (0 or 1), totalMoves }
function playGame(eps, alpha, vsHeuristic = false) {
    let s = createInitialState(2);
    const starter    = s.currentPlayer;   // player holding 9♥ goes first
    const turnCount  = [0, 0];            // bot-turns per player
    const hist       = [[], []];          // [{key, act, stepR, lActs}]
    let   totalMoves = 0;

    while (!isGameOver(s) && totalMoves < GAME_STEP_LIMIT) {
        const p    = s.currentPlayer;
        const hand = s.hands[p];
        const rawMoves = getPossibleMoves(s);
        const moves    = filterMoves(rawMoves, hand);
        totalMoves++;
        turnCount[p]++;

        // Phase detection (omniscient in headless training)
        const myVC      = virtualCount(hand);
        const oppVC     = virtualCount(s.hands[1 - p]);
        const isOpening = turnCount[p] <= OPENING_MOVES;
        const isEndgame = myVC <= 4 || oppVC <= 4;

        const key   = encodeState(s, p);
        const lActs = legalActs(moves);
        let conc, act;

        if (vsHeuristic && p === 0) {
            // ── Heuristic opponent (player 0 only) ───────────────────
            conc = heuristicBalanced(s);
            act  = moveToAct(conc);

        } else if ((isOpening || isEndgame) && (!PURE_Q || (HYBRID_SELFPLAY && !vsHeuristic && p === 0))) {
            // ── MCTS phase: always if !pure-q; or p0 self-play if --hybrid-selfplay ──
            conc = mctsMain[p].chooseMove(s, MCTS_MAIN_PROF);
            mctsMain[p].cleanup();
            if (isAceBlocked(conc, hand))
                conc = rawMoves.find(m => m & DRAW_FLAG) ?? moves[0];
            act = moveToAct(conc);

        } else if (!Q.has(key)) {
            // ── Unknown state: MCTS fallback (20 iters) ─────────────
            conc = mctsFallback[p].chooseMove(s, MCTS_FALLBACK_PROF);
            mctsFallback[p].cleanup();
            if (isAceBlocked(conc, hand))
                conc = rawMoves.find(m => m & DRAW_FLAG) ?? moves[0];
            act = moveToAct(conc);

        } else {
            // ── Mid-game: Q-table ε-greedy ───────────────────────────
            act  = pickAction(key, lActs, eps);
            conc = actToMove(moves, act) ?? moves[0];
        }

        const ns   = applyMove(s, conc);
        const tPen = -(turnCount[p] * 0.005);   // escalating turn penalty (scaled for ±50 terminal)
        row(key);                                // pre-register state immediately
        hist[p].push({ key, act, stepR: stepReward(s, conc, ns, p) + tPen, lActs, alpha });
        s = ns;
    }

    const timedOut = !isGameOver(s);
    const winner   = timedOut ? -1 : (getResult(s, 0) > 0 ? 0 : 1);

    // ---- Retrospective Q-update for both players --------------------
    for (let p = 0; p < 2; p++) {
        const h = hist[p];
        if (h.length === 0) continue;

        // Terminal reward for this player
        let termR;
        if (winner === p) {
            termR = WIN_R;
        } else if (timedOut) {
            const total = pop(s.hands[0]) + pop(s.hands[1]);
            const raw   = total > 0 ? 1.5 * (pop(s.hands[1-p]) - pop(s.hands[p])) / total : 0;
            termR = Math.min(0, raw);   // timeout: only penalise, never reward
        } else {
            termR = LOSE_R;
        }

        // Walk forward; each step bootstraps from the next same-player state
        for (let i = 0; i < h.length; i++) {
            const { key, act, stepR, lActs, alpha } = h[i];
            if (i < h.length - 1) {
                const { key: nKey, lActs: nActs } = h[i + 1];
                updateQ(key, act, stepR, nKey, nActs, alpha);
            } else {
                updateQ(key, act, stepR + termR, null, [], alpha);
            }
        }
    }

    return { winner, starter, totalMoves };
}

// ---- Eval: pure Q-bot (p1, ε=0) vs hybrid (p0, MCTS-eval + Q-table) ----
// No Q updates — read-only diagnostic.
function runEval(n) {
    let qWins = 0, hybridWins = 0, tos = 0;
    for (let i = 0; i < n; i++) {
        let s = createInitialState(2);
        const tc = [0, 0];
        let moves_done = 0;
        while (!isGameOver(s) && moves_done < GAME_STEP_LIMIT) {
            const p    = s.currentPlayer;
            const hand = s.hands[p];
            const raw  = getPossibleMoves(s);
            const mvs  = filterMoves(raw, hand);
            moves_done++; tc[p]++;
            const myVC  = virtualCount(hand);
            const oppVC = virtualCount(s.hands[1 - p]);
            const isOp  = tc[p] <= OPENING_MOVES;
            const isEG  = myVC <= 4 || oppVC <= 4;
            const key   = encodeState(s, p);
            const lActs = legalActs(mvs);
            let conc;
            const greedyQ = () => {
                const r = row(key);
                let best = lActs[0], bv = -Infinity;
                for (const a of lActs) { const v = isFinite(r[a]) ? r[a] : 0; if (v > bv) { bv = v; best = a; } }
                return actToMove(mvs, best) ?? mvs[0];
            };
            if (p === 0) {
                // Hybrid: MCTS for opening/endgame, Q-table mid-game, fallback on miss
                if (isOp || isEG) {
                    conc = mctsEval.chooseMove(s, MCTS_EVAL_PROF);
                    mctsEval.cleanup();
                    if (isAceBlocked(conc, hand)) conc = raw.find(m => m & DRAW_FLAG) ?? mvs[0];
                } else if (Q.has(key)) {
                    conc = greedyQ();
                } else {
                    conc = mctsFallback[0].chooseMove(s, MCTS_FALLBACK_PROF);
                    mctsFallback[0].cleanup();
                    if (isAceBlocked(conc, hand)) conc = raw.find(m => m & DRAW_FLAG) ?? mvs[0];
                }
            } else {
                // Pure Q-bot: Q-table only, fallback on miss, ε=0
                if (Q.has(key)) {
                    conc = greedyQ();
                } else {
                    conc = mctsFallback[1].chooseMove(s, MCTS_FALLBACK_PROF);
                    mctsFallback[1].cleanup();
                    if (isAceBlocked(conc, hand)) conc = raw.find(m => m & DRAW_FLAG) ?? mvs[0];
                }
            }
            s = applyMove(s, conc);
        }
        if      (!isGameOver(s))       tos++;
        else if (getResult(s, 1) > 0)  qWins++;
        else                           hybridWins++;
    }
    return { qWins, hybridWins, tos, n };
}

// ---- Serialise ------------------------------------------------------
function serialise() {
    const out = {};
    for (const [k, r] of Q)
        out[k] = Array.from(r).map(v => isFinite(v) ? +v.toFixed(5) : null);
    return out;
}

// ---- Main loop ------------------------------------------------------
console.log(`\nHybrid MCTS-Q Self-Play Trainer  |  ${WARM_START ? 'WARM' : 'FRESH'} start`);
const epsDesc = EPS_START !== null ? `ε: ${EPS_START} → ${EPS_MIN} (smooth decay over ${GAMES} games)`
              : `ε=${EPS_FIXED} (fixed)`;
const alphaDesc = ALPHA_WARM !== ALPHA ? `α: ${ALPHA_WARM} (games 1-${ALPHA_SWITCH}) → ${ALPHA}` : `α=${ALPHA} (fixed)`;
console.log(`Games: ${GAMES.toLocaleString()}  |  ${epsDesc}  |  vs-heuristic: ${VS_HEURISTIC}%`);
console.log(`${alphaDesc}  |  Win/Loss=±${WIN_R}  |  turn-penalty=0.005/turn`);
const mctsDesc = !PURE_Q
    ? `MCTS: opening/endgame=${MCTS_MAIN_ITERS} iters  |  fallback=${MCTS_FALLBACK_ITERS} iters`
    : HYBRID_SELFPLAY
    ? `MCTS: p0-selfplay=${MCTS_MAIN_ITERS} iters (hybrid)  |  p1=pure-Q  |  Q-miss fallback: shark-${MCTS_FALLBACK_ITERS}`
    : `MCTS: opening/endgame=DISABLED (--pure-q)  |  Q-miss fallback: shark-${MCTS_FALLBACK_ITERS}`;
console.log(mctsDesc);
console.log(`Save every ${SAVE_EVERY} games  |  Output: ${TABLE_PATH}\n`);

let logSelfP0W=0, logSelfP1W=0, logTO=0, logMoves=0, logN=0, logNewStatesSnap=0;
let logHeurGames=0, logHeurBotW=0, logHeurHeurW=0, logHeurTO=0;

for (let g = 1; g <= GAMES; g++) {
    const eps       = EPS_START !== null ? EPS_START * Math.pow(EPS_MIN / EPS_START, (g - 1) / (GAMES - 1))
                    : EPS_FIXED;
    const curAlpha  = (ALPHA_WARM !== ALPHA && g <= ALPHA_SWITCH) ? ALPHA_WARM : ALPHA;
    const isHeuristicGame = VS_HEURISTIC > 0 && Math.random() * 100 < VS_HEURISTIC;
    const { winner, starter, totalMoves } = playGame(eps, curAlpha, isHeuristicGame);

    logMoves += totalMoves;
    logN++;
    if (isHeuristicGame) {
        // player 0 = heuristic, player 1 = Q/MCTS bot
        logHeurGames++;
        if      (winner === -1) logHeurTO++;
        else if (winner === 1)  logHeurBotW++;   // Q-bot won
        else                    logHeurHeurW++;  // heuristic won
    } else {
        if      (winner === -1)  logTO++;
        else if (winner === 0)   logSelfP0W++;   // hybrid when --hybrid-selfplay
        else                     logSelfP1W++;   // pure-Q when --hybrid-selfplay
    }

    if (g % SAVE_EVERY === 0) {
        const snap = JSON.stringify({ games: g, stateCount: Q.size, table: serialise() });
        writeFileSync(TABLE_PATH, snap);
        process.stdout.write(`  [saved g${g}: ${Q.size} states, ${snap.length} bytes]\n`);
    }

    if (g % LOG_EVERY === 0) {
        const selfN  = logN - logHeurGames;
        const pct    = (n, d) => d > 0 ? (n / d * 100).toFixed(1).padStart(5) + '%' : '  n/a';
        const newSt  = totalStatesAdded - logNewStatesSnap;
        let line = `  game ${String(g).padStart(6)}  ε=${eps.toFixed(2)}` +
            `  avgMoves=${(logMoves/logN).toFixed(1).padStart(6)}` +
            `  +states=${newSt}  total=${Q.size}  Qups=${logQUpdates}`;
        if (selfN > 0) {
            const sp = HYBRID_SELFPLAY
                ? `hybrid(p0)=${pct(logSelfP0W,selfN)}  pure-Q(p1)=${pct(logSelfP1W,selfN)}  TO=${pct(logTO,selfN)}`
                : `p0=${pct(logSelfP0W,selfN)}  p1=${pct(logSelfP1W,selfN)}  TO=${pct(logTO,selfN)}`;
            line += `\n    self-play(${selfN}): ${sp}`;
        }
        if (logHeurGames > 0)
            line += `\n    vs-heuristic(${logHeurGames}): Q-bot=${pct(logHeurBotW,logHeurGames)}  heuristic=${pct(logHeurHeurW,logHeurGames)}  TO=${pct(logHeurTO,logHeurGames)}`;
        console.log(line);
        logSelfP0W=0; logSelfP1W=0; logTO=0; logMoves=0; logN=0; logQUpdates=0;
        logHeurGames=0; logHeurBotW=0; logHeurHeurW=0; logHeurTO=0;
        logNewStatesSnap = totalStatesAdded;

        if (EVAL_GAMES > 0 && g % EVAL_EVERY === 0) {
            const ev = runEval(EVAL_GAMES);
            const qPct = (ev.qWins / ev.n * 100).toFixed(1);
            const hPct = (ev.hybridWins / ev.n * 100).toFixed(1);
            console.log(`    [EVAL pure-Q vs hybrid-${EVAL_ITERS}] Q-bot=${ev.qWins}/${ev.n} (${qPct}%)  hybrid=${ev.hybridWins} (${hPct}%)  TO=${ev.tos}`);
        }
    }
}

writeFileSync(TABLE_PATH, JSON.stringify(
    { games: GAMES, stateCount: Q.size, table: serialise() }
));
console.log(`\nDone. ${Q.size} states discovered  →  q-table.json`);
