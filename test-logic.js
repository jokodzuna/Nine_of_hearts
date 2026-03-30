// ============================================================
// test-logic.js — Stress Test for game-logic.js
// Nine of Hearts
//
// Run with:  node test-logic.js
// Requires:  Node.js >= 16  (package.json sets "type":"module")
// ============================================================

import {
    createInitialState,
    getPossibleMoves,
    applyMove,
    isGameOver,
    decodeState,
    DRAW_FLAG,
} from './game-logic.js';

// ---- Config ----
const NUM_GAMES  = 100;
const MAX_TURNS  = 100;    // games that exceed this are flagged as STALE
const NUM_PLAYERS = 4;     // change to 2 or 3 to test other modes
const ALL_24_BITS = 0xFFFFFF;   // every card bit set = full 24-card deck

// ---- Inline popcount (matches game-logic.js, avoids import) ----
function popcount(x) {
    x = (x | 0);
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    x = (x + (x >>> 4)) & 0x0F0F0F;
    return Math.imul(x, 0x010101) >>> 16;
}

// ---- Build a bitmask from the pile stack ----
function getPileMask(state) {
    let mask = 0;
    for (let i = 0; i < state.pileSize; i++) {
        mask |= (1 << state.pile[i]);
    }
    return mask;
}

// ---- Integrity check: every card must exist exactly once ----
// Two-condition test:
//   1. OR of all hands + pile == 0xFFFFFF  → no card is missing
//   2. sum of popcounts == 24              → no card is duplicated
// Both must pass; OR alone would silently hide duplicates.
function checkIntegrity(state, gameNum, turn) {
    const pileMask = getPileMask(state);
    let combined   = pileMask;
    let totalCount = popcount(pileMask);

    for (let p = 0; p < state.numPlayers; p++) {
        combined   |= state.hands[p];
        totalCount += popcount(state.hands[p]);
    }

    if (combined !== ALL_24_BITS) {
        console.error(
            `[G${gameNum} T${turn}] INTEGRITY FAIL — combined bitmask: ` +
            `0x${combined.toString(16).padStart(6, '0')} ` +
            `(expected 0xffffff) — a card has gone missing!`
        );
        return false;
    }

    if (totalCount !== 24) {
        console.error(
            `[G${gameNum} T${turn}] INTEGRITY FAIL — card count: ${totalCount} ` +
            `(expected 24) — a card was duplicated or destroyed!`
        );
        return false;
    }

    return true;
}

// ---- Log a stale state in readable form ----
function logStaleState(state, gameNum, turn) {
    console.warn(`\n[G${gameNum}] ⚠️  STALE after ${turn} turns:`);
    const ds = decodeState(state);
    for (let p = 0; p < ds.numPlayers; p++) {
        const status = ds.eliminated[p] ? 'SAFE ' : 'PLAYS';
        const hand   = ds.hands[p].map(c => `${c.rank}${c.suit}`).join(' ') || '(empty)';
        const arrow  = p === ds.currentPlayer ? ' ◄ current' : '';
        console.warn(`  P${p} [${status}]: ${hand}${arrow}`);
    }
    console.warn(`  Top card : ${ds.topCard.rank}${ds.topCard.suit}`);
    console.warn(`  Pile size: ${state.pileSize}  (inc. 9♥ base)`);
}

// ============================================================
// Main simulation loop
// ============================================================

let passed      = 0;
let failedInteg = 0;
let staleCount  = 0;
let noMoveCount = 0;
let totalTurns  = 0;
const loserDist = new Array(NUM_PLAYERS).fill(0);
const moveTypeCounts = { play: 0, draw: 0 };

const t0 = performance.now();

for (let g = 1; g <= NUM_GAMES; g++) {
    let state  = createInitialState(NUM_PLAYERS);
    let turn   = 0;
    let gameOk = true;

    while (!isGameOver(state)) {
        turn++;

        // ---- Integrity check every turn ----
        if (!checkIntegrity(state, g, turn)) {
            failedInteg++;
            gameOk = false;
            break;
        }

        // ---- Stale game detection ----
        if (turn > MAX_TURNS) {
            logStaleState(state, g, turn);
            staleCount++;
            gameOk = false;
            break;
        }

        // ---- Get moves ----
        const moves = getPossibleMoves(state);

        if (moves.length === 0) {
            console.error(
                `[G${g} T${turn}] NO MOVES for player ${state.currentPlayer} ` +
                `— top rank idx: ${state.topRankIdx}, hand: 0x${state.hands[state.currentPlayer].toString(16)}`
            );
            noMoveCount++;
            gameOk = false;
            break;
        }

        // ---- Track move type distribution ----
        const chosenMove = moves[(Math.random() * moves.length) | 0];
        if (chosenMove & DRAW_FLAG) {
            moveTypeCounts.draw++;
        } else {
            moveTypeCounts.play++;
        }

        // ---- Apply random move ----
        state = applyMove(state, chosenMove);
    }

    totalTurns += turn;

    if (gameOk) {
        // Find the loser (only non-eliminated player)
        for (let p = 0; p < NUM_PLAYERS; p++) {
            if (!(state.eliminated & (1 << p))) {
                loserDist[p]++;
                break;
            }
        }
        passed++;
    }
}

const elapsed = performance.now() - t0;

// ============================================================
// Results
// ============================================================

const divider = '─'.repeat(44);

console.log('\n' + divider);
console.log('  Nine of Hearts — Bitmask Stress Test');
console.log(divider);
console.log(`  Config        : ${NUM_PLAYERS} players, ${NUM_GAMES} games, stale limit = ${MAX_TURNS} turns`);
console.log(divider);
console.log(`  ✅ Games passed          : ${passed} / ${NUM_GAMES}`);
console.log(`  ❌ Integrity failures    : ${failedInteg}`);
console.log(`  ⚠️  Stale games (>${MAX_TURNS}t)  : ${staleCount}`);
console.log(`  🚫 No-move errors        : ${noMoveCount}`);
console.log(divider);

const avgTurns = passed > 0 ? (totalTurns / NUM_GAMES).toFixed(1) : 'N/A';
const totalMoves = moveTypeCounts.play + moveTypeCounts.draw;
const drawPct = totalMoves > 0 ? ((moveTypeCounts.draw / totalMoves) * 100).toFixed(1) : '0';

console.log(`  Avg turns / game         : ${avgTurns}`);
console.log(`  Moves — play : draw      : ${moveTypeCounts.play} : ${moveTypeCounts.draw}  (${drawPct}% draws)`);
console.log(divider);

console.log('  Loser distribution (who held last card):');
for (let p = 0; p < NUM_PLAYERS; p++) {
    const count = loserDist[p];
    const pct   = ((count / NUM_GAMES) * 100).toFixed(1);
    const bar   = '█'.repeat(Math.round(count / NUM_GAMES * 30));
    console.log(`    Player ${p}: ${String(count).padStart(3)} games (${pct.padStart(5)}%)  ${bar}`);
}

console.log(divider);
console.log(`  ⏱  Total  : ${elapsed.toFixed(2)} ms`);
console.log(`  ⏱  Per game: ${(elapsed / NUM_GAMES).toFixed(3)} ms`);
console.log(divider + '\n');

// ---- Final verdict ----
if (failedInteg === 0 && staleCount === 0 && noMoveCount === 0 && passed === NUM_GAMES) {
    console.log('  🎉 ALL CHECKS PASSED — 24-bit card math is correct.\n');
} else {
    console.log('  ⚠️  Some checks failed — see errors above.\n');
}
