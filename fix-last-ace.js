// fix-last-ace.js — One-shot Q-table correction: penalise playing the last ace.
//
// Run once from the browser console while the game app is open (authenticated):
//
//   import('./fix-last-ace.js').then(m => m.fixLastAce())
//
// Rule applied:
//   In every state where the bot holds exactly 1 ace (aces = 1) and more than
//   2 cards in total, penalise the ace action by -200.
//
// Exceptions (no penalty applied):
//   myH === 1  → only card in hand is the ace; forced move, cannot penalise.
//   myH === 2  → bot has 2 cards, one of which is the last ace.
//                Playing it leaves 1 card; opponent must draw; bot can finish
//                next turn — this is a legitimate near-win play.
//
// State key format (fields split by '|'):
// [0] topRankIdx  [1] p2  [2] p3  [3] low9_10  [4] JQ
// [5] aces  [6] myH  [7] opH  [8] pileDepth  [9] opHighCards

import { getDB } from './multiplayer.js';
import {
    ref, get, update,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';

const FB_QTABLE_PATH   = 'q-table-test';
const ACE_ACTION       = 5;
const LAST_ACE_PENALTY = -200;

export async function fixLastAce() {
    console.log('[Fix-LastAce] Loading q-table-test from Firebase…');
    const db   = getDB();
    const snap = await get(ref(db, `${FB_QTABLE_PATH}/table`));
    if (!snap.exists()) {
        console.error('[Fix-LastAce] q-table-test/table not found — aborting.');
        return;
    }

    const table   = snap.val();
    const updates = {};
    let fixed     = 0;
    let skipForced  = 0;   // myH === 1 (forced play)
    let skipNearWin = 0;   // myH === 2 (near-win exception)
    let skipNoAce   = 0;   // aces !== 1
    let already     = 0;

    for (const [key, qrow] of Object.entries(table)) {
        const parts = key.split('|');
        const aces  = parseInt(parts[5], 10);
        const myH   = parseInt(parts[6], 10);

        // Only process states where bot holds exactly 1 ace (the last one)
        if (aces !== 1) { skipNoAce++; continue; }

        // Exception: forced move (bot's only card)
        if (myH === 1) { skipForced++; continue; }

        // Exception: near-win — 2 cards total, playing last ace leaves 1 card
        if (myH === 2) { skipNearWin++; continue; }

        // Skip if already at or below our penalty
        const currentVal = qrow?.[ACE_ACTION];
        if (currentVal !== undefined && currentVal <= LAST_ACE_PENALTY) {
            already++;
            continue;
        }

        updates[`${FB_QTABLE_PATH}/table/${key}/${ACE_ACTION}`] = LAST_ACE_PENALTY;
        fixed++;
    }

    console.log(`[Fix-LastAce] States scanned: ${Object.keys(table).length}`);
    console.log(`[Fix-LastAce]   → Penalising (last ace, myH > 2):  ${fixed}`);
    console.log(`[Fix-LastAce]   → Skipping — forced move (myH=1):  ${skipForced}`);
    console.log(`[Fix-LastAce]   → Skipping — near-win (myH=2):     ${skipNearWin}`);
    console.log(`[Fix-LastAce]   → Skipping — already penalised:    ${already}`);
    console.log(`[Fix-LastAce]   → Skipping — aces≠1:               ${skipNoAce}`);

    if (fixed === 0) {
        console.log('[Fix-LastAce] Nothing to update.');
        return;
    }

    console.log(`[Fix-LastAce] Writing ${fixed} updates to Firebase…`);
    try {
        await update(ref(db), updates);
        console.log('[Fix-LastAce] ✓ Done! Last-ace penalty applied.');
    } catch (e) {
        console.error('[Fix-LastAce] Firebase write FAILED:', e);
    }
}
