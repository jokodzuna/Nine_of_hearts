// scripts/q-vs-mcts.mjs
// Runs automated games: Q-bot (player 1) vs MCTS (player 0)
// Usage:  node scripts/q-vs-mcts.mjs [games] [mcts-profile] [maxIterations]
// Profiles: newbie | gambler | shark   (default: shark)
// maxIterations overrides the profile's iteration cap (default 200 for speed)

import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { ISMCTSEngine } from '../ai-engine.js';
import { readFileSync }  from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dir    = dirname(fileURLToPath(import.meta.url));
const N_GAMES   = parseInt(process.argv[2] ?? '200', 10);
const PROFILE   = process.argv[3] ?? 'shark';
const MAX_ITERS = parseInt(process.argv[4] ?? '200', 10);  // cap per move for speed
// Build a fast test profile: use the named profile's params but cap iterations & time
const BASE_PROF  = ISMCTSEngine.PROFILES[PROFILE] ?? ISMCTSEngine.PROFILES.shark;
const TEST_PROF  = { ...BASE_PROF, maxIterations: MAX_ITERS, maxTime: 100 };

// ---- Load Q-table ---------------------------------------------------
const TABLE_PATH = join(__dir, '..', 'q-table.json');
const { table: QTABLE } = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));

// ---- Q-bot helpers (mirrors q-bot.js exactly) -----------------------
const BOT = 1;
const RM  = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];

function pop(x) {
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    return (Math.imul((x + (x >>> 4)) & 0x0F0F0F, 0x010101) >>> 16) & 0xFF;
}

const pClass  = rk => rk <= 1 ? 0 : rk <= 3 ? 1 : 2;
const bkt     = n  => n >= 3 ? 3 : n;
const hdist   = n  => n <= 1 ? 0 : n === 2 ? 1 : n <= 4 ? 2 : n <= 8 ? 3 : 4;
const pdepth  = ps => { const d = ps - 1; return d <= 0 ? 0 : d <= 2 ? 1 : 2; };

function encodeState(s) {
    const h  = s.hands[BOT], oh = s.hands[1 - BOT];
    const p2 = s.pileSize >= 2 ? pClass(s.pile[s.pileSize - 2] >> 2) : 3;
    const p3 = s.pileSize >= 3 ? pClass(s.pile[s.pileSize - 3] >> 2) : 3;
    return `${s.topRankIdx}|${p2}|${p3}|${bkt(pop(h&(RM[0]|RM[1])))}|${bkt(pop(h&(RM[2]|RM[3])))}|${bkt(pop(h&(RM[4]|RM[5])))}|${hdist(pop(h))}|${hdist(pop(oh))}|${pdepth(s.pileSize)}|${bkt(pop(oh&(RM[4]|RM[5])))}`;
}

function moveToAct(m) {
    if (m & DRAW_FLAG) return 7;
    const bits = m & 0xFFFFFF;
    if (pop(bits) >= 3) return 6;
    return (31 - Math.clz32(bits)) >> 2;
}

function actToMove(moves, act) {
    if (act === 7) { for (const m of moves) if  (m & DRAW_FLAG) return m; return null; }
    if (act === 6) { for (const m of moves) if (!(m & DRAW_FLAG) && pop(m & 0xFFFFFF) >= 3) return m; return null; }
    for (const m of moves) {
        if (m & DRAW_FLAG) continue;
        const bits = m & 0xFFFFFF;
        if (pop(bits) === 1 && ((31 - Math.clz32(bits)) >> 2) === act) return m;
    }
    return null;
}

function qbotMove(s) {
    const moves = getPossibleMoves(s);
    const key   = encodeState(s);
    const qrow  = QTABLE[key];
    const legal = [...new Set(moves.map(moveToAct))];
    let best = legal[0], bv = -Infinity;
    for (const a of legal) {
        const v = qrow ? (qrow[a] ?? Infinity) : Infinity;
        if (v > bv) { bv = v; best = a; }
    }
    return actToMove(moves, best) ?? moves[0];
}

// ---- Main loop ------------------------------------------------------
const mcts = new ISMCTSEngine(PROFILE);

let qWins = 0, mWins = 0, draws = 0;
const STEP_LIMIT = 10000;

console.log(`\nQ-bot (P1) vs MCTS-${PROFILE} (P0, ${MAX_ITERS} iters/move)   n=${N_GAMES}\n`);

for (let g = 1; g <= N_GAMES; g++) {
    mcts.resetKnowledge();
    let s = createInitialState(2);

    for (let step = 0; step < STEP_LIMIT; step++) {
        if (isGameOver(s)) break;

        let move;
        if (s.currentPlayer === BOT) {
            move = qbotMove(s);
        } else {
            move = mcts.chooseMove(s, TEST_PROF);
        }

        mcts.observeMove(s, move);
        mcts.advanceTree(move);
        s = applyMove(s, move);
        mcts.cleanup();
    }

    if (!isGameOver(s))          draws++;   // step limit hit
    else if (getResult(s, BOT) > 0) qWins++;
    else                            mWins++;

    if (g % 20 === 0) {
        const pct = (qWins / g * 100).toFixed(1);
        process.stdout.write(`  game ${String(g).padStart(4)}  Q-bot: ${qWins}  MCTS: ${mWins}  Q-win%: ${pct}%\n`);
    }
}

console.log(`\n=== Final (${N_GAMES} games vs MCTS-${PROFILE}) ===`);
console.log(`  Q-bot wins : ${qWins}  (${(qWins/N_GAMES*100).toFixed(1)}%)`);
console.log(`  MCTS wins  : ${mWins}  (${(mWins/N_GAMES*100).toFixed(1)}%)`);
if (draws) console.log(`  Draws      : ${draws}`);
