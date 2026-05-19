globalThis.window = globalThis.window || { AI_DEBUG: false };
// ================================================================
// scripts/q-sentient-unified-trainer.mjs
// Single Q-table covering 4P, 3P, and 2P stages. BOT = player 1.
//
// State key (11 fields):
//   topRank | p2 | p3 | myLow | myMid | myA | myH | oppMin | pdepth | oppMinKA | activeCount
//
//   In 2P (activeCount=2): oppMin / oppMinKA refer to the single opponent.
//   In 3P/4P:              oppMin / oppMinKA refer to the most-dangerous opp
//                          (fewest cards), same as aggregator's opH / oppKA.
//
// Warm-start compatibility with q-table-aggregator.json:
//   Aggregator key = topRank|p2|p3|myLow|myMid|myA|myH|opH|pdepth|oppKA
//   Unified 2P key = same key + "|2"   (append activeCount=2)
//   → aggregator states load directly as warm-start 2P states.
//
// Usage:
//   node scripts/q-sentient-unified-trainer.mjs [--games N] [--log-every N]
//       [--epsilon N] [--test] [--newbie] [--mcts-number N]
//
// Flags:
//   --games N        games to play (default: 10000 train / 1000 test)
//   --log-every N    report interval (default: 500 train / 100 test)
//   --epsilon N      start epsilon (default: 0.20 train / 0.0 test)
//   --test           evaluation mode: no learning, epsilon=0
//   --newbie         replace 1 SentientBot with MCTS Newbie (100 iters)
//   --mcts-number N  replace N SentientBots with MCTS Newbie (1-3)
//   --self-play      simulate actual game: seat 0=MCTS Newbie (human proxy),
//                    seats 2+3 use Q-table greedily (no learning for them)
//
// Report: clear4P% | clear3P% | win2P% | lose2P% | TO%
// Output: q-table-sentient-unified.json
// Seed:   q-table-aggregator.json  (copied as warm start, original untouched)
// ================================================================
import { createInitialState, getPossibleMoves, applyMove, isGameOver, DRAW_FLAG } from '../game-logic.js';
import { ISMCTSEngine } from '../ai-engine.js';
import { SentientBot }  from '../sentient-bot.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir     = dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = join(__dir, '..', 'q-table-sentient-unified.json');
const SEED_PATH = join(__dir, '..', 'q-table-aggregator.json');

function getArg(flag, fb) { const i=process.argv.indexOf(flag); return i!==-1&&process.argv[i+1]!==undefined?process.argv[i+1]:fb; }
const TEST_MODE = process.argv.includes('--test');
const GAMES     = parseInt(getArg('--games',    TEST_MODE?'1000':'10000'),10);
const EPS_START = parseFloat(getArg('--epsilon', TEST_MODE?'0.0':'0.20'));
const EPS_MIN   = TEST_MODE ? 0.0 : 0.03;
const LOG_EVERY = parseInt(getArg('--log-every', TEST_MODE?'100':'500'),10);
const MCTS_NUM   = process.argv.includes('--newbie') ? 1
    : Math.min(3, Math.max(0, parseInt(getArg('--mcts-number','0'),10)));
const SELF_PLAY  = process.argv.includes('--self-play');

const ALPHA=0.20, GAMMA=0.997, SAVE_EVERY=500;
const STEP_LIMIT = SELF_PLAY ? 500 : 300; // self-play needs more room for 4 strategic bots
const BOT=1, N_PLAYERS=4;
const R_CLEAR_4P=12, R_CLEAR_3P=8, R_WIN_2P=5, R_LOSE_2P=-50, R_TIMEOUT=-30, RHV_SCALE=0.08;
const ACT_QUAD=6, ACT_DRAW=7, N_ACTS=8;
const RM=[0x00000F,0x0000F0,0x000F00,0x00F000,0x0F0000,0xF00000];

function pop(x){x=x-((x>>>1)&0x555555);x=(x&0x333333)+((x>>>2)&0x333333);return(Math.imul((x+(x>>>4))&0x0F0F0F,0x010101)>>>16)&0xFF;}
function activeCount(s){return N_PLAYERS-pop(s.eliminated);}
function ace50RHV(h){let v=0;for(let r=0;r<=5;r++){const c=pop(h&RM[r]),rv=r===5?20:r===4?10:(r+1)*2;v+=c*rv*(c>=4?2:c>=3?1.5:1);}return v;}
function pClass(r){return r<=1?0:r<=3?1:2;}
function bkt(n){return n>=3?3:n;}
function pdepth(ps){const d=ps-1;return d<=0?0:d<=2?1:2;}

// Unified encoding — identical to aggregator for 2P, extended with activeCount.
// Perspective-parametrised so self-play opponents (seats 2,3) can encode from their own view.
function encodeStateFor(s, pid){
    const h  = s.hands[pid];
    const p2 = s.pileSize>=2 ? pClass(s.pile[s.pileSize-2]>>2) : 3;
    const p3 = s.pileSize>=3 ? pClass(s.pile[s.pileSize-3]>>2) : 3;
    const myH=Math.min(pop(h),12), myA=pop(h&RM[5]);
    let oppMin=12, oppMinKA=0;
    for(let p=0;p<N_PLAYERS;p++){
        if(p!==pid&&!(s.eliminated&(1<<p))){
            const cnt=Math.min(pop(s.hands[p]),12);
            if(cnt<oppMin){oppMin=cnt;oppMinKA=bkt(pop(s.hands[p]&(RM[4]|RM[5])));}
        }
    }
    return `${s.topRankIdx}|${p2}|${p3}|${bkt(pop(h&(RM[0]|RM[1])))}|${bkt(pop(h&(RM[2]|RM[3])))}|${myA}|${myH}|${oppMin}|${pdepth(s.pileSize)}|${oppMinKA}|${activeCount(s)}`;
}
function encodeState(s){ return encodeStateFor(s, BOT); }

function moveToAct(m){if(m&DRAW_FLAG)return ACT_DRAW;const b=m&0xFFFFFF;if(pop(b)>=3)return ACT_QUAD;return(31-Math.clz32(b))>>2;}
function actToMove(moves,act){
    if(act===ACT_DRAW){for(const m of moves)if(m&DRAW_FLAG)return m;return null;}
    if(act===ACT_QUAD){for(const m of moves)if(!(m&DRAW_FLAG)&&pop(m&0xFFFFFF)>=3)return m;return null;}
    for(const m of moves){if(m&DRAW_FLAG)continue;const b=m&0xFFFFFF;if(pop(b)===1&&((31-Math.clz32(b))>>2)===act)return m;}return null;
}
function legalActs(moves){return[...new Set(moves.map(moveToAct))];}

const Q=new Map();let totalNewStates=0,logQUpdates=0;
function qRow(key){let r=Q.get(key);if(!r){r=new Float64Array(N_ACTS).fill(0);Q.set(key,r);totalNewStates++;}return r;}
function pickAction(key,lActs,eps,fb,s){
    if(Math.random()<eps)return lActs[(Math.random()*lActs.length)|0];
    const r=Q.get(key);
    if(!r)return moveToAct(fb.chooseMove(s)); // SentientBot heuristic fallback
    let best=lActs[0],bv=-Infinity;for(const a of lActs)if(r[a]>bv){bv=r[a];best=a;}return best;
}
// Greedy Q-move for self-play seats 2+3 (no learning, own perspective)
function qGreedyMove(s, pid, fb){
    const moves=getPossibleMoves(s),key=encodeStateFor(s,pid),lActs=legalActs(moves);
    const r=Q.get(key);
    if(!r)return fb.chooseMove(s);
    let best=lActs[0],bv=-Infinity;for(const a of lActs)if(r[a]>bv){bv=r[a];best=a;}
    return actToMove(moves,best)??moves[0];
}
function updateQ(key,act,reward,nKey,nActs){
    if(TEST_MODE)return;
    const r=qRow(key);let mx=0;
    if(nKey&&nActs.length>0){const nr=Q.get(nKey);if(nr){mx=-Infinity;for(const a of nActs)if(nr[a]>mx)mx=nr[a];if(!isFinite(mx))mx=0;}}
    r[act]=r[act]+ALPHA*(reward+GAMMA*mx-r[act]);logQUpdates++;
}

// ---- Load / warm-start ---------------------------------------------
if(existsSync(OUT_PATH)){
    const saved=JSON.parse(readFileSync(OUT_PATH,'utf8')),data=saved.table??saved;let n=0;
    for(const[k,arr]of Object.entries(data)){const r=new Float64Array(N_ACTS);for(let i=0;i<N_ACTS;i++)r[i]=arr[i]==null?0:arr[i];Q.set(k,r);n++;}
    console.log(`Warm-start: loaded ${n} states from q-table-sentient-unified.json`);
}else if(existsSync(SEED_PATH)){
    // Aggregator key format: topRank|p2|p3|myLow|myMid|myA|myH|opH|pdepth|oppKA
    // Unified key format:    same                                          |activeCount
    // For 2P states activeCount=2, so append "|2" to each aggregator key.
    const saved=JSON.parse(readFileSync(SEED_PATH,'utf8').replace(/^\uFEFF/,'')),data=saved.table??saved;let n=0;
    for(const[k,arr]of Object.entries(data)){
        const r=new Float64Array(N_ACTS);for(let i=0;i<N_ACTS;i++)r[i]=arr[i]==null?0:arr[i];
        Q.set(k+'|2',r);n++;
    }
    console.log(`Warm-start: seeded ${n} 2P states from q-table-aggregator.json (appended |2)`);
}else{console.log('No seed — starting fresh.');}

// ---- Step reward ---------------------------------------------------
function stepReward(move,s,botTurns,total){
    let r=0;r-=botTurns*0.018*(1+Math.floor(total/45));
    if(!(move&DRAW_FLAG))r+=0.015*pop(move&0xFFFFFF);
    let dP=-1,dMin=Infinity;
    for(let p=0;p<N_PLAYERS;p++)if(p!==BOT&&!(s.eliminated&(1<<p))){const n=pop(s.hands[p]);if(n<dMin){dMin=n;dP=p;}}
    if(dP!==-1&&dMin>0){let cp=false;for(let rk=s.topRankIdx;rk<=5;rk++)if(s.hands[dP]&RM[rk]){cp=true;break;}if(!cp)r+=0.06;}
    return r;
}

const NEWBIE_PROF={...ISMCTSEngine.PROFILES.newbie,maxIterations:100,maxTime:100};

// ---- Single game ---------------------------------------------------
function playGame(eps){
    let s=createInitialState(N_PLAYERS);
    const fallback=new SentientBot(); // heuristic fallback for unknown states
    // In self-play: seat 0=MCTS Newbie (human proxy), seats 2+3=Q-greedy (no SentientBot)
    // Otherwise:    MCTS_NUM of seats [0,2,3] get MCTS Newbie, rest get SentientBot
    const mctsCandidates=[0,2,3];
    const opps=[null,null,null,null]; // BOT slot stays null
    if(SELF_PLAY){
        opps[0]=new ISMCTSEngine('newbie'); // human proxy
        // seats 2,3 handled inline via qGreedyMove — leave as null marker
        opps[2]=null; opps[3]=null;
    }else{
        for(let i=0;i<3;i++)
            opps[mctsCandidates[i]]=i<MCTS_NUM?new ISMCTSEngine('newbie'):new SentientBot();
    }

    const hist=[];let totalMoves=0,botTurns=0,botOutcome=null,rhvAtEntry=0,p0Outcome=null;

    while(!isGameOver(s)&&totalMoves<STEP_LIMIT){
        const p=s.currentPlayer,moves=getPossibleMoves(s);totalMoves++;let conc;

        if(p!==BOT){
            const opp=opps[p];
            if(SELF_PLAY&&(p===2||p===3)){
                // Self-play: Q-table greedy from this seat's perspective (no learning)
                conc=qGreedyMove(s,p,fallback);
            }else if(opp instanceof ISMCTSEngine){conc=opp.chooseMove(s,NEWBIE_PROF);opp.observeMove(s,conc);opp.advanceTree(conc);opp.cleanup();}
            else{conc=opp.chooseMove(s);opp.observeMove(s,conc);opp.advanceTree(conc);}
        }else{
            botTurns++;
            const key=encodeState(s),lActs=legalActs(moves),act=pickAction(key,lActs,eps,fallback,s);
            conc=actToMove(moves,act)??moves[0];
            qRow(key);hist.push({key,act,lActs,move:conc});
        }

        // SentientBot opponents observe every move for card knowledge
        if(!SELF_PLAY)
            for(let i=0;i<N_PLAYERS;i++)
                if(i!==p&&opps[i] instanceof SentientBot)opps[i].observeMove(s,conc);

        const sN=applyMove(s,conc);
        if(!botOutcome&&(sN.eliminated&(1<<BOT))&&!(s.eliminated&(1<<BOT))){
            const ob=pop(s.eliminated&~(1<<BOT));
            botOutcome=ob===0?'cleared_4p':ob===1?'cleared_3p':'won_2p';
        }
        // Track player 0 (human proxy) outcome for self-play reporting
        if(SELF_PLAY&&!p0Outcome&&(sN.eliminated&1)&&!(s.eliminated&1)){
            const ob=pop(s.eliminated&~1);
            p0Outcome=ob===0?'cleared_4p':ob===1?'cleared_3p':'won_2p';
        }
        // Snapshot ace50 RHV at the moment game enters 2P with BOT still active
        if(rhvAtEntry===0&&activeCount(sN)===2&&!(sN.eliminated&(1<<BOT)))rhvAtEntry=ace50RHV(sN.hands[BOT]);
        s=sN;
    }

    const timedOut=!isGameOver(s);
    if(!botOutcome)botOutcome=timedOut?'timeout':'lost_2p';
    if(SELF_PLAY&&!p0Outcome)p0Outcome=timedOut?'timeout':'lost_2p';
    let termR;
    if(botOutcome==='cleared_4p')termR=R_CLEAR_4P;
    else if(botOutcome==='cleared_3p')termR=R_CLEAR_3P;
    else if(botOutcome==='won_2p')termR=R_WIN_2P+rhvAtEntry*RHV_SCALE;
    else if(botOutcome==='lost_2p')termR=R_LOSE_2P+rhvAtEntry*RHV_SCALE;
    else{let myC=pop(s.hands[BOT]),tot=0;for(let p=0;p<N_PLAYERS;p++)tot+=pop(s.hands[p]);termR=R_TIMEOUT+5*(tot>0?(tot-N_PLAYERS*myC)/tot:0);}

    for(let i=0;i<hist.length;i++){
        const{key,act,lActs:la,move}=hist[i];
        const sr=stepReward(move,s,botTurns,totalMoves);
        if(i<hist.length-1){const{key:nk,lActs:na}=hist[i+1];updateQ(key,act,sr,nk,na);}
        else updateQ(key,act,sr+termR,null,[]);
    }
    return{botOutcome,p0Outcome,totalMoves};
}

function serialise(){const o={};for(const[k,r]of Q)o[k]=Array.from(r).map(v=>isFinite(v)?+v.toFixed(5):null);return o;}

const outcomes={cleared_4p:0,cleared_3p:0,won_2p:0,lost_2p:0,timeout:0};
const logOut  ={cleared_4p:0,cleared_3p:0,won_2p:0,lost_2p:0,timeout:0};
let logN=0,logMoves=0,logNewSnap=0;

const oppDesc=SELF_PLAY?'seat0=MCTS-Newbie (human), seats2+3=Q-greedy (self-play)'
    :MCTS_NUM===0?'3× SentientBot':MCTS_NUM===3?'3× MCTS-Newbie':`${3-MCTS_NUM}× SentientBot + ${MCTS_NUM}× MCTS-Newbie`;
const trackLabel=SELF_PLAY?'P0 (human proxy) — want: clear4P/3P/win2P LOW, lose2P HIGH':'P1 (Q-bot)';
console.log(`\nQ-Sentient Unified Trainer ${TEST_MODE?'(EVALUATION)':''}`);
console.log(`BOT=player ${BOT}  Opponents: ${oppDesc}`);
console.log(`Tracking: ${trackLabel}`);
console.log(`Games: ${GAMES.toLocaleString()}  ε: ${EPS_START}→${EPS_MIN}  α=${ALPHA}  γ=${GAMMA}`);
console.log(`Output: ${OUT_PATH}\n`);

for(let g=1;g<=GAMES;g++){
    const frac=(g-1)/(GAMES-1||1),eps=EPS_MIN+(EPS_START-EPS_MIN)*Math.pow(1-frac,2);
    const{botOutcome,p0Outcome,totalMoves}=playGame(eps);
    const rep=SELF_PLAY?p0Outcome:botOutcome;
    outcomes[rep]++;logOut[rep]++;logMoves+=totalMoves;logN++;
    if(!TEST_MODE&&g%SAVE_EVERY===0){writeFileSync(OUT_PATH,JSON.stringify({games:g,stateCount:Q.size,table:serialise()}));process.stdout.write(`  [saved g${g}: ${Q.size} states]\n`);}
    if(g%LOG_EVERY===0){
        const pct=(k)=>logN>0?(logOut[k]/logN*100).toFixed(1).padStart(5)+'%':'  n/a';
        const ns=totalNewStates-logNewSnap;
        console.log(`  game ${String(g).padStart(6)}  ε=${eps.toFixed(3)}  avgMoves=${(logMoves/logN).toFixed(1).padStart(5)}  +states=${ns.toString().padStart(5)}  total=${Q.size}  Qups=${logQUpdates}`);
        console.log(`    clear4P=${pct('cleared_4p')}  clear3P=${pct('cleared_3p')}  win2P=${pct('won_2p')}  lose2P=${pct('lost_2p')}  TO=${pct('timeout')}`);
        Object.keys(logOut).forEach(k=>logOut[k]=0);logMoves=0;logN=0;logQUpdates=0;logNewSnap=totalNewStates;
    }
}

console.log(`\n=== Final Summary (${GAMES} games) ===`);
const pf=(k)=>(outcomes[k]/GAMES*100).toFixed(1);
console.log(`  Cleared in 4P : ${outcomes.cleared_4p} (${pf('cleared_4p')}%)`);
console.log(`  Cleared in 3P : ${outcomes.cleared_3p} (${pf('cleared_3p')}%)`);
console.log(`  Won 2P duel   : ${outcomes.won_2p} (${pf('won_2p')}%)`);
console.log(`  Lost 2P duel  : ${outcomes.lost_2p} (${pf('lost_2p')}%)`);
if(outcomes.timeout)console.log(`  Timeout       : ${outcomes.timeout} (${pf('timeout')}%)`);
if(!TEST_MODE){writeFileSync(OUT_PATH,JSON.stringify({games:GAMES,stateCount:Q.size,table:serialise()}));console.log(`\nSaved → ${OUT_PATH}  (${Q.size} states, +${totalNewStates} new)`);}
