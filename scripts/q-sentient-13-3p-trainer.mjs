globalThis.window = globalThis.window || { AI_DEBUG: false };
// ================================================================
// scripts/q-sentient-13-3p-trainer.mjs
// Dense 3P booster for q-table-sentient-13.json.
// Starts games with 3 players directly, learns ONLY |3 states,
// merges them back — all 4P/2P states preserved verbatim.
//
// Flags: --games N  --log-every N  --epsilon N  --test
//        --strong-p0   60% unified + 40% SentientBot as p0
//        --pure-unified  100% unified Q-table as p0
// ================================================================
import { createInitialState, getPossibleMoves, applyMove, isGameOver, DRAW_FLAG } from '../game-logic.js';
import { SentientBot } from '../sentient-bot.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir    = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dir, '..', 'q-table-sentient-13.json');
const V2_PATH  = join(__dir, '..', 'q-table-sentient-unified.json');

function getArg(f,fb){const i=process.argv.indexOf(f);return i!==-1&&process.argv[i+1]!==undefined?process.argv[i+1]:fb;}
const TEST_MODE    = process.argv.includes('--test');
const PURE_UNIFIED = process.argv.includes('--pure-unified');
const STRONG_P0    = process.argv.includes('--strong-p0') || PURE_UNIFIED;
const GAMES     = parseInt(getArg('--games',    TEST_MODE?'1000':'50000'),10);
const EPS_START = parseFloat(getArg('--epsilon', TEST_MODE?'0.0':'0.20'));
const EPS_MIN   = TEST_MODE ? 0.0 : 0.03;
const LOG_EVERY = parseInt(getArg('--log-every', TEST_MODE?'200':'1000'),10);

const ALPHA=0.20, GAMMA=0.997, SAVE_EVERY=2000, STEP_LIMIT=250, N_PLAYERS=4, WARMUP_LIMIT=400;
const ACT_QUAD=6, ACT_DRAW=7, N_ACTS=8;
const RM=[0x00000F,0x0000F0,0x000F00,0x00F000,0x0F0000,0xF00000];

// 3P-specific rewards (heavier penalty to force learning)
const R_CLEAR_3P=8, R_WIN_2P=18, RHV_SCALE=0.08;
const R_P0_CLEAR_3P=-15, R_LOSE_2P=-50, R_TIMEOUT=-30, R_P0_DREW=0.6;

// ---- Helpers -------------------------------------------------------
function pop(x){x=x-((x>>>1)&0x555555);x=(x&0x333333)+((x>>>2)&0x333333);return(Math.imul((x+(x>>>4))&0x0F0F0F,0x010101)>>>16)&0xFF;}
function pClass(r){return r<=1?0:r<=3?1:2;}
function bkt(n){return n>=3?3:n;}
function pdepth(ps){const d=ps-1;return d<=0?0:d<=2?1:2;}
function activeCount(s){return N_PLAYERS-pop(s.eliminated);}
function ace50RHV(h){let v=0;for(let r=0;r<=5;r++){const c=pop(h&RM[r]),rv=r===5?20:r===4?10:(r+1)*2;v+=c*rv*(c>=4?2:c>=3?1.5:1);}return v;}

function p0RelPos(s,pid){
    const active=[];for(let i=0;i<N_PLAYERS;i++)if(!(s.eliminated&(1<<i)))active.push(i);
    const n=active.length,myIdx=active.indexOf(pid),p0Idx=active.indexOf(0);
    if(myIdx===-1||p0Idx===-1)return 3;
    const diff=(p0Idx-myIdx+n)%n;
    if(diff===n-1)return 1; if(diff===1)return 2; return 3;
}

// 13-field encoding (identical to main trainer; activeCount=3 always in 3P phase)
function encodeState(s,pid){
    const h=s.hands[pid];
    const p2=s.pileSize>=2?pClass(s.pile[s.pileSize-2]>>2):3;
    const p3=s.pileSize>=3?pClass(s.pile[s.pileSize-3]>>2):3;
    const myLow=bkt(pop(h&(RM[0]|RM[1]))),myMid=bkt(pop(h&(RM[2]|RM[3])));
    const myA=pop(h&RM[5]),myH=Math.min(pop(h),12);
    const th=s.hands[0],tgtH=Math.min(pop(th),12),tgtLow=bkt(pop(th&(RM[0]|RM[1])));
    let minRk=6;for(let rk=0;rk<=5;rk++)if(th&RM[rk]){minRk=rk;break;}
    const tgtMinRank=minRk<=1?0:minRk<=3?1:2;
    return `${s.topRankIdx}|${p2}|${p3}|${myLow}|${myMid}|${myA}|${myH}|${tgtH}|${tgtLow}|${tgtMinRank}|${p0RelPos(s,pid)}|${pdepth(s.pileSize)}|${activeCount(s)}`;
}

// 11-field unified encoding (for strong-p0 proxy)
function encodeUnified(s,pid){
    const h=s.hands[pid];
    const p2=s.pileSize>=2?pClass(s.pile[s.pileSize-2]>>2):3;
    const p3=s.pileSize>=3?pClass(s.pile[s.pileSize-3]>>2):3;
    const myH=Math.min(pop(h),12),myA=pop(h&RM[5]);
    let oppMin=12,oppMinKA=0;
    for(let p=0;p<N_PLAYERS;p++){if(p!==pid&&!(s.eliminated&(1<<p))){const cnt=Math.min(pop(s.hands[p]),12);if(cnt<oppMin){oppMin=cnt;oppMinKA=bkt(pop(s.hands[p]&(RM[4]|RM[5])));}}}
    return `${s.topRankIdx}|${p2}|${p3}|${bkt(pop(h&(RM[0]|RM[1])))}|${bkt(pop(h&(RM[2]|RM[3])))}|${myA}|${myH}|${oppMin}|${pdepth(s.pileSize)}|${oppMinKA}|${activeCount(s)}`;
}

// ---- Move helpers --------------------------------------------------
function moveToAct(m){if(m&DRAW_FLAG)return ACT_DRAW;const b=m&0xFFFFFF;if(pop(b)>=3)return ACT_QUAD;return(31-Math.clz32(b))>>2;}
function actToMove(moves,act){
    if(act===ACT_DRAW){for(const m of moves)if(m&DRAW_FLAG)return m;return null;}
    if(act===ACT_QUAD){for(const m of moves)if(!(m&DRAW_FLAG)&&pop(m&0xFFFFFF)>=3)return m;return null;}
    for(const m of moves){if(m&DRAW_FLAG)continue;const b=m&0xFFFFFF;if(pop(b)===1&&((31-Math.clz32(b))>>2)===act)return m;}return null;
}
function legalActs(moves){return[...new Set(moves.map(moveToAct))];}

// ---- Q-table -------------------------------------------------------
const Q=new Map(); let totalNewStates=0,logQUpdates=0;
function qRow(key){let r=Q.get(key);if(!r){r=new Float64Array(N_ACTS).fill(0);Q.set(key,r);totalNewStates++;}return r;}
function pickAction(key,lActs,eps,fb,s){
    if(Math.random()<eps)return lActs[(Math.random()*lActs.length)|0];
    const r=Q.get(key);
    if(!r)return moveToAct(fb.chooseMove(s));
    let best=lActs[0],bv=-Infinity;for(const a of lActs)if(r[a]>bv){bv=r[a];best=a;}return best;
}
function updateQ(key,act,reward,nKey,nActs){
    if(TEST_MODE)return;
    const r=qRow(key);let mx=0;
    if(nKey&&nActs.length>0){const nr=Q.get(nKey);if(nr){mx=-Infinity;for(const a of nActs)if(nr[a]>mx)mx=nr[a];if(!isFinite(mx))mx=0;}}
    r[act]=r[act]+ALPHA*(reward+GAMMA*mx-r[act]);logQUpdates++;
}

// ---- Load main table: all states into Q for play; non-|3 preserved -
let preserved={};
if(existsSync(OUT_PATH)){
    const d=JSON.parse(readFileSync(OUT_PATH,'utf8')),data=d.table??d;
    let n3=0,nother=0;
    for(const[k,arr]of Object.entries(data)){
        const r=new Float64Array(N_ACTS);for(let i=0;i<N_ACTS;i++)r[i]=arr[i]==null?0:arr[i];
        Q.set(k,r);
        if(k.endsWith('|3'))n3++;else{preserved[k]=arr;nother++;}
    }
    console.log(`Loaded ${n3} 3P states + ${nother} 4P/2P states from q-table-sentient-13.json`);
}else{console.log('No existing 13-table — starting fresh.');}

// ---- Load unified Q-table for --strong-p0 --------------------------
let Q_v2=null;
if(STRONG_P0){
    if(existsSync(V2_PATH)){
        const d=JSON.parse(readFileSync(V2_PATH,'utf8')),data=d.table??d;
        Q_v2=new Map();
        for(const[k,arr]of Object.entries(data)){const r=new Float64Array(N_ACTS);for(let i=0;i<N_ACTS;i++)r[i]=arr[i]==null?0:arr[i];Q_v2.set(k,r);}
        console.log(`Strong-p0: loaded ${Q_v2.size} states from unified table`);
    }else{console.warn('Strong-p0: unified table not found — using SentientBot only');}
}

// ---- P0 proxy ------------------------------------------------------
const UNIFIED_FRAC=PURE_UNIFIED?1.0:0.60;
function pickP0ProxyType(){return (Q_v2&&Math.random()<UNIFIED_FRAC)?'unified':'sentient';}
function p0Move(s,v2bot,proxyType){
    if(proxyType==='unified'){
        const moves=getPossibleMoves(s),key=encodeUnified(s,0),lActs=legalActs(moves);
        const r=Q_v2.get(key);
        if(r){let best=lActs[0],bv=-Infinity;for(const a of lActs)if(r[a]>bv){bv=r[a];best=a;}return actToMove(moves,best)??moves[0];}
    }
    return v2bot.chooseMove(s);
}

// ---- Rewards -------------------------------------------------------
function stepReward(move,turns,total,p0Drew){
    let r=0;
    r-=turns*0.018*(1+Math.floor(total/35));
    if(!(move&DRAW_FLAG))r+=0.015*pop(move&0xFFFFFF);
    if(p0Drew)r+=R_P0_DREW;
    return r;
}
function terminalReward(outcome,rhv,p0Out){
    if(outcome==='cleared_3p'){
        if(p0Out==='p0_lose2p')return R_CLEAR_3P+6;  // +14
        if(p0Out==='p0_win2p') return R_CLEAR_3P-4;  //  +4
        return R_CLEAR_3P;
    }
    if(outcome==='won_2p')        return R_WIN_2P+rhv*RHV_SCALE;
    if(outcome==='p0_cleared_3p') return R_P0_CLEAR_3P;
    if(outcome==='lost_2p')       return R_LOSE_2P+rhv*RHV_SCALE;
    return R_TIMEOUT;
}

// ---- Single game: 4P warmup (greedy) → 3P learning ---------------
// Warmup brings hand sizes to realistic 4P→3P distributions.
// Returns null if p0 cleared in warmup (skip this game).
function playGame(eps){
    let s=createInitialState(4);
    const proxyType=pickP0ProxyType();
    const p0bot=new SentientBot(),fallback=new SentientBot();

    // Phase 1: 4P warmup — greedy, no learning
    let warmupMoves=0,warmupCleared=0;
    while(!isGameOver(s)&&!(s.eliminated&1)&&activeCount(s)===4&&warmupMoves<WARMUP_LIMIT){
        const p=s.currentPlayer,moves=getPossibleMoves(s);warmupMoves++;
        let conc;
        if(p===0){
            conc=p0Move(s,p0bot,proxyType);
            p0bot.observeMove(s,conc);p0bot.advanceTree(conc);
        }else{
            const key=encodeState(s,p),lActs=legalActs(moves);
            conc=actToMove(moves,pickAction(key,lActs,0,fallback,s))??moves[0];
            p0bot.observeMove(s,conc);
        }
        const sN=applyMove(s,conc);
        for(let b=1;b<=3;b++)if((sN.eliminated&(1<<b))&&!(s.eliminated&(1<<b)))warmupCleared++;
        s=sN;
    }
    // Skip if p0 cleared in warmup or 4P phase timed out
    if((s.eliminated&1)||activeCount(s)!==3)return null;

    // Phase 2: 3P learning
    const BOTS=[];for(let b=1;b<=3;b++)if(!(s.eliminated&(1<<b)))BOTS.push(b);
    const hists={},turnCnt={},qOut={},rhvAt={},p0DrewFor={};
    for(const b of BOTS){hists[b]=[];turnCnt[b]=0;qOut[b]=null;rhvAt[b]=0;p0DrewFor[b]=false;}
    let p0Out=null,totalMoves=0;

    while(!isGameOver(s)&&!(s.eliminated&1)&&totalMoves<STEP_LIMIT){
        const p=s.currentPlayer,moves=getPossibleMoves(s);totalMoves++;
        let conc;
        const in3P=activeCount(s)===3;

        if(p===0){
            conc=p0Move(s,p0bot,proxyType);
            p0bot.observeMove(s,conc);p0bot.advanceTree(conc);
            if(conc&DRAW_FLAG)for(const b of BOTS)p0DrewFor[b]=true;
        }else{
            turnCnt[p]++;
            const key=encodeState(s,p),lActs=legalActs(moves);
            const act=pickAction(key,lActs,in3P?eps:0,fallback,s);
            conc=actToMove(moves,act)??moves[0];
            qRow(key);
            if(in3P){const p0Drew=p0DrewFor[p];p0DrewFor[p]=false;hists[p].push({key,act,lActs,move:conc,p0Drew});}
            p0bot.observeMove(s,conc);
        }

        const sN=applyMove(s,conc);

        if(!p0Out&&(sN.eliminated&1)&&!(s.eliminated&1)){
            const ob=pop(s.eliminated&~1); // ob===warmupCleared → cleared in 3P phase
            p0Out=ob===warmupCleared?'p0_3p':'p0_win2p';
        }
        for(const qp of BOTS){
            if(!qOut[qp]&&(sN.eliminated&(1<<qp))&&!(s.eliminated&(1<<qp))){
                const ob=pop(s.eliminated&~(1<<qp));
                qOut[qp]=ob===warmupCleared?'cleared_3p':'won_2p';
            }
            if(rhvAt[qp]===0&&activeCount(sN)===2&&!(sN.eliminated&(1<<qp)))rhvAt[qp]=ace50RHV(sN.hands[qp]);
        }
        s=sN;
    }

    const p0Cleared=!!(s.eliminated&1),timedOut=!isGameOver(s)&&!p0Cleared;
    if(!p0Out)p0Out=timedOut?'timeout':'p0_lose2p';
    if(p0Cleared){
        const stillActive=N_PLAYERS-pop(s.eliminated);
        const ph=stillActive===1?'lost_2p':'p0_cleared_3p';
        for(const qp of BOTS)if(!qOut[qp])qOut[qp]=ph;
    }else{
        for(const qp of BOTS)if(!qOut[qp])qOut[qp]=timedOut?'timeout':'lost_2p';
    }

    for(const qp of BOTS){
        const h=hists[qp];if(h.length===0)continue;
        const termR=terminalReward(qOut[qp],rhvAt[qp],p0Out);
        for(let i=0;i<h.length;i++){
            const{key,act,lActs:la,move,p0Drew}=h[i];
            const sr=stepReward(move,turnCnt[qp],totalMoves,p0Drew);
            if(i<h.length-1){const{key:nk,lActs:na}=h[i+1];updateQ(key,act,sr,nk,na);}
            else updateQ(key,act,sr+termR,null,[]);
        }
    }
    return{p0Out,proxyType,totalMoves};
}

// ---- Serialise: preserved + updated |3 states ----------------------
function serialise(){
    const out={...preserved};
    for(const[k,r]of Q)if(k.endsWith('|3'))out[k]=Array.from(r).map(v=>isFinite(v)?+v.toFixed(5):null);
    return out;
}

// ---- Main loop -----------------------------------------------------
const KEYS=['p0_3p','p0_win2p','p0_lose2p','timeout'];
const mkCnt=()=>Object.fromEntries(KEYS.map(k=>[k,0]));
const outcomes=mkCnt(),logOut={sentient:mkCnt(),unified:mkCnt()};
let logN={sentient:0,unified:0},logMoves=0,logNewSnap=0;

console.log(`\nQ-Sentient-13 3P Booster (4P warmup) ${TEST_MODE?'[EVAL]':''}`);
console.log(`P0 proxy: ${PURE_UNIFIED?'100% unified Q-table':Q_v2?'60% unified + 40% SentientBot':'100% SentientBot'}`);
console.log(`3P rewards: p0_cleared=${R_P0_CLEAR_3P}  won_2p=${R_WIN_2P}  lost_2p=${R_LOSE_2P}`);
console.log(`Games: ${GAMES.toLocaleString()}  ε: ${EPS_START}→${EPS_MIN}  α=${ALPHA}  γ=${GAMMA}`);
console.log(`Output: ${OUT_PATH}  (|3 states updated; 4P/2P preserved)\n`);

let g=0;
while(g<GAMES){
    const frac=g/(GAMES-1||1),eps=EPS_MIN+(EPS_START-EPS_MIN)*Math.pow(1-frac,2);
    const result=playGame(eps);
    if(!result)continue; // p0 cleared in 4P warmup — skip, don't count
    g++;
    const{p0Out,proxyType,totalMoves}=result;
    outcomes[p0Out]++;logOut[proxyType][p0Out]++;logN[proxyType]++;
    logMoves+=totalMoves;

    if(!TEST_MODE&&g%SAVE_EVERY===0){
        writeFileSync(OUT_PATH,JSON.stringify({games:g,stateCount:Q.size,table:serialise()}));
        process.stdout.write(`  [saved g${g}: ${Object.keys(preserved).length} preserved + updated |3]\n`);
    }
    if(g%LOG_EVERY===0){
        const totalN=logN.sentient+logN.unified||1;
        const pct=(t,k)=>logN[t]>0?(logOut[t][k]/logN[t]*100).toFixed(1).padStart(5)+'%':'  n/a';
        const ns=totalNewStates-logNewSnap;
        console.log(`  game ${String(g).padStart(6)}  ε=${eps.toFixed(3)}  avgMoves=${(logMoves/totalN).toFixed(1).padStart(5)}  +states=${ns.toString().padStart(5)}`);
        if(logN.sentient>0)console.log(`    vs Sentient (n=${logN.sentient}): clear3P=${pct('sentient','p0_3p')}  win2P=${pct('sentient','p0_win2p')}  lose2P=${pct('sentient','p0_lose2p')}`);
        if(logN.unified>0) console.log(`    vs Unified  (n=${logN.unified}): clear3P=${pct('unified','p0_3p')}  win2P=${pct('unified','p0_win2p')}  lose2P=${pct('unified','p0_lose2p')}`);
        logMoves=0;logN={sentient:0,unified:0};logQUpdates=0;logNewSnap=totalNewStates;
        KEYS.forEach(k=>{logOut.sentient[k]=0;logOut.unified[k]=0;});
    }
}

console.log(`\n=== Final Summary (${GAMES} games, 3P-via-4P-warmup, P0 perspective) ===`);
const pf=k=>(outcomes[k]/GAMES*100).toFixed(1);
console.log(`  P0 Cleared 3P  : ${outcomes.p0_3p} (${pf('p0_3p')}%)`);
console.log(`  P0 Won 2P duel : ${outcomes.p0_win2p} (${pf('p0_win2p')}%)`);
console.log(`  P0 Lost 2P     : ${outcomes.p0_lose2p} (${pf('p0_lose2p')}%)`);
console.log(`  Timeout        : ${outcomes.timeout} (${pf('timeout')}%)`);
if(!TEST_MODE){
    writeFileSync(OUT_PATH,JSON.stringify({games:GAMES,stateCount:Q.size,table:serialise()}));
    console.log(`\nSaved → ${OUT_PATH}  (${Object.keys(preserved).length} 4P/2P preserved + updated |3 states)`);
}
