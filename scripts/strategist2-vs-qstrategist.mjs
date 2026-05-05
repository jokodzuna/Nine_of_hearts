// scripts/strategist2-vs-qstrategist.mjs
// Benchmark Strategist2Bot (P0) vs Q-Strategist Pure (P1)
// Usage:  node scripts/strategist2-vs-qstrategist.mjs [games]

globalThis.window = globalThis.window || { AI_DEBUG: false };

import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { Strategist2Bot } from '../strategist2-bot.js';
import { readFileSync }  from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dir   = dirname(fileURLToPath(import.meta.url));
const N_GAMES = parseInt(process.argv.find(a => /^\d+$/.test(a)) ?? '1000', 10);
const BOT     = 1;  // Q-strategist is always player 1

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

const TABLE_PATH = join(__dir, '..', 'q-table-strategist-pure.json');
let QTABLE = null;
try {
    const saved = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
    QTABLE = saved.table ?? saved;
    console.log(`Loaded Q-table: ${Object.keys(QTABLE).length} states`);
} catch (e) {
    console.warn('Could not load q-table — Q-strategist will pick first move');
}

function qbotMove(s) {
    const moves = getPossibleMoves(s);
    if (!QTABLE) return moves[0];
    const key   = encodeState(s, BOT);
    const qrow  = QTABLE[key];
    const legal = [...new Set(moves.map(moveToAct))];
    let best = legal[0], bv = -Infinity;
    for (const a of legal) {
        const v = qrow ? (qrow[a] ?? -Infinity) : -Infinity;
        if (v > bv) { bv = v; best = a; }
    }
    return actToMove(moves, best) ?? moves[0];
}

const s2bot = new Strategist2Bot();
let s2Wins = 0, qWins = 0, draws = 0;
const STEP_LIMIT = 10000;

console.log(`\nStrategist2Bot (P0) vs Q-Strategist Pure (P1)   n=${N_GAMES}\n`);

for (let g = 1; g <= N_GAMES; g++) {
    s2bot.resetKnowledge?.();
    let s = createInitialState(2);

    for (let step = 0; step < STEP_LIMIT; step++) {
        if (isGameOver(s)) break;
        let move;
        if (s.currentPlayer === BOT) {
            move = qbotMove(s);
        } else {
            move = s2bot.chooseMove(s);
        }
        s2bot.observeMove?.(s, move);
        s = applyMove(s, move);
    }

    if (!isGameOver(s))               draws++;
    else if (getResult(s, BOT) > 0)   qWins++;
    else                               s2Wins++;

    if (g % 50 === 0) {
        const qPct  = (qWins  / g * 100).toFixed(1);
        const s2Pct = (s2Wins / g * 100).toFixed(1);
        process.stdout.write(`  game ${String(g).padStart(4)}  Q-Strat: ${qWins}  Strat2: ${s2Wins}  Q-win%: ${qPct}%  S2-win%: ${s2Pct}%\n`);
    }
}

console.log(`\n=== Final (${N_GAMES} games) ===`);
console.log(`  Q-Strategist Pure wins : ${qWins}  (${(qWins /N_GAMES*100).toFixed(1)}%)`);
console.log(`  Strategist2Bot wins    : ${s2Wins}  (${(s2Wins/N_GAMES*100).toFixed(1)}%)`);
if (draws) console.log(`  Draws                  : ${draws}`);
