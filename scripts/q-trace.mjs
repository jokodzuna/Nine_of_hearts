// One-game trace: see exactly what Q-bot and MCTS are doing
import { createBotfatherState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG, decodeMove, bitmaskToCards } from '../game-logic.js';
import { ISMCTSEngine } from '../ai-engine.js';
import { readFileSync }  from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const { table: QTABLE } = JSON.parse(readFileSync(join(__dir, '..', 'q-table.json'), 'utf8'));

const BOT = 1;
const RM  = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];
function pop(x) { x=x-((x>>>1)&0x555555);x=(x&0x333333)+((x>>>2)&0x333333);return(Math.imul((x+(x>>>4))&0x0F0F0F,0x010101)>>>16)&0xFF; }
const pClass=rk=>rk<=1?0:rk<=3?1:2, bkt=n=>n>=3?3:n, dst=n=>n<=1?0:n===2?1:2;
function encodeState(s){const h=s.hands[BOT],oh=s.hands[1-BOT],p2=s.pileSize>=2?pClass(s.pile[s.pileSize-2]>>2):3,p3=s.pileSize>=3?pClass(s.pile[s.pileSize-3]>>2):3;return`${s.topRankIdx}|${p2}|${p3}|${bkt(pop(h&(RM[0]|RM[1])))}|${bkt(pop(h&(RM[2]|RM[3])))}|${bkt(pop(h&(RM[4]|RM[5])))}|${dst(pop(h))}|${dst(pop(oh))}`;}
function moveToAct(m){if(m&DRAW_FLAG)return 7;const b=m&0xFFFFFF;if(pop(b)>=3)return 6;return(31-Math.clz32(b))>>2;}
function actToMove(moves,act){if(act===7){for(const m of moves)if(m&DRAW_FLAG)return m;return null;}if(act===6){for(const m of moves)if(!(m&DRAW_FLAG)&&pop(m&0xFFFFFF)>=3)return m;return null;}for(const m of moves){if(m&DRAW_FLAG)continue;const b=m&0xFFFFFF;if(pop(b)===1&&((31-Math.clz32(b))>>2)===act)return m;}return null;}
const ACT=['9','10','J','Q','K','A','QUAD','DRAW'];
function qbotMove(s){const moves=getPossibleMoves(s),key=encodeState(s),qrow=QTABLE[key],legal=[...new Set(moves.map(moveToAct))];let best=legal[0],bv=-Infinity;for(const a of legal){const v=qrow?(qrow[a]??Infinity):Infinity;if(v>bv){bv=v;best=a;}}return{move:actToMove(moves,best)??moves[0],act:ACT[best],qrow:qrow?legal.map(a=>`${ACT[a]}=${qrow[a]?.toFixed(3)??'∞'}`).join(' '):null};}

const FAST = { ...ISMCTSEngine.PROFILES.shark, maxIterations: 200, maxTime: 50 };
const mcts = new ISMCTSEngine('shark');
let s = createBotfatherState();

const RANKS = ['9','10','J','Q','K','A'];
function handStr(bm) { return bitmaskToCards(bm).map(c=>RANKS[c>>2]+'♥♦♠♣'[c&3]).join(' '); }

console.log(`\nP0 (MCTS): ${handStr(s.hands[0])}  [${pop(s.hands[0])} cards]`);
console.log(`P1 (QBot): ${handStr(s.hands[1])}  [${pop(s.hands[1])} cards]\n`);

for (let step = 0; step < 60; step++) {
    if (isGameOver(s)) break;

    const pileTop = RANKS[s.topRankIdx];
    const p = s.currentPlayer;

    if (p === BOT) {
        const { move, act, qrow } = qbotMove(s);
        const dm = decodeMove(move);
        console.log(`[${String(step).padStart(3)}] P1-QBot  top=${pileTop}  hand=${pop(s.hands[1])}  → ${dm.type==='draw'?`DRAW×${dm.count}`:`PLAY ${dm.cards.map(c=>RANKS[c>>2]+'♥♦♠♣'[c&3]).join(',')}`}   bestAct=${act}  ${qrow??'(fallback)'}`);
        mcts.observeMove(s, move);
        mcts.advanceTree(move);
        s = applyMove(s, move);
        mcts.cleanup();
    } else {
        const move = mcts.chooseMove(s, FAST);
        const dm   = decodeMove(move);
        console.log(`[${String(step).padStart(3)}] P0-MCTS  top=${pileTop}  hand=${pop(s.hands[0])}  → ${dm.type==='draw'?`DRAW×${dm.count}`:`PLAY ${dm.cards.map(c=>RANKS[c>>2]+'♥♦♠♣'[c&3]).join(',')}`}`);
        mcts.observeMove(s, move);
        mcts.advanceTree(move);
        s = applyMove(s, move);
        mcts.cleanup();
    }
}

console.log(`\nFinal: P0=${pop(s.hands[0])} cards  P1=${pop(s.hands[1])} cards  pileSize=${s.pileSize}`);
console.log(isGameOver(s) ? `Game over. Result P1: ${getResult(s,BOT)}` : 'Step limit reached (no winner yet)');
