globalThis.window = globalThis.window || { AI_DEBUG: false };
// ================================================================
// scripts/q-sentient-version-eval.mjs
// Head-to-head evaluation: frozen v1 (seat 0)  vs  challenger v2/v3 (seats 1,2,3)
// No learning, epsilon=0 (greedy). Mirrors the versioned training setup exactly.
//
// Usage:
//   node scripts/q-sentient-version-eval.mjs --v2 [--games N] [--log-every N]
//   node scripts/q-sentient-version-eval.mjs --v3 [--games N] [--log-every N]
//
// Report columns (from each side's own perspective):
//   clear4P% | clear3P% | win2P% | lose2P% | TO%
// ================================================================
import { createInitialState, getPossibleMoves, applyMove, isGameOver, DRAW_FLAG } from '../game-logic.js';
import { SentientBot } from '../sentient-bot.js';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

const V2_FLAG = process.argv.includes('--v2');
const V3_FLAG = process.argv.includes('--v3');
if (!V2_FLAG && !V3_FLAG) {
    console.error('Usage: node scripts/q-sentient-version-eval.mjs --v2 | --v3 [--games N] [--log-every N]');
    process.exit(1);
}

function getArg(flag, fb) { const i=process.argv.indexOf(flag); return i!==-1&&process.argv[i+1]!==undefined?process.argv[i+1]:fb; }
const GAMES     = parseInt(getArg('--games',     '2000'), 10);
const LOG_EVERY = parseInt(getArg('--log-every',  '200'), 10);

const LABEL    = V3_FLAG ? 'v3' : 'v2';
const V1_PATH  = join(__dir, '..', 'q-table-sentient-unified.json');
const CH_PATH  = join(__dir, '..', `q-table-sentient-unified-${LABEL}.json`);

// ---- Encoding (must match unified trainer exactly) ---------------
const N_ACTS=8, N_PLAYERS=4, STEP_LIMIT=500;
const ACT_QUAD=6, ACT_DRAW=7;
const RM=[0x00000F,0x0000F0,0x000F00,0x00F000,0x0F0000,0xF00000];
function pop(x){x=x-((x>>>1)&0x555555);x=(x&0x333333)+((x>>>2)&0x333333);return(Math.imul((x+(x>>>4))&0x0F0F0F,0x010101)>>>16)&0xFF;}
function activeCount(s){return N_PLAYERS-pop(s.eliminated);}
function pClass(r){return r<=1?0:r<=3?1:2;}
function bkt(n){return n>=3?3:n;}
function pdepth(ps){const d=ps-1;return d<=0?0:d<=2?1:2;}
function encodeStateFor(s,pid){
    const h=s.hands[pid];
    const p2=s.pileSize>=2?pClass(s.pile[s.pileSize-2]>>2):3;
    const p3=s.pileSize>=3?pClass(s.pile[s.pileSize-3]>>2):3;
    const myH=Math.min(pop(h),12),myA=pop(h&RM[5]);
    let oppMin=12,oppMinKA=0;
    for(let p=0;p<N_PLAYERS;p++){
        if(p!==pid&&!(s.eliminated&(1<<p))){
            const cnt=Math.min(pop(s.hands[p]),12);
            if(cnt<oppMin){oppMin=cnt;oppMinKA=bkt(pop(s.hands[p]&(RM[4]|RM[5])));}
        }
    }
    return `${s.topRankIdx}|${p2}|${p3}|${bkt(pop(h&(RM[0]|RM[1])))}|${bkt(pop(h&(RM[2]|RM[3])))}|${myA}|${myH}|${oppMin}|${pdepth(s.pileSize)}|${oppMinKA}|${activeCount(s)}`;
}
function moveToAct(m){if(m&DRAW_FLAG)return ACT_DRAW;const b=m&0xFFFFFF;if(pop(b)>=3)return ACT_QUAD;return(31-Math.clz32(b))>>2;}
function actToMove(moves,act){
    if(act===ACT_DRAW){for(const m of moves)if(m&DRAW_FLAG)return m;return null;}
    if(act===ACT_QUAD){for(const m of moves)if(!(m&DRAW_FLAG)&&pop(m&0xFFFFFF)>=3)return m;return null;}
    for(const m of moves){if(m&DRAW_FLAG)continue;const b=m&0xFFFFFF;if(pop(b)===1&&((31-Math.clz32(b))>>2)===act)return m;}return null;
}
function legalActs(moves){return[...new Set(moves.map(moveToAct))];}

// ---- Table loading -----------------------------------------------
function loadTable(path, label){
    if(!existsSync(path)){console.error(`Table not found: ${path}`);process.exit(1);}
    const d=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,'')),data=d.table??d;
    const Q=new Map();
    for(const[k,arr]of Object.entries(data)){
        const r=new Float64Array(N_ACTS);
        for(let i=0;i<N_ACTS;i++)r[i]=arr[i]==null?0:arr[i];
        Q.set(k,r);
    }
    console.log(`Loaded ${Q.size} states — ${label}`);
    return Q;
}

const Q_V1 = loadTable(V1_PATH, 'v1 (frozen seat 0)');
const Q_CH = loadTable(CH_PATH, `${LABEL} (challenger seats 1-3)`);

const _fb0 = new SentientBot(); // fallback for v1 unknown states
const _fbC = new SentientBot(); // fallback for challenger unknown states

function greedyMove(Q, s, pid, fb){
    const moves=getPossibleMoves(s),key=encodeStateFor(s,pid),lActs=legalActs(moves);
    const r=Q.get(key);
    if(!r)return fb.chooseMove(s);
    let best=lActs[0],bv=-Infinity;
    for(const a of lActs)if(r[a]>bv){bv=r[a];best=a;}
    return actToMove(moves,best)??moves[0];
}

// ---- Single game -------------------------------------------------
function playGame(){
    let s=createInitialState(N_PLAYERS);
    const qOut=[null,null]; // [0]=v1(seat0), [1]=challenger(seat1)
    let totalMoves=0;

    while(!isGameOver(s)&&totalMoves<STEP_LIMIT){
        const p=s.currentPlayer,moves=getPossibleMoves(s);totalMoves++;
        const conc = p===0 ? greedyMove(Q_V1,s,0,_fb0) : greedyMove(Q_CH,s,p,_fbC);
        const sN=applyMove(s,conc);

        // Track seat 0 (v1)
        if(!qOut[0]&&(sN.eliminated&1)&&!(s.eliminated&1)){
            const ob=pop(s.eliminated&~1);
            qOut[0]=ob===0?'cleared_4p':ob===1?'cleared_3p':'won_2p';
        }
        // Track seat 1 (challenger representative)
        if(!qOut[1]&&(sN.eliminated&2)&&!(s.eliminated&2)){
            const ob=pop(s.eliminated&~2);
            qOut[1]=ob===0?'cleared_4p':ob===1?'cleared_3p':'won_2p';
        }
        s=sN;
    }
    const to=!isGameOver(s);
    if(!qOut[0])qOut[0]=to?'timeout':'lost_2p';
    if(!qOut[1])qOut[1]=to?'timeout':'lost_2p';
    return{v1:qOut[0],ch:qOut[1],totalMoves};
}

// ---- Main loop ---------------------------------------------------
console.log(`\nEval: frozen-v1 (seat 0)  vs  ${LABEL} (seats 1,2,3) — greedy, no learning`);
console.log(`Games: ${GAMES.toLocaleString()}  log-every: ${LOG_EVERY}\n`);

const KEYS=['cleared_4p','cleared_3p','won_2p','lost_2p','timeout'];
const mkCnt=()=>Object.fromEntries(KEYS.map(k=>[k,0]));
const tot_v1=mkCnt(), tot_ch=mkCnt();
const log_v1=mkCnt(), log_ch=mkCnt();
let logN=0,logMoves=0;

for(let g=1;g<=GAMES;g++){
    const{v1,ch,totalMoves}=playGame();
    tot_v1[v1]++;log_v1[v1]++;
    tot_ch[ch]++;log_ch[ch]++;
    logMoves+=totalMoves;logN++;

    if(g%LOG_EVERY===0){
        const pct=(obj,n,k)=>n>0?(obj[k]/n*100).toFixed(1).padStart(5)+'%':'  n/a';
        const row=(lbl,obj,n)=>`    ${lbl.padEnd(22)} clear4P=${pct(obj,n,'cleared_4p')}  clear3P=${pct(obj,n,'cleared_3p')}  win2P=${pct(obj,n,'won_2p')}  lose2P=${pct(obj,n,'lost_2p')}  TO=${pct(obj,n,'timeout')}`;
        console.log(`  game ${String(g).padStart(6)}  avgMoves=${(logMoves/logN).toFixed(1)}`);
        console.log(row('Frozen-v1 (seat0):',log_v1,logN));
        console.log(row(`${LABEL} (seat1):`,log_ch,logN));
        KEYS.forEach(k=>{log_v1[k]=0;log_ch[k]=0;});
        logMoves=0;logN=0;
    }
}

console.log(`\n=== Final Summary (${GAMES} games) ===`);
function printOutcomes(obj,n,label){
    const pf=k=>(obj[k]/n*100).toFixed(1);
    console.log(`  [${label}] n=${n}`);
    console.log(`    Cleared in 4P : ${obj.cleared_4p} (${pf('cleared_4p')}%)`);
    console.log(`    Cleared in 3P : ${obj.cleared_3p} (${pf('cleared_3p')}%)`);
    console.log(`    Won 2P duel   : ${obj.won_2p} (${pf('won_2p')}%)`);
    console.log(`    Lost 2P duel  : ${obj.lost_2p} (${pf('lost_2p')}%)`);
    if(obj.timeout)console.log(`    Timeout       : ${obj.timeout} (${pf('timeout')}%)`);
}
printOutcomes(tot_v1,GAMES,'Frozen-v1 (seat 0)');
printOutcomes(tot_ch,GAMES,`${LABEL} (seats 1-3)`);
console.log(`\n  Interpretation: higher win2P% and lower cleared_4p/3p% for ${LABEL} = improvement over v1`);
