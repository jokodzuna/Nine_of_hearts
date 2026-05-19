// Stub window for headless MCTS
globalThis.window = globalThis.window || { AI_DEBUG: false };

// ================================================================
// scripts/q-sentient-2p-boost-trainer.mjs
// Dense 2P training for the unified Q-table.
// Reads |2 states from q-table-sentient-unified.json, trains 2P games,
// writes all states (4P/3P unchanged + updated |2) back to the same file.
// q-table-aggregator.json is NEVER touched.
//
// Flags:
//   --games N          number of games (default: 50000 train / 1000 test)
//   --log-every N      report interval (default: 500)
//   --epsilon N        start epsilon (default: 0.15 train / 0.0 test)
//   --test             evaluation mode (no learning, ε=0)
//   --sentient-pct N   fraction of games vs SentientBot (default: 0.6)
//   --pure [sentient|newbie|s2]   100% vs one opponent type
// ================================================================

import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { ISMCTSEngine } from '../ai-engine.js';
import { SentientBot } from '../sentient-bot.js';
import { Strategist2Bot } from '../strategist2-bot.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir       = dirname(fileURLToPath(import.meta.url));
const UNIFIED_PATH = join(__dir, '..', 'q-table-sentient-unified.json');

// ---- CLI -----------------------------------------------------------
function getArg(flag, fb){ const i=process.argv.indexOf(flag); return i!==-1&&process.argv[i+1]?process.argv[i+1]:fb; }
const TEST_MODE    = process.argv.includes('--test');
const GAMES        = parseInt(getArg('--games',    TEST_MODE?'1000':'50000'), 10);
const EPS_START    = parseFloat(getArg('--epsilon', TEST_MODE?'0.0':'0.15'));
const EPS_MIN      = TEST_MODE ? 0.0 : 0.03;
const LOG_EVERY    = parseInt(getArg('--log-every', '500'), 10);
const SENTIENT_PCT = parseFloat(getArg('--sentient-pct', '0.6'));
const PURE_IDX     = process.argv.indexOf('--pure');
const PURE_MODE    = PURE_IDX !== -1 && process.argv[PURE_IDX+1] && !process.argv[PURE_IDX+1].startsWith('-')
    ? process.argv[PURE_IDX+1].toLowerCase() : null;

// ---- Hyper-parameters ----------------------------------------------
const ALPHA = 0.20, GAMMA = 0.997;
const WIN_R = 5.0, LOSE_R = -50.0;  // must match R_WIN_2P / R_LOSE_2P in unified trainer
const STEP_LIMIT = 150;
const SAVE_EVERY = 1000;
const BOT = 1;

// ---- Constants -----------------------------------------------------
const ACT_QUAD=6, ACT_DRAW=7, N_ACTS=8;
const RM=[0x00000F,0x0000F0,0x000F00,0x00F000,0x0F0000,0xF00000];

// ---- Bit helpers ---------------------------------------------------
function pop(x){x=x-((x>>>1)&0x555555);x=(x&0x333333)+((x>>>2)&0x333333);return(Math.imul((x+(x>>>4))&0x0F0F0F,0x010101)>>>16)&0xFF;}
function pClass(r){return r<=1?0:r<=3?1:2;}
function bkt(n){return n>=3?3:n;}
function pdepth(ps){const d=ps-1;return d<=0?0:d<=2?1:2;}

// ---- State encoding (identical to aggregator / unified |2 states) --
function encodeState(s, pid){
    const h=s.hands[pid], oh=s.hands[1-pid];
    const p2=s.pileSize>=2?pClass(s.pile[s.pileSize-2]>>2):3;
    const p3=s.pileSize>=3?pClass(s.pile[s.pileSize-3]>>2):3;
    const myH=Math.min(pop(h),12), opH=Math.min(pop(oh),12), myA=pop(h&RM[5]);
    return `${s.topRankIdx}|${p2}|${p3}`+
        `|${bkt(pop(h&(RM[0]|RM[1])))}|${bkt(pop(h&(RM[2]|RM[3])))}|${myA}|${myH}|${opH}`+
        `|${pdepth(s.pileSize)}|${bkt(pop(oh&(RM[4]|RM[5])))}`;
}

// ---- Move / action helpers -----------------------------------------
function moveToAct(m){if(m&DRAW_FLAG)return ACT_DRAW;const b=m&0xFFFFFF;if(pop(b)>=3)return ACT_QUAD;return(31-Math.clz32(b))>>2;}
function actToMove(moves,act){
    if(act===ACT_DRAW){for(const m of moves)if(m&DRAW_FLAG)return m;return null;}
    if(act===ACT_QUAD){for(const m of moves)if(!(m&DRAW_FLAG)&&pop(m&0xFFFFFF)>=3)return m;return null;}
    for(const m of moves){if(m&DRAW_FLAG)continue;const b=m&0xFFFFFF;if(pop(b)===1&&((31-Math.clz32(b))>>2)===act)return m;}
    return null;
}
function legalActs(moves){return[...new Set(moves.map(moveToAct))];}

// ---- Q-table (2P states only, keys WITHOUT |2 suffix internally) ---
const Q = new Map();
let totalNewStates = 0;

function qRow(key){let r=Q.get(key);if(!r){r=new Float64Array(N_ACTS).fill(0);Q.set(key,r);totalNewStates++;}return r;}
function pickAction(key,lActs,eps){
    if(Math.random()<eps)return lActs[(Math.random()*lActs.length)|0];
    const r=qRow(key);let best=lActs[0],bv=-Infinity;
    for(const a of lActs)if(r[a]>bv){bv=r[a];best=a;}
    return best;
}
let logQUpdates=0;
function updateQ(key,act,reward,nextKey,nextLActs){
    if(TEST_MODE)return;
    const r=qRow(key),cur=r[act];let maxNext=0;
    if(nextKey&&nextLActs.length>0){
        const nr=Q.get(nextKey);
        if(nr){maxNext=-Infinity;for(const a of nextLActs)if(nr[a]>maxNext)maxNext=nr[a];if(!isFinite(maxNext))maxNext=0;}
    }
    r[act]=cur+ALPHA*(reward+GAMMA*maxNext-cur);logQUpdates++;
}

// ---- Load unified table — extract |2 states ------------------------
let nonTwoP = {}; // 4P/3P states preserved verbatim
if(existsSync(UNIFIED_PATH)){
    const saved=JSON.parse(readFileSync(UNIFIED_PATH,'utf8').replace(/^\uFEFF/,''));
    const data=saved.table??saved;
    let n2p=0,nother=0;
    for(const[k,arr]of Object.entries(data)){
        if(k.endsWith('|2')){
            const base=k.slice(0,-2);
            const r=new Float64Array(N_ACTS);
            for(let i=0;i<N_ACTS;i++)r[i]=arr[i]==null?0:arr[i];
            Q.set(base,r);n2p++;
        }else{nonTwoP[k]=arr;nother++;}
    }
    console.log(`Loaded ${n2p} 2P states + ${nother} 4P/3P states from unified table`);
}else{
    console.log('Unified table not found — starting fresh.');
}

// ---- Opponents -----------------------------------------------------
const s2Bot = new Strategist2Bot();
const NEWBIE_PROF = {...ISMCTSEngine.PROFILES.newbie, maxIterations:100, maxTime:100};

function selectOpp(){
    if(PURE_MODE==='sentient')return 'sentient';
    if(PURE_MODE==='newbie')  return 'newbie';
    if(PURE_MODE==='s2'||PURE_MODE==='strategist2')return 's2';
    return Math.random()<SENTIENT_PCT?'sentient':'newbie';
}

// ---- Step reward ---------------------------------------------------
function stepReward(move,s,botTurns,total){
    let r=0;r-=botTurns*0.018*(1+Math.floor(total/35));
    if(!(move&DRAW_FLAG))r+=0.015*pop(move&0xFFFFFF);
    const oh=s.hands[1-BOT];
    if(pop(oh)>0){let cp=false;for(let rk=s.topRankIdx;rk<=5;rk++)if(oh&RM[rk]){cp=true;break;}if(!cp)r+=0.06;}
    return r;
}

// ---- Single game ---------------------------------------------------
function playGame(eps, oppType){
    let s=createInitialState(2);
    // Fresh opponent instance per game (SentientBot needs fresh card-tracking state)
    const opp = oppType==='sentient' ? new SentientBot()
              : oppType==='newbie'   ? new ISMCTSEngine('newbie')
              : null; // s2 uses singleton

    const hist=[];let totalMoves=0,botTurns=0;

    while(!isGameOver(s)&&totalMoves<STEP_LIMIT){
        const p=s.currentPlayer,moves=getPossibleMoves(s);totalMoves++;let conc;

        if(p!==BOT){
            if(oppType==='sentient'){
                conc=opp.chooseMove(s);opp.observeMove(s,conc);opp.advanceTree(conc);
            }else if(oppType==='newbie'){
                conc=opp.chooseMove(s,NEWBIE_PROF);opp.observeMove(s,conc);opp.advanceTree(conc);opp.cleanup();
            }else{
                conc=s2Bot.chooseMove(s);
            }
            s=applyMove(s,conc);
            continue;
        }

        // BOT turn
        botTurns++;
        const key=encodeState(s,BOT),lActs=legalActs(moves),act=pickAction(key,lActs,eps);
        conc=actToMove(moves,act)??moves[0];
        // SentientBot/Newbie observes BOT's move for card tracking
        if(oppType==='sentient'){opp.observeMove(s,conc);opp.advanceTree(conc);}
        else if(oppType==='newbie'){opp.observeMove(s,conc);opp.advanceTree(conc);}
        qRow(key);hist.push({key,act,lActs,move:conc});
        s=applyMove(s,conc);
    }

    const timedOut=!isGameOver(s);
    const winner=timedOut?-1:(getResult(s,BOT)>0?BOT:1-BOT);
    let termR;
    if(winner===BOT)termR=WIN_R;
    else if(timedOut){
        termR=-30;  // matches R_TIMEOUT in unified trainer
    }else termR=LOSE_R;

    for(let i=0;i<hist.length;i++){
        const{key,act,lActs:la,move}=hist[i];
        const sr=stepReward(move,s,botTurns,totalMoves);
        if(i<hist.length-1){const{key:nk,lActs:na}=hist[i+1];updateQ(key,act,sr,nk,na);}
        else updateQ(key,act,sr+termR,null,[]);
    }
    return{winner,totalMoves};
}

// ---- Serialise (merge 2P + preserved 4P/3P back into unified format)
function serialise(){
    const out={};
    for(const[k,v]of Object.entries(nonTwoP))out[k]=v; // 4P/3P states unchanged
    for(const[k,r]of Q)out[k+'|2']=Array.from(r).map(v=>isFinite(v)?+v.toFixed(5):null);
    return out;
}

// ---- Main loop -----------------------------------------------------
const oppMixDesc=PURE_MODE?`100% ${PURE_MODE}`
    :`${(SENTIENT_PCT*100).toFixed(0)}% SentientBot + ${((1-SENTIENT_PCT)*100).toFixed(0)}% MCTS Newbie`;
console.log(`\nQ-Sentient 2P Boost Trainer ${TEST_MODE?'(EVALUATION)':''}`);
console.log(`Opponents: ${oppMixDesc}`);
console.log(`Games: ${GAMES.toLocaleString()}  ε: ${EPS_START}→${EPS_MIN}  α=${ALPHA}  γ=${GAMMA}`);
console.log(`Output: ${UNIFIED_PATH}  (2P states only; 4P/3P preserved)\n`);

const CTYPES=['sentient','newbie','s2'];
const cnts=Object.fromEntries(CTYPES.map(k=>[k,{n:0,wins:0,loss:0,to:0}]));
const total=Object.fromEntries(CTYPES.map(k=>[k,{n:0,wins:0,loss:0,to:0}]));
let logN=0,logMoves=0,logNewSnap=0;

for(let g=1;g<=GAMES;g++){
    const frac=(g-1)/(GAMES-1||1),eps=EPS_MIN+(EPS_START-EPS_MIN)*Math.pow(1-frac,2);
    const oppType=selectOpp();
    const{winner,totalMoves}=playGame(eps,oppType);
    const won=winner===BOT,to=winner===-1;
    logN++;logMoves+=totalMoves;
    const c=cnts[oppType];c.n++;if(won)c.wins++;else if(to)c.to++;else c.loss++;
    const t=total[oppType];t.n++;if(won)t.wins++;else if(to)t.to++;else t.loss++;

    if(!TEST_MODE&&g%SAVE_EVERY===0){
        writeFileSync(UNIFIED_PATH,JSON.stringify({games:g,stateCount:Q.size,table:serialise()}));
        process.stdout.write(`  [saved g${g}: ${Q.size} 2P + ${Object.keys(nonTwoP).length} 4P/3P states]\n`);
    }
    if(g%LOG_EVERY===0){
        const pct=(n,d)=>d>0?(n/d*100).toFixed(1).padStart(5)+'%':'  n/a';
        const ns=totalNewStates-logNewSnap;
        console.log(`  game ${String(g).padStart(6)}  ε=${eps.toFixed(3)}  avgMoves=${(logMoves/logN).toFixed(1).padStart(5)}  +states=${ns.toString().padStart(5)}  total=${Q.size}  Qups=${logQUpdates}`);
        for(const t of CTYPES)if(cnts[t].n>0)
            console.log(`    vs ${t.padEnd(10)}(${String(cnts[t].n).padStart(4)}): win=${pct(cnts[t].wins,cnts[t].n)}  loss=${pct(cnts[t].loss,cnts[t].n)}  TO=${pct(cnts[t].to,cnts[t].n)}`);
        logN=0;logMoves=0;logQUpdates=0;logNewSnap=totalNewStates;
        CTYPES.forEach(t=>{cnts[t].n=0;cnts[t].wins=0;cnts[t].loss=0;cnts[t].to=0;});
    }
}

console.log(`\n=== Final Summary (${GAMES} games) ===`);
for(const tn of CTYPES){
    const c=total[tn];if(!c.n)continue;
    const pf=(n)=>(n/c.n*100).toFixed(1);
    console.log(`  vs ${tn}: n=${c.n}  win=${pf(c.wins)}%  loss=${pf(c.loss)}%  TO=${pf(c.to)}%`);
}
if(!TEST_MODE){
    writeFileSync(UNIFIED_PATH,JSON.stringify({games:GAMES,stateCount:Q.size,table:serialise()}));
    console.log(`\nSaved → ${UNIFIED_PATH}  (${Q.size} 2P states + ${Object.keys(nonTwoP).length} 4P/3P states)`);
}
