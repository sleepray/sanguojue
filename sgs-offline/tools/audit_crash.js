/* 只读：定位手牌中的 undefined 来源 */
const path=require('path');const base=path.join(__dirname,'..','js');
['skilldesc','data','game','cards','skills','ai'].forEach(f=>require(path.join(base,f+'.js')));
const SGS=globalThis.SGS;
async function run(seed){
  const g=new SGS.Game({mode:'8p',seed,cardPack:'full',humanSeat:-1,onUpdate(){}});
  const agents=[];for(let i=0;i<8;i++)agents.push(new SGS.AI(g,i,{speed:0}));
  g.agents=agents;
  let found=null;
  const origEmit=g.emit.bind(g);
  g.emit=()=>{
    if(found)return;
    for(const p of g.players){const i=p.hand.findIndex(c=>!c);if(i>=0){found={p,idx:i,logs:g.logs.slice(-25).map(l=>l.text)};break;}}
    if(!found)origEmit();
  };
  await g.start();
  return found;
}
(async()=>{
  for(let seed=7000;seed<7040;seed++){
    let f=null;
    try{f=await run(seed);}catch(e){console.log('crash seed',seed,e.message);}
    if(f){console.log('FOUND seed',seed,'player',f.p.name,'handIdx',f.idx,'general',f.p.general.name);console.log(f.logs.join('\n'));return;}
  }
  console.log('no undefined found');
})();
