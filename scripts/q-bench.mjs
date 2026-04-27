// scripts/q-bench.mjs
// Pure Q-bot (ε=0, no MCTS) benchmark against three opponents:
//   1. Balanced heuristic  (from q-tournament.mjs)
//   2. MCTS-shark 50 iters
//   3. MCTS-shark 100 iters
//
// Q-bot is player 1; opponent is player 0.
// Cards are randomly dealt each game.
// Encoding: V2 (exact hand sizes + exact ace count) — must match hybrid-trainer.mjs
//
// Usage: node scripts/q-bench.mjs [games-per-matchup]

import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { ISMCTSEngine } from '../ai-engine.js';
import { readFileSync }  from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dir      = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(__dir, '..', 'q-table.json');
const GAMES      = parseInt(process.argv[2] ?? '100', 10);
const STEP_LIMIT = 2000;
const BOT        = 1;   // Q-bot is always player 1

// ---- Bit helpers ----------------------------------------------------
const RM = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];

function pop(x) {
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    return (Math.imul((x + (x >>> 4)) & 0x0F0F0F, 0x010101) >>> 16) & 0xFF;
}

// ---- V2 encoding — must match hybrid-trainer.mjs exactly ------------
const pClass = rk => rk <= 1 ? 0 : rk <= 3 ? 1 : 2;
const bkt    = n  => n >= 3 ? 3 : n;
const pdepth = ps => { const d = ps - 1; return d <= 0 ? 0 : d <= 2 ? 1 : 2; };

function encodeState(s) {
    const h   = s.hands[BOT];
    const oh  = s.hands[1 - BOT];
    const p2  = s.pileSize >= 2 ? pClass(s.pile[s.pileSize - 2] >> 2) : 3;
    const p3  = s.pileSize >= 3 ? pClass(s.pile[s.pileSize - 3] >> 2) : 3;
    const myH = Math.min(pop(h),  12);
    const opH = Math.min(pop(oh), 12);
    const myA = pop(h & RM[5]);
    return `${s.topRankIdx}|${p2}|${p3}` +
           `|${bkt(pop(h&(RM[0]|RM[1])))}|${bkt(pop(h&(RM[2]|RM[3])))}` +
           `|${myA}|${myH}|${opH}|${pdepth(s.pileSize)}|${bkt(pop(oh&(RM[4]|RM[5])))}`;
}

// ---- Action helpers -------------------------------------------------
const ACT_QUAD = 6, ACT_DRAW = 7;

function moveToAct(m) {
    if (m & DRAW_FLAG) return ACT_DRAW;
    const bits = m & 0xFFFFFF;
    if (pop(bits) >= 3) return ACT_QUAD;
    return (31 - Math.clz32(bits)) >> 2;
}

function actToMove(moves, act) {
    if (act === ACT_DRAW) { for (const m of moves) if (m & DRAW_FLAG) return m; return null; }
    if (act === ACT_QUAD) { for (const m of moves) if (!(m & DRAW_FLAG) && pop(m & 0xFFFFFF) >= 3) return m; return null; }
    for (const m of moves) {
        if (m & DRAW_FLAG) continue;
        const bits = m & 0xFFFFFF;
        if (pop(bits) === 1 && ((31 - Math.clz32(bits)) >> 2) === act) return m;
    }
    return null;
}

// ---- Ace Safety Lock (mirrors hybrid-trainer.mjs) -------------------
function filterMoves(rawMoves, hand) {
    if (pop(hand & RM[5]) !== 1 || pop(hand) <= 2) return rawMoves;
    const safe = rawMoves.filter(m => (m & DRAW_FLAG) || (m & RM[5]) === 0);
    return safe.length > 0 ? safe : rawMoves;
}

// ---- Load Q-table ---------------------------------------------------
const saved  = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
const QTABLE = saved.table ?? saved;
const knownStates = Object.keys(QTABLE).length;

// ---- Pure Q-bot move (ε=0, Q-table only, heuristic if unknown) ------
function qbotMove(s) {
    const raw   = getPossibleMoves(s);
    const moves = filterMoves(raw, s.hands[BOT]);
    const key   = encodeState(s);
    const qrow  = QTABLE[key];
    const legal = [...new Set(moves.map(moveToAct))];

    if (!qrow) {
        // Unknown state: play lowest-rank single card, or draw
        const plays = moves.filter(m => !(m & DRAW_FLAG));
        return plays.length ? plays[0] : moves[0];
    }

    let best = legal[0], bv = -Infinity;
    for (const a of legal) {
        const v = qrow[a] != null ? qrow[a] : 0;
        if (v > bv) { bv = v; best = a; }
    }
    return actToMove(moves, best) ?? moves[0];
}

// ---- Balanced heuristic (ported from q-tournament.mjs) ---------------
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

// ---- Run one matchup ------------------------------------------------
function runMatchup(label, makeEngine, oppFn) {
    let qWins = 0, oWins = 0, timeouts = 0;
    let qMissed = 0;   // states not in Q-table (fallback used)
    const engine = makeEngine ? makeEngine() : null;

    console.log(`\n--- Q-bot vs ${label} (${GAMES} games) ---`);

    for (let g = 1; g <= GAMES; g++) {
        if (engine?.resetKnowledge) engine.resetKnowledge();
        let s = createInitialState(2);
        let steps = 0;

        while (!isGameOver(s) && steps++ < STEP_LIMIT) {
            let move;
            if (s.currentPlayer === BOT) {
                const key = encodeState(s);
                if (!QTABLE[key]) qMissed++;
                move = qbotMove(s);
            } else {
                move = engine ? engine.chooseMove(s) : oppFn(s);
                if (engine) engine.cleanup();
            }
            s = applyMove(s, move);
        }

        if      (!isGameOver(s))        timeouts++;
        else if (getResult(s, BOT) > 0) qWins++;
        else                            oWins++;

        if (g % 25 === 0 || g === GAMES) {
            const w = (qWins / g * 100).toFixed(1).padStart(5);
            process.stdout.write(
                `  game ${String(g).padStart(3)}  Q: ${String(qWins).padStart(3)}` +
                `  Opp: ${String(oWins).padStart(3)}  TO: ${timeouts}  Q-win%: ${w}%\n`
            );
        }
    }

    const winPct = (qWins / GAMES * 100).toFixed(1);
    console.log(`  RESULT  Q-bot ${qWins}/${GAMES} (${winPct}%)  |  Opp ${oWins}  |  Timeouts ${timeouts}  |  Q-misses ${qMissed}`);
    return { qWins, oWins, timeouts, qMissed };
}

// ---- Matchups -------------------------------------------------------
console.log(`\nQ-bot Benchmark  |  Q-table: ${knownStates} states  |  ${GAMES} games per matchup`);
console.log(`Encoding: V2 (exact hand size + exact ace count)  |  ε=0 (pure greedy)\n`);

// 1. Balanced heuristic
const r1 = runMatchup('Balanced Heuristic', null, heuristicBalanced);

// 2. MCTS-shark 50 iters
const p50 = { ...ISMCTSEngine.PROFILES.shark, maxIterations: 50, maxTime: 2000, useTreeReuse: false, useCardTracking: false };
const r2  = runMatchup('MCTS-shark 50 iters', () => new ISMCTSEngine(p50), null);

// 3. MCTS-shark 100 iters
const p100 = { ...ISMCTSEngine.PROFILES.shark, maxIterations: 100, maxTime: 2000, useTreeReuse: false, useCardTracking: false };
const r3   = runMatchup('MCTS-shark 100 iters', () => new ISMCTSEngine(p100), null);

// ---- Summary --------------------------------------------------------
console.log('\n══════════════════════════════════════════════');
console.log('  BENCHMARK SUMMARY  (Q-bot = player 1)');
console.log('══════════════════════════════════════════════');
const row = (label, r) =>
    `  ${label.padEnd(22)} Q-bot: ${String(r.qWins).padStart(3)}/${GAMES}  (${(r.qWins/GAMES*100).toFixed(1).padStart(5)}%)`;
console.log(row('vs Balanced Heuristic', r1));
console.log(row('vs MCTS-shark  50 iter', r2));
console.log(row('vs MCTS-shark 100 iter', r3));
console.log('══════════════════════════════════════════════\n');
