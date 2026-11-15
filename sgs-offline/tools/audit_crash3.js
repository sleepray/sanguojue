const path=require('path');const base=path.join(__dirname,'..','js');
['skilldesc','data','game','cards','skills','ai'].forEach(f=>require(path.join(base,f+'.js')));
const SGS=globalThis.SGS;
(async()=>{
  const g=new SGS.Game({mode:'8p',seed:7001,cardPack:'full',humanSeat:-1,onUpdate(){}});
  const agents=[];for(let i=0;i<8;i++)agents.push(new SGS.AI(g,i,{speed:0}));
  g.agents=agents;
  let prev=[];
  const origLog=g.log.bind(g);
  g.log=(text,type)=>{
    const bad=g.players.map(p=>({name:p.general.name,i:p.hand.findIndex(c=>!c)})).filter(x=>x.i>=0);
    if(bad.length){
      console.log('FIRST BAD at log:',text,'| players',JSON.stringify(bad));
      console.log('--- last 15 logs ---');console.log(prev.slice(-15).join('\n'));
      process.exit(0);
    }
    prev.push(text); if(prev.length>40)prev.shift();
    return origLog(text,type);
  };
  try{await g.start();console.log('no bad hand');}catch(e){console.log('CRASH',e.message);console.log(prev.slice(-20).join('\n'));}
})();
