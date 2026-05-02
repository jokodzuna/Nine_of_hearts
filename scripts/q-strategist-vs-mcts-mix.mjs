// scripts/q-strategist-vs-mcts-mix.mjs
// Quick benchmark: Q-strategist vs mixed MCTS opponents
// Usage: node scripts/q-strategist-vs-mcts-mix.mjs [games] [tableFile]
//   games: default 1000
//   tableFile: default q-table-strategist.json  (or q-table-strategist-mcts.json)

globalThis.window = globalThis.window || { AI_DEBUG: false };

import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { ISMCTSEngine } from '../ai-engine.js';
import { readFileSync }  from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dir    = dirname(fileURLToPath(import.meta.url));
const N_GAMES   = parseInt(process.argv[2] ?? '1000', 10);
const TABLE_FILE = process.argv[3] ?? 'q-table-strategist.json';

const TABLE_PATH = join(__dir, '..', TABLE_FILE);

// ---- Load Q-strategist table ----------------------------------------
let QTABLE = null;
try {
    const saved = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
    QTABLE = saved.table ?? saved;
    console.log(`Loaded Q-table: ${Object.keys(QTABLE).length} states from ${TABLE_FILE}`);
} catch (e) {
    console.error(`Failed to load ${TABLE_FILE}:`, e.message);
    process.exit(1);
}

// ---- Q-strategist helpers (matches trainer encoding) ---------------
const BOT = 1;
const RM  = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];

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

function qbotMove(s) {
    const moves = getPossibleMoves(s);
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

// ---- Opponent mix ---------------------------------------------------
const PROFILES = {
    mctsAce50: ISMCTSEngine.PROFILES.mctsAce50,
    shark:     ISMCTSEngine.PROFILES.shark,
    gambler:   ISMCTSEngine.PROFILES.gambler,
    newbie:    ISMCTSEngine.PROFILES.newbie,
};

function selectProfile() {
    const r = Math.random();
    if (r < 0.10) return 'mctsAce50';
    if (r < 0.20) return 'shark';
    if (r < 0.50) return 'gambler';
    return 'newbie';
}

// ---- Main loop ------------------------------------------------------
const profCounters = {};
['mctsAce50','shark','gambler','newbie'].forEach(p => {
    profCounters[p] = { n: 0, wins: 0, loss: 0, to: 0 };
});

let qWins = 0, mWins = 0, draws = 0;
const STEP_LIMIT = 10000;

console.log(`\nQ-Strategist (${TABLE_FILE}) vs MCTS mix   n=${N_GAMES}\n`);

for (let g = 1; g <= N_GAMES; g++) {
    const profKey = selectProfile();
    const mcts = new ISMCTSEngine(profKey);
    let s = createInitialState(2);

    for (let step = 0; step < STEP_LIMIT; step++) {
        if (isGameOver(s)) break;

        let move;
        if (s.currentPlayer === BOT) {
            move = qbotMove(s);
        } else {
            move = mcts.chooseMove(s, PROFILES[profKey]);
        }

        mcts.observeMove(s, move);
        mcts.advanceTree(move);
        s = applyMove(s, move);
        mcts.cleanup();
    }

    const pc = profCounters[profKey];
    pc.n++;

    if (!isGameOver(s)) {
        draws++;
        pc.to++;
    } else if (getResult(s, BOT) > 0) {
        qWins++;
        pc.wins++;
    } else {
        mWins++;
        pc.loss++;
    }

    if (g % 50 === 0) {
        const pct = (qWins / g * 100).toFixed(1);
        process.stdout.write(`  game ${String(g).padStart(4)}  Q-Strat: ${qWins}  MCTS: ${mWins}  Draw: ${draws}  Q-win%: ${pct}%\n`);
    }
}

console.log(`\n=== Final (${N_GAMES} games) ===`);
console.log(`  Q-Strategist wins : ${qWins}  (${(qWins/N_GAMES*100).toFixed(1)}%)`);
console.log(`  MCTS wins         : ${mWins}  (${(mWins/N_GAMES*100).toFixed(1)}%)`);
if (draws) console.log(`  Draws             : ${draws}`);

for (const [name, c] of Object.entries(profCounters)) {
    if (c.n > 0) {
        console.log(`  vs ${name.padEnd(12)}: ${c.n} games  win=${(c.wins/c.n*100).toFixed(1)}%  loss=${(c.loss/c.n*100).toFixed(1)}%${c.to ? '  TO='+((c.to/c.n*100).toFixed(1))+'%' : ''}`);
    }
}
