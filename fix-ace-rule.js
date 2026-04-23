// fix-ace-rule.js — One-shot Q-table correction for the ace-on-nine rule.
//
// Run once from the browser console while the game app is open (so Firebase
// auth is already active):
//
//   import('./fix-ace-rule.js').then(m => m.fixAceRule())
//
// Rule applied:
//   - When the top card is a 9 (topRankIdx = 0), set Q(ace) = -999
//   - Exception: if bot has ONLY aces in hand (myH === aces), leave unchanged

import { getDB } from './multiplayer.js';
import {
    ref, get, update,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';

const FB_QTABLE_PATH = 'q-table-test';
const ACE_ACTION     = 5;      // rank index 5 = Ace
const ACE_ON_NINE_PENALTY = -999;

// State key format (fields split by '|'):
// [0] topRankIdx  [1] p2  [2] p3  [3] low9_10  [4] JQ
// [5] aces  [6] myH  [7] opH  [8] pileDepth  [9] opHighCards

export async function fixAceRule() {
    console.log('[Fix] Loading q-table-test from Firebase…');
    const db   = getDB();
    const snap = await get(ref(db, `${FB_QTABLE_PATH}/table`));
    if (!snap.exists()) {
        console.error('[Fix] q-table-test/table not found — aborting.');
        return;
    }

    const table   = snap.val();
    const updates = {};
    let fixed     = 0;
    let skipped   = 0;
    let already   = 0;

    for (const [key, qrow] of Object.entries(table)) {
        const parts   = key.split('|');
        const topRank = parseInt(parts[0], 10);

        // Only touch states where top card is a 9
        if (topRank !== 0) continue;

        const aces = parseInt(parts[5], 10);
        const myH  = parseInt(parts[6], 10);

        // Exception: bot has nothing but aces — it must play one
        const onlyAces = (myH > 0 && myH === aces);
        if (onlyAces) { skipped++; continue; }

        const currentVal = qrow?.[ACE_ACTION];

        // Skip if already at or below our penalty (avoid double-punishing)
        if (currentVal !== undefined && currentVal <= ACE_ON_NINE_PENALTY) {
            already++;
            continue;
        }

        updates[`${FB_QTABLE_PATH}/table/${key}/${ACE_ACTION}`] = ACE_ON_NINE_PENALTY;
        fixed++;
    }

    console.log(`[Fix] States found where top=9: ${fixed + skipped + already}`);
    console.log(`[Fix]   → Penalising:  ${fixed} states`);
    console.log(`[Fix]   → Skipping (only-aces exception): ${skipped} states`);
    console.log(`[Fix]   → Already penalised: ${already} states`);

    if (fixed === 0) {
        console.log('[Fix] Nothing to update.');
        return;
    }

    console.log(`[Fix] Writing ${Object.keys(updates).length} updates to Firebase…`);
    try {
        await update(ref(db), updates);
        console.log('[Fix] ✓ Done! Ace-on-nine penalty applied successfully.');
    } catch (e) {
        console.error('[Fix] Firebase write FAILED:', e);
    }
}
