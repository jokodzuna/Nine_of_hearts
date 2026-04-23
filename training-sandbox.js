// ===== TEST_BLOCK_START — training-sandbox.js (remove for production) =====
// ============================================================
// training-sandbox.js  —  Q-Table Training Sandbox
// Nine of Hearts
//
// Manages in-session Q-value updates, human/bot move histories,
// end-of-game backpropagation, and Firebase batch writes.
// Only active when appState.isTrainingMode === true.
// ============================================================

import { getDB } from './multiplayer.js';
import {
    ref, get, set, update,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';

// ============================================================
// Constants
// ============================================================
const CORRECTION_BONUS   =  200;   // human correction award
const CORRECTION_PENALTY = -200;   // bot penalised for corrected move
const BACKPROP_BASE      =  200;   // base reward for winner's moves
const BACKPROP_GAMMA     =  0.9;   // discount factor per step from terminal
const LOSS_PENALTY       = -20;    // small penalty for loser's moves

const FB_QTABLE_PATH     = 'q-table-test';
const FB_LOGS_PATH       = 'teaching_logs';

// ============================================================
// TrainingSandbox class
// ============================================================
export class TrainingSandbox {
    constructor() {
        /** {stateKey, actionId, turnIndex}[] — bot's played moves this game */
        this.botMoveHistory   = [];
        /** {stateKey, actionId, turnIndex}[] — human's played moves this game */
        this.humanMoveHistory = [];
        /** Delta Q-value buffer: stateKey → { actionId: deltaValue } */
        this._buffer          = {};
        /** Turn counter incremented by recordMove() */
        this._turn            = 0;
        /** Whether q-table-test has been initialised in Firebase */
        this._initialized     = false;
        /** Audit log entries for this game */
        this._auditLog        = [];
        /** Game start timestamp */
        this._gameStartTs     = Date.now();
    }

    // ----------------------------------------------------------
    // Lazy Firebase initialisation
    // ----------------------------------------------------------

    /**
     * Ensure q-table-test/\_initialized exists in Firebase.
     * If not, seed it from q-table.json in the background (non-blocking).
     */
    async ensureInitialized() {
        if (this._initialized) return;
        try {
            const db   = getDB();
            const snap = await get(ref(db, `${FB_QTABLE_PATH}/_initialized`));
            if (!snap.exists() || !snap.val()) {
                // Seed from q-table.json — non-blocking, mark initialized first
                set(ref(db, `${FB_QTABLE_PATH}/_initialized`), true);
                fetch('./q-table.json')
                    .then(r => r.json())
                    .then(data => {
                        const tableRef = ref(db, `${FB_QTABLE_PATH}/table`);
                        return set(tableRef, data.table ?? data);
                    })
                    .catch(e => console.warn('[Sandbox] seed from q-table.json failed:', e));
            }
            this._initialized = true;
        } catch (e) {
            console.warn('[Sandbox] ensureInitialized error:', e);
        }
    }

    /** Reset all per-game state (keeps _initialized flag and Firebase connection). */
    reset() {
        this.botMoveHistory   = [];
        this.humanMoveHistory = [];
        this._buffer          = {};
        this._turn            = 0;
        this._auditLog        = [];
        this._gameStartTs     = Date.now();
    }

    /**
     * Load the test Q-table from Firebase.
     * Returns { stateKey: {actionId: qValue} } or null on failure.
     */
    async loadQTable() {
        try {
            await this.ensureInitialized();
            const db   = getDB();
            const snap = await get(ref(db, `${FB_QTABLE_PATH}/table`));
            return snap.exists() ? snap.val() : {};
        } catch (e) {
            console.warn('[Sandbox] loadQTable error:', e);
            return {};
        }
    }

    // ----------------------------------------------------------
    // Move recording
    // ----------------------------------------------------------

    /** Called by TrainingQBotEngine after each bot move. */
    recordBotMove(stateKey, actionId) {
        this.botMoveHistory.push({ stateKey, actionId, turnIndex: this._turn++ });
    }

    /** Called by game-controller after each human move. */
    recordHumanMove(stateKey, actionId) {
        this.humanMoveHistory.push({ stateKey, actionId, turnIndex: this._turn++ });
    }

    // ----------------------------------------------------------
    // Immediate corrections (Tap-to-Pause)
    // ----------------------------------------------------------

    /**
     * User corrected a bot move: award human's choice, penalise bot's choice.
     * Writes immediately to the buffer.
     */
    applyCorrection(stateKey, humanActionId, botActionId) {
        this._deltaQ(stateKey, humanActionId, CORRECTION_BONUS);
        this._deltaQ(stateKey, botActionId,   CORRECTION_PENALTY);
        this._log({ type: 'correction', stateKey, humanActionId, botActionId });
    }

    /**
     * User approved a bot MCTS move (silent: no tap within window).
     * Applies a small positive reinforcement.
     */
    applyMCTSApproval(stateKey, actionId) {
        this._deltaQ(stateKey, actionId, 10);
    }

    // ----------------------------------------------------------
    // End-of-game backpropagation
    // ----------------------------------------------------------

    /**
     * @param {'bot'|'human'} winner  Who won the game.
     */
    applyBackprop(winner) {
        const winnerHistory = winner === 'bot'   ? this.botMoveHistory   : this.humanMoveHistory;
        const loserHistory  = winner === 'bot'   ? this.humanMoveHistory : this.botMoveHistory;

        const n = winnerHistory.length;
        for (let i = 0; i < n; i++) {
            const { stateKey, actionId } = winnerHistory[i];
            const stepsFromWin = n - 1 - i;
            const reward = BACKPROP_BASE * Math.pow(BACKPROP_GAMMA, stepsFromWin);
            this._deltaQ(stateKey, actionId, reward);
        }

        for (const { stateKey, actionId } of loserHistory) {
            this._deltaQ(stateKey, actionId, LOSS_PENALTY);
        }

        this._log({ type: 'backprop', winner, winnerMoves: n, loserMoves: loserHistory.length });
    }

    // ----------------------------------------------------------
    // Firebase batch flush
    // ----------------------------------------------------------

    /**
     * Flush the session buffer to Firebase q-table-test as a batch update.
     * Call once at game over.
     */
    async flushToFirebase() {
        const db      = getDB();
        const updates = {};
        for (const [key, actions] of Object.entries(this._buffer)) {
            for (const [actionId, delta] of Object.entries(actions)) {
                updates[`${FB_QTABLE_PATH}/table/${key}/${actionId}`] = delta;
            }
        }
        try {
            if (Object.keys(updates).length > 0) await update(ref(db), updates);
        } catch (e) {
            console.warn('[Sandbox] flushToFirebase error:', e);
        }

        // Save audit log
        try {
            const logKey = `game_${this._gameStartTs}`;
            await set(ref(db, `${FB_LOGS_PATH}/${logKey}`), {
                timestamp: this._gameStartTs,
                entries:   this._auditLog,
            });
        } catch (e) {
            console.warn('[Sandbox] audit log write failed:', e);
        }
    }

    /**
     * Save a comment + optional state snapshot to the audit log.
     */
    addComment(text, stateSnapshot = null) {
        this._log({ type: 'comment', text, state: stateSnapshot });
    }

    // ----------------------------------------------------------
    // Private helpers
    // ----------------------------------------------------------

    _deltaQ(stateKey, actionId, delta) {
        if (!this._buffer[stateKey])          this._buffer[stateKey] = {};
        this._buffer[stateKey][actionId] = (this._buffer[stateKey][actionId] ?? 0) + delta;
    }

    _log(entry) {
        this._auditLog.push({ ts: Date.now(), turn: this._turn, ...entry });
    }
}

// Singleton — shared across game-controller and ui-manager
export const sandbox = new TrainingSandbox();
// ===== TEST_BLOCK_END =====
