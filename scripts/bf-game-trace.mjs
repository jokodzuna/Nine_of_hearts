// scripts/bf-game-trace.mjs
// Runs Q-strategist-botfather (P0/black) vs BotfatherBot (P1/red).
// Outputs full per-turn logs matching the game-controller.js format.
//
// Usage:  node scripts/bf-game-trace.mjs [--games N]
//   e.g.  node scripts/bf-game-trace.mjs          ← 1 game
//         node scripts/bf-game-trace.mjs --games 3 ← 3 games

globalThis.window = globalThis.window || { AI_DEBUG: true };
console.log = (...args) => _p(...args);  // route BotfatherBot debug to trace output

import { createBotfatherState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { BotfatherBot } from '../strategist2-botfather.js';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const _p = (...a) => process.stdout.write(a.join(' ') + '\n');

const __dir    = dirname(fileURLToPath(import.meta.url));
const TBL_PATH = join(__dir, '..', 'q-table-strategist-botfather.json');

function getArg(flag, fb) { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i+1] ? process.argv[i+1] : fb; }
const N_GAMES = parseInt(getArg('--games', '1'), 10);

// ---- Load Q-table ---------------------------------------------------
let QTABLE = null;
if (existsSync(TBL_PATH)) {
    const saved = JSON.parse(readFileSync(TBL_PATH, 'utf8'));
    QTABLE = saved.table ?? saved;
    _p(`Loaded Q-table: ${Object.keys(QTABLE).length} states\n`);
} else {
    _p(`WARNING: ${TBL_PATH} not found — Q-bot will pick first legal move\n`);
}

// ---- Card display helpers (direct bit-iteration, no bitmaskToCards) -----
const RANKS = ['9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['♠', '♥', '♦', '♣'];
function cardStr(bit) { return RANKS[bit >> 2] + SUITS[bit & 3]; }
function handStr(bm)  {
    const cards = [];
    for (let bit = 0; bit < 24; bit++) if ((bm >>> bit) & 1) cards.push(cardStr(bit));
    return cards.join(' ');
}
function moveDesc(move) {
    if (move & DRAW_FLAG) return `DRAW ${(move & 3) + 1}`;
    const bits = move & 0xFFFFFF;
    const cards = [];
    for (let bit = 0; bit < 24; bit++) if ((bits >>> bit) & 1) cards.push(cardStr(bit));
    return 'PLAY ' + cards.join(' ');
}
function topStr(s) {
    return s.pileSize > 0 ? cardStr(s.pile[s.pileSize - 1]) : '?';
}

// ---- Q-bot helpers (BOT=0, same as trainer) -------------------------
const RM = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];
function pop(x) { x=x-((x>>>1)&0x555555);x=(x&0x333333)+((x>>>2)&0x333333);return(Math.imul((x+(x>>>4))&0x0F0F0F,0x010101)>>>16)&0xFF; }
function pClass(rk) { return rk<=1?0:rk<=3?1:2; }
function bkt(n) { return n>=3?3:n; }
function pdepth(ps) { const d=ps-1; return d<=0?0:d<=2?1:2; }
function moveToAct(m) {
    if (m & DRAW_FLAG) return 7;
    const b = m & 0xFFFFFF;
    if (pop(b) >= 3) return 6;
    return (31 - Math.clz32(b)) >> 2;
}
function actToMove(moves, act) {
    if (act === 7) { for (const m of moves) if (m & DRAW_FLAG) return m; return null; }
    if (act === 6) { for (const m of moves) if (!(m & DRAW_FLAG) && pop(m & 0xFFFFFF) >= 3) return m; return null; }
    for (const m of moves) { if (m & DRAW_FLAG) continue; if (((31-Math.clz32(m&0xFFFFFF))>>2)===act) return m; }
    return null;
}
function encodeState(s, pid) {
    const h=s.hands[pid], oh=s.hands[1-pid];
    const p2=s.pileSize>=2?pClass(s.pile[s.pileSize-2]>>2):3;
    const p3=s.pileSize>=3?pClass(s.pile[s.pileSize-3]>>2):3;
    return `${s.topRankIdx}|${p2}|${p3}` +
           `|${bkt(pop(h&(RM[0]|RM[1])))}|${bkt(pop(h&(RM[2]|RM[3])))}` +
           `|${pop(h&RM[5])}|${Math.min(pop(h),12)}|${Math.min(pop(oh),12)}` +
           `|${pdepth(s.pileSize)}|${bkt(pop(oh&(RM[4]|RM[5])))}`;
}
const Q_SEAT = 0;
function qMove(s) {
    const moves = getPossibleMoves(s);
    if (!QTABLE) return moves[0];
    const key  = encodeState(s, Q_SEAT);
    const qrow = QTABLE[key];
    const legal = [...new Set(moves.map(moveToAct))];
    let best = legal[0], bv = -Infinity;
    for (const a of legal) { const v = qrow ? (qrow[a] ?? -Infinity) : -Infinity; if (v > bv) { bv = v; best = a; } }
    return actToMove(moves, best) ?? moves[0];
}


// ---- Game loop -------------------------------------------------------
const bfBot = new BotfatherBot();
let qWins = 0, bfWins = 0, timeouts = 0;

for (let g = 1; g <= N_GAMES; g++) {
    bfBot.resetKnowledge?.();
    let s = createBotfatherState();
    let step = 0;

    _p(`${'─'.repeat(60)}`);
    _p(`Game ${g}  |  P0 (Q-bot): ${pop(s.hands[0])} cards  P1 (BotfatherBot): ${pop(s.hands[1])} cards  pile: ${s.pileSize}`);
    _p(`  P0 hand: ${handStr(s.hands[0])}`);
    _p(`  P1 hand: ${handStr(s.hands[1])}`);
    _p(`  Pile top: ${topStr(s)}`);
    _p('');

    while (!isGameOver(s) && step < 150) {
        const p     = s.currentPlayer;
        const isQ   = p === Q_SEAT;
        const top   = topStr(s);
        const label = isQ ? 'P0 (Q-bot)     ' : 'P1 (BotfatherBot)';

        _p(`[${String(step).padStart(3)}] [${label}] turn — top: ${top} | pile: ${s.pileSize}`);
        _p(`  ${p === 0 ? '▶' : ' '} P0: ${handStr(s.hands[0])}`);
        _p(`  ${p === 1 ? '▶' : ' '} P1: ${handStr(s.hands[1])}`);

        const move = isQ ? qMove(s) : bfBot.chooseMove(s);
        bfBot.observeMove?.(s, move);
        _p(`  → ${moveDesc(move)}`);
        _p('');

        s = applyMove(s, move);
        step++;
    }

    if (!isGameOver(s)) {
        timeouts++;
        _p(`⏱  Step limit reached — no winner (counted as BotfatherBot win)`);
        bfWins++;
    } else if (getResult(s, Q_SEAT) > 0) {
        qWins++;
        _p(`🏆  P0 (Q-bot) wins!  (${step} turns)`);
    } else {
        bfWins++;
        _p(`💀  P1 (BotfatherBot) wins!  (${step} turns)`);
    }
    _p('');
}

if (N_GAMES > 1) {
    _p(`${'═'.repeat(60)}`);
    _p(`Summary: ${N_GAMES} games`);
    _p(`  Q-bot wins      : ${qWins}  (${(qWins  / N_GAMES * 100).toFixed(1)}%)`);
    _p(`  BotfatherBot wins: ${bfWins}  (${(bfWins / N_GAMES * 100).toFixed(1)}%) [incl. ${timeouts} timeouts]`);
}
