import { ISMCTSEngine }              from './ai-engine.js';
import { getPossibleMoves }           from './game-logic.js';
import { applyNineHeartsGuard,
         applyLowPileDrawGuard,
         applyAntiHumanPressure }     from './bot-guards.js';

// ============================================================
// StrategicBot — ISMCTSEngine('mctsAce50') with hardwired
//               Nine-of-Hearts and low-pile-draw safeguards
// ============================================================

export class StrategicBot {
    constructor() {
        this._engine = new ISMCTSEngine('mctsAce50');
    }

    chooseMove(state) {
        const moves = getPossibleMoves(state);
        let   move  = this._engine.chooseMove(state);
        move = applyNineHeartsGuard(state, move, moves);
        move = applyLowPileDrawGuard(state, move, moves, this._engine);
        move = applyAntiHumanPressure(state, move, moves);
        return move;
    }

    observeMove(state, move) { this._engine.observeMove(state, move); }
    advanceTree(move)        { this._engine.advanceTree(move); }
    resetKnowledge()         { this._engine.resetKnowledge(); }
    cleanup()                { this._engine.cleanup(); }
}
