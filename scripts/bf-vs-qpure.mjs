// scripts/bf-vs-qpure.mjs
// Benchmark BotfatherBot (P1, red cards) vs Q-strategist-botfather (P0, black cards).
// Uses createBotfatherState() — fixed deal matching real game conditions.
// Q-table was trained as BOT=0 (P0/black) — must use Q_SEAT=0 or all lookups miss.
//
// Usage:  node scripts/bf-vs-qpure.mjs [games]
//   e.g.  node scripts/bf-vs-qpure.mjs 1000

globalThis.window = globalThis.window || { AI_DEBUG: false };

// Silence per-move debug logs from both bots during the game loop.
// We use process.stdout.write for all our own output.
console.log = () => {};

import { createBotfatherState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { BotfatherBot }  from '../strategist2-botfather.js';
import { readFileSync }  from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dir   = dirname(fileURLToPath(import.meta.url));
const N_GAMES = parseInt(process.argv.find(a => /^\d+$/.test(a)) ?? '1000', 10);

// Q-botfather table was trained as BOT=0 (P0/black) — Q-bot MUST be P0 or all lookups miss.
// BotfatherBot takes P1 (red cards) — matching the real game setup.
const BF_SEAT = 1;
const Q_SEAT  = 0;

const RM = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];
function pop(x) {
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    return (Math.imul((x + (x >>> 4)) & 0x0F0F0F, 0x010101) >>> 16) & 0xFF;
}
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

const TABLE_PATH = join(__dir, '..', 'q-table-strategist-botfather.json');
let QTABLE = null;
try {
    const saved = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
    QTABLE = saved.table ?? saved;
    process.stdout.write(`Loaded Q-table: ${Object.keys(QTABLE).length} states\n`);
} catch (e) {
    process.stdout.write('Could not load q-table — Q-strategist will pick first move\n');
}

function qbotMove(s) {
    const moves = getPossibleMoves(s);
    if (!QTABLE) return moves[0];
    const key   = encodeState(s, Q_SEAT);  // Q_SEAT=1 matches training
    const qrow  = QTABLE[key];
    const legal = [...new Set(moves.map(moveToAct))];
    let best = legal[0], bv = -Infinity;
    for (const a of legal) {
        const v = qrow ? (qrow[a] ?? -Infinity) : -Infinity;
        if (v > bv) { bv = v; best = a; }
    }
    return actToMove(moves, best) ?? moves[0];
}

const bfBot = new BotfatherBot();
let bfWins = 0, qWins = 0, ties = 0;
// Q-pure must finish the game within 150 turns — matching botfather's 2-min human timer.
// If the game isn't decided by then, BotfatherBot wins by timeout.
const STEP_LIMIT = 150;
const LOG_EVERY  = 100;

process.stdout.write(`\nBotfatherBot (P1/red) vs Q-strategist-botfather (P0/black)   n=${N_GAMES}\n\n`);

for (let g = 1; g <= N_GAMES; g++) {
    bfBot.resetKnowledge?.();
    let s = createBotfatherState();

    for (let step = 0; step < STEP_LIMIT; step++) {
        if (isGameOver(s)) break;
        let move;
        if (s.currentPlayer === BF_SEAT) {
            move = bfBot.chooseMove(s);
        } else {
            move = qbotMove(s);
        }
        bfBot.observeMove?.(s, move);
        s = applyMove(s, move);
    }

    if (!isGameOver(s))                   bfWins++;  // Q-pure timeout → BF wins
    else if (getResult(s, BF_SEAT) > 0)  bfWins++;
    else                                  qWins++;

    if (g % LOG_EVERY === 0) {
        const bfPct = (bfWins / g * 100).toFixed(1);
        const qPct  = (qWins  / g * 100).toFixed(1);
        process.stdout.write(
            `  game ${String(g).padStart(5)}` +
            `  BF: ${String(bfWins).padStart(4)} (${bfPct}%)` +
            `  Q-pure: ${String(qWins).padStart(4)} (${qPct}%)\n`
        );
    }
}

process.stdout.write(`\n=== Final (${N_GAMES} games, 150-turn limit) ===\n`);
process.stdout.write(`  BotfatherBot      wins : ${bfWins}  (${(bfWins / N_GAMES * 100).toFixed(1)}%)\n`);
process.stdout.write(`  Q-Strategist Pure wins : ${qWins}  (${(qWins  / N_GAMES * 100).toFixed(1)}%)\n`);
