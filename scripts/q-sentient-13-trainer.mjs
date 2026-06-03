globalThis.window = globalThis.window || { AI_DEBUG: false };
// ================================================================
// scripts/q-sentient-13-trainer.mjs
// New Q-table for the 4P-q-sentient bot — 13-field p0-targeting encoding.
//
// State key (13 fields):
//   topRankIdx | p2 | p3 | myLow | myMid | myA | myH |
//   tgtH | tgtLow | tgtMinRank | tgtPos | pdepth | activeCount
//
//   tgtH        : player 0's hand size (0-12)
//   tgtLow      : player 0's low-card count bucketed (0-3)
//   tgtMinRank  : rank class of p0's lowest card (0=low 0-1, 1=mid 2-3, 2=high 4-5)
//   tgtPos      : p0 position relative to me in active turn order
//                 (1=directly before, 2=directly after, 3=at distance)
//
// Game terminates when player 0 clears their hand (mirrors real game).
// Seats 1, 2, 3 all learn the same Q-table. Seat 0 = human proxy.
//
// Outcomes (seat-1 perspective in reports):
//   cleared_4p     bot cleared before p0 in 4P stage            (great)
//   cleared_3p     bot cleared before p0 in 3P stage            (good)
//   won_2p         bot won the 2P duel vs p0                    (great)
//   p0_cleared_4p  p0 escaped in 4P — game over                 (bad)
//   p0_cleared_3p  p0 escaped in 3P — game over                 (medium bad)
//   lost_2p        bot lost the 2P duel to p0                   (worst)
//   timeout        step limit hit                                (bad)
//
// Usage:
//   node scripts/q-sentient-13-trainer.mjs [--games N] [--log-every N]
//       [--epsilon N] [--test] [--strong-p0]
//
// Flags:
//   --games N      games to play (default 10000 / 1000 in test)
//   --log-every N  report interval (default 500 / 100 in test)
//   --epsilon N    start epsilon (default 0.25 / 0.0 in test)
//   --test         evaluation mode: no learning, ε=0
//   --strong-p0    p0 proxy: 60% sentient-unified-v2 + 40% SentientBot
//                  (use after initial run; falls back to SentientBot if v2 missing)
//
// Output: q-table-sentient-13.json
// ================================================================
import { createInitialState, getPossibleMoves, applyMove, isGameOver, DRAW_FLAG } from '../game-logic.js';
import { SentientBot } from '../sentient-bot.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir    = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dir, '..', 'q-table-sentient-13.json');
const V2_PATH  = join(__dir, '..', 'q-table-sentient-unified.json');

function getArg(flag, fb){ const i=process.argv.indexOf(flag); return i!==-1&&process.argv[i+1]!==undefined?process.argv[i+1]:fb; }
const TEST_MODE    = process.argv.includes('--test');
const PURE_UNIFIED = process.argv.includes('--pure-unified');
const STRONG_P0    = process.argv.includes('--strong-p0') || PURE_UNIFIED;
const GAMES      = parseInt(getArg('--games',    TEST_MODE?'1000':'10000'), 10);
const EPS_START  = parseFloat(getArg('--epsilon', TEST_MODE?'0.0':'0.25'));
const EPS_MIN    = TEST_MODE ? 0.0 : 0.03;
const LOG_EVERY  = parseInt(getArg('--log-every', TEST_MODE?'100':'500'), 10);

const ALPHA=0.20, GAMMA=0.997, SAVE_EVERY=500, STEP_LIMIT=500, N_PLAYERS=4;
const ACT_QUAD=6, ACT_DRAW=7, N_ACTS=8;
const RM=[0x00000F,0x0000F0,0x000F00,0x00F000,0x0F0000,0xF00000];

const R_CLEAR_4P=12, R_CLEAR_3P=8, R_WIN_2P=15, RHV_SCALE=0.08;
const R_P0_CLEAR_4P=-20, R_P0_CLEAR_3P=-8, R_LOSE_2P=-50, R_TIMEOUT=-30;

// ---- Helpers -------------------------------------------------------
function pop(x){x=x-((x>>>1)&0x555555);x=(x&0x333333)+((x>>>2)&0x333333);return(Math.imul((x+(x>>>4))&0x0F0F0F,0x010101)>>>16)&0xFF;}
function pClass(r){return r<=1?0:r<=3?1:2;}
function bkt(n){return n>=3?3:n;}
function pdepth(ps){const d=ps-1;return d<=0?0:d<=2?1:2;}
function activeCount(s){return N_PLAYERS-pop(s.eliminated);}
function ace50RHV(h){let v=0;for(let r=0;r<=5;r++){const c=pop(h&RM[r]),rv=r===5?20:r===4?10:(r+1)*2;v+=c*rv*(c>=4?2:c>=3?1.5:1);}return v;}

// p0's position relative to pid in the active turn order
// Returns: 1=p0 directly before pid, 2=p0 directly after pid, 3=at distance
function p0RelPos(s, pid){
    const active=[];
    for(let i=0;i<N_PLAYERS;i++) if(!(s.eliminated&(1<<i))) active.push(i);
    const n=active.length, myIdx=active.indexOf(pid), p0Idx=active.indexOf(0);
    if(myIdx===-1||p0Idx===-1) return 3;
    const diff=(p0Idx-myIdx+n)%n;
    if(diff===n-1) return 1;  // p0 directly before pid
    if(diff===1)   return 2;  // p0 directly after pid
    return 3;
}

// ---- New 13-field encoding -----------------------------------------
// Target = player 0 always (game ends when p0 clears, so p0 is active during all encoded states)
function encodeState(s, pid){
    const h=s.hands[pid];
    const p2=s.pileSize>=2?pClass(s.pile[s.pileSize-2]>>2):3;
    const p3=s.pileSize>=3?pClass(s.pile[s.pileSize-3]>>2):3;
    const myLow=bkt(pop(h&(RM[0]|RM[1]))), myMid=bkt(pop(h&(RM[2]|RM[3])));
    const myA=pop(h&RM[5]), myH=Math.min(pop(h),12);
    const th=s.hands[0]; // player 0 always active here
    const tgtH=Math.min(pop(th),12);
    const tgtLow=bkt(pop(th&(RM[0]|RM[1])));
    let minRk=6; for(let rk=0;rk<=5;rk++) if(th&RM[rk]){minRk=rk;break;}
    const tgtMinRank=minRk<=1?0:minRk<=3?1:2; // 0=low,1=mid,2=high
    const tgtPos=p0RelPos(s,pid);
    return `${s.topRankIdx}|${p2}|${p3}|${myLow}|${myMid}|${myA}|${myH}|${tgtH}|${tgtLow}|${tgtMinRank}|${tgtPos}|${pdepth(s.pileSize)}|${activeCount(s)}`;
}

// ---- Old 11-field unified encoding (for --strong-p0 proxy) ---------
function encodeUnified(s, pid){
    const h=s.hands[pid];
    const p2=s.pileSize>=2?pClass(s.pile[s.pileSize-2]>>2):3;
    const p3=s.pileSize>=3?pClass(s.pile[s.pileSize-3]>>2):3;
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

// ---- Move helpers --------------------------------------------------
function moveToAct(m){if(m&DRAW_FLAG)return ACT_DRAW;const b=m&0xFFFFFF;if(pop(b)>=3)return ACT_QUAD;return(31-Math.clz32(b))>>2;}
function actToMove(moves,act){
    if(act===ACT_DRAW){for(const m of moves)if(m&DRAW_FLAG)return m;return null;}
    if(act===ACT_QUAD){for(const m of moves)if(!(m&DRAW_FLAG)&&pop(m&0xFFFFFF)>=3)return m;return null;}
    for(const m of moves){if(m&DRAW_FLAG)continue;const b=m&0xFFFFFF;if(pop(b)===1&&((31-Math.clz32(b))>>2)===act)return m;}return null;
}
function legalActs(moves){return[...new Set(moves.map(moveToAct))];}

// ---- Q-table -------------------------------------------------------
const Q=new Map(); let totalNewStates=0, logQUpdates=0;
function qRow(key){let r=Q.get(key);if(!r){r=new Float64Array(N_ACTS).fill(0);Q.set(key,r);totalNewStates++;}return r;}
function pickAction(key, lActs, eps, fallback, s){
    if(Math.random()<eps) return lActs[(Math.random()*lActs.length)|0];
    const r=Q.get(key);
    // Fallback: SentientBot with perfect-info state — no history needed in training context
    if(!r) return moveToAct(fallback.chooseMove(s));
    let best=lActs[0],bv=-Infinity; for(const a of lActs)if(r[a]>bv){bv=r[a];best=a;} return best;
}
function updateQ(key, act, reward, nKey, nActs){
    if(TEST_MODE)return;
    const r=qRow(key); let mx=0;
    if(nKey&&nActs.length>0){const nr=Q.get(nKey);if(nr){mx=-Infinity;for(const a of nActs)if(nr[a]>mx)mx=nr[a];if(!isFinite(mx))mx=0;}}
    r[act]=r[act]+ALPHA*(reward+GAMMA*mx-r[act]); logQUpdates++;
}

// ---- Load existing table (resume) ----------------------------------
if(existsSync(OUT_PATH)){
    const d=JSON.parse(readFileSync(OUT_PATH,'utf8')), data=d.table??d; let n=0;
    for(const[k,arr]of Object.entries(data)){const r=new Float64Array(N_ACTS);for(let i=0;i<N_ACTS;i++)r[i]=arr[i]==null?0:arr[i];Q.set(k,r);n++;}
    console.log(`Warm-start: loaded ${n} states from q-table-sentient-13.json`);
}else{console.log('No existing table — starting fresh.');}

// ---- Load sentient-unified-v2 for --strong-p0 ----------------------
let Q_v2=null;
if(STRONG_P0){
    if(existsSync(V2_PATH)){
        const d=JSON.parse(readFileSync(V2_PATH,'utf8')), data=d.table??d;
        Q_v2=new Map();
        for(const[k,arr]of Object.entries(data)){const r=new Float64Array(N_ACTS);for(let i=0;i<N_ACTS;i++)r[i]=arr[i]==null?0:arr[i];Q_v2.set(k,r);}
        console.log(`Strong-p0: loaded ${Q_v2.size} states from sentient-unified-v2`);
    }else{console.warn('Strong-p0: sentient-unified-v2.json not found — using SentientBot only');}
}

// ---- P0 proxy move -------------------------------------------------
// proxyType decided once per game: 'unified' or 'sentient'
const UNIFIED_FRAC = PURE_UNIFIED ? 1.0 : 0.60;
function pickP0ProxyType(){
    return (Q_v2&&Math.random()<UNIFIED_FRAC)?'unified':'sentient';
}
function p0Move(s, v2bot, proxyType){
    if(proxyType==='unified'){
        const moves=getPossibleMoves(s), key=encodeUnified(s,0), lActs=legalActs(moves);
        const r=Q_v2.get(key);
        if(r){let best=lActs[0],bv=-Infinity;for(const a of lActs)if(r[a]>bv){bv=r[a];best=a;}return actToMove(moves,best)??moves[0];}
    }
    return v2bot.chooseMove(s); // SentientBot (default + unified fallback)
}

// ---- Rewards -------------------------------------------------------
const R_P0_DREW = 0.6; // step bonus for having forced p0 to draw
function stepReward(move, turns, total, p0Drew){
    let r=0;
    r -= turns*0.018*(1+Math.floor(total/45));
    if(!(move&DRAW_FLAG)) r += 0.015*pop(move&0xFFFFFF);
    if(p0Drew) r += R_P0_DREW;
    return r;
}
function terminalReward(outcome, rhv, p0Out){
    if(outcome==='cleared_4p'){
        // Bot exited in 4P — reward depends on whether the coalition finished the job
        if(p0Out==='p0_lose2p') return R_CLEAR_4P + 4;  // +16: cleared AND partner beat p0
        if(p0Out==='p0_3p')     return R_CLEAR_4P - 9;  //  +3: cleared but p0 slipped out in 3P
        if(p0Out==='p0_win2p')  return R_CLEAR_4P - 6;  //  +6: reached 2P but p0 won duel
        return R_CLEAR_4P; // fallback (p0_4p impossible here)
    }
    if(outcome==='cleared_3p'){
        // Bot exited in 3P — reward depends on 2P duel outcome
        if(p0Out==='p0_lose2p') return R_CLEAR_3P + 6;  // +14: set up winning 2P duel
        if(p0Out==='p0_win2p')  return R_CLEAR_3P - 4;  //  +4: reached 2P but p0 won
        return R_CLEAR_3P;
    }
    if(outcome==='won_2p')        return R_WIN_2P + rhv*RHV_SCALE;
    if(outcome==='p0_cleared_4p') return R_P0_CLEAR_4P;
    if(outcome==='p0_cleared_3p') return R_P0_CLEAR_3P;
    if(outcome==='lost_2p')       return R_LOSE_2P + rhv*RHV_SCALE;
    return R_TIMEOUT;
}

// ---- Single game ---------------------------------------------------
function playGame(eps){
    let s=createInitialState(N_PLAYERS);
    const proxyType=pickP0ProxyType(); // fixed for this entire game
    const p0bot=new SentientBot();
    const fallback=new SentientBot();

    const hists=[null,[],[],[]];
    const turnCnt=[0,0,0,0];
    const qOut=[null,null,null,null];
    const rhvAt=[0,0,0,0];
    const p0DrewFor=[false,false,false,false]; // did p0 draw since this bot's last turn?
    let p0Out=null, totalMoves=0;

    while(!isGameOver(s)&&!(s.eliminated&1)&&totalMoves<STEP_LIMIT){
        const p=s.currentPlayer, moves=getPossibleMoves(s); totalMoves++;
        let conc;

        if(p===0){
            conc=p0Move(s, p0bot, proxyType);
            p0bot.observeMove(s,conc); p0bot.advanceTree(conc);
            if(conc&DRAW_FLAG) for(let i=1;i<=3;i++) p0DrewFor[i]=true; // p0 drew — credit next bot
        }else{
            turnCnt[p]++;
            const key=encodeState(s,p), lActs=legalActs(moves);
            const act=pickAction(key,lActs,eps,fallback,s);
            conc=actToMove(moves,act)??moves[0];
            qRow(key);
            const p0Drew=p0DrewFor[p]; p0DrewFor[p]=false;
            hists[p].push({key,act,lActs,move:conc,p0Drew});
            p0bot.observeMove(s,conc); // p0 proxy tracks all moves
        }

        const sN=applyMove(s,conc);

        // Track p0's outcome
        if(!p0Out&&(sN.eliminated&1)&&!(s.eliminated&1)){
            const ob=pop(s.eliminated&~1); // non-p0 players cleared before p0
            p0Out=ob===0?'p0_4p':ob===1?'p0_3p':'p0_win2p';
        }

        for(const qp of [1,2,3]){
            if(!qOut[qp]&&(sN.eliminated&(1<<qp))&&!(s.eliminated&(1<<qp))){
                const ob=pop(s.eliminated&~(1<<qp));
                qOut[qp]=ob===0?'cleared_4p':ob===1?'cleared_3p':'won_2p';
            }
            if(rhvAt[qp]===0&&activeCount(sN)===2&&!(sN.eliminated&(1<<qp)))
                rhvAt[qp]=ace50RHV(sN.hands[qp]);
        }
        s=sN;
    }

    // Assign outcomes to bots still active at termination
    const p0Cleared=!!(s.eliminated&1);
    const timedOut=!isGameOver(s)&&!p0Cleared;

    if(!p0Out) p0Out=timedOut?'timeout':'p0_lose2p'; // p0 was last remaining = lost

    if(p0Cleared){
        const stillActive=N_PLAYERS-pop(s.eliminated);
        const p0Phase=stillActive===1?'lost_2p':stillActive===2?'p0_cleared_3p':'p0_cleared_4p';
        for(const qp of [1,2,3]) if(!qOut[qp]) qOut[qp]=p0Phase;
    }else{
        for(const qp of [1,2,3]) if(!qOut[qp]) qOut[qp]=timedOut?'timeout':'lost_2p';
    }

    for(const qp of [1,2,3]){
        const h=hists[qp]; if(h.length===0) continue;
        const termR=terminalReward(qOut[qp], rhvAt[qp], p0Out);
        for(let i=0;i<h.length;i++){
            const{key,act,lActs:la,move,p0Drew}=h[i];
            const sr=stepReward(move, turnCnt[qp], totalMoves, p0Drew);
            if(i<h.length-1){const{key:nk,lActs:na}=h[i+1];updateQ(key,act,sr,nk,na);}
            else updateQ(key,act,sr+termR,null,[]);
        }
    }

    return{p0Out, proxyType, totalMoves};
}

function serialise(){const o={};for(const[k,r]of Q)o[k]=Array.from(r).map(v=>isFinite(v)?+v.toFixed(5):null);return o;}

// ---- Main loop -----------------------------------------------------
const KEYS=['p0_4p','p0_3p','p0_win2p','p0_lose2p','timeout'];
const mkCnt=()=>Object.fromEntries(KEYS.map(k=>[k,0]));
const outcomes=mkCnt();
const logOut={sentient:mkCnt(), unified:mkCnt()};
let logN={sentient:0, unified:0}, logMoves=0, logNewSnap=0;

console.log(`\nQ-Sentient-13 Trainer ${TEST_MODE?'[EVAL]':''}`);
console.log(`P0 proxy: ${PURE_UNIFIED?'100% unified Q-table':Q_v2?'60% unified + 40% SentientBot':'100% SentientBot'}`);
console.log(`Encoding: topRank|p2|p3|myLow|myMid|myA|myH|tgtH|tgtLow|tgtMinRank|tgtPos|pdepth|active`);
console.log(`Games: ${GAMES.toLocaleString()}  ε: ${EPS_START}→${EPS_MIN}  α=${ALPHA}  γ=${GAMMA}`);
console.log(`Output: ${OUT_PATH}\n`);

for(let g=1;g<=GAMES;g++){
    const frac=(g-1)/(GAMES-1||1), eps=EPS_MIN+(EPS_START-EPS_MIN)*Math.pow(1-frac,2);
    const{p0Out,proxyType,totalMoves}=playGame(eps);
    outcomes[p0Out]++; logOut[proxyType][p0Out]++; logN[proxyType]++;
    logMoves+=totalMoves;

    if(!TEST_MODE&&g%SAVE_EVERY===0){
        writeFileSync(OUT_PATH,JSON.stringify({games:g,stateCount:Q.size,table:serialise()}));
        process.stdout.write(`  [saved g${g}: ${Q.size} states]\n`);
    }
    if(g%LOG_EVERY===0){
        const totalN=logN.sentient+logN.unified||1;
        const pct=(type,k)=>logN[type]>0?(logOut[type][k]/logN[type]*100).toFixed(1).padStart(5)+'%':'  n/a';
        const ns=totalNewStates-logNewSnap;
        console.log(`  game ${String(g).padStart(6)}  ε=${eps.toFixed(3)}  avgMoves=${(logMoves/totalN).toFixed(1).padStart(5)}  +states=${ns.toString().padStart(5)}  total=${Q.size}`);
        if(logN.sentient>0) console.log(`    vs Sentient (n=${logN.sentient}): clear4P=${pct('sentient','p0_4p')}  clear3P=${pct('sentient','p0_3p')}  win2P=${pct('sentient','p0_win2p')}  lose2P=${pct('sentient','p0_lose2p')}`);
        if(logN.unified>0)  console.log(`    vs Unified  (n=${logN.unified}): clear4P=${pct('unified','p0_4p')}  clear3P=${pct('unified','p0_3p')}  win2P=${pct('unified','p0_win2p')}  lose2P=${pct('unified','p0_lose2p')}`);
        KEYS.forEach(k=>{logOut.sentient[k]=0;logOut.unified[k]=0;});
        logMoves=0; logN={sentient:0,unified:0}; logQUpdates=0; logNewSnap=totalNewStates;
    }
}

console.log(`\n=== Final Summary (${GAMES} games, P0 perspective) ===`);
const pf=k=>(outcomes[k]/GAMES*100).toFixed(1);
console.log(`  P0 Cleared 4P : ${outcomes.p0_4p} (${pf('p0_4p')}%)`);
console.log(`  P0 Cleared 3P : ${outcomes.p0_3p} (${pf('p0_3p')}%)`);
console.log(`  P0 Won 2P     : ${outcomes.p0_win2p} (${pf('p0_win2p')}%)`);
console.log(`  P0 Lost 2P    : ${outcomes.p0_lose2p} (${pf('p0_lose2p')}%)`);
console.log(`  Timeout       : ${outcomes.timeout} (${pf('timeout')}%)`);
if(!TEST_MODE){
    writeFileSync(OUT_PATH,JSON.stringify({games:GAMES,stateCount:Q.size,table:serialise()}));
    console.log(`\nSaved → ${OUT_PATH}  (${Q.size} states, +${totalNewStates} new)`);
}
