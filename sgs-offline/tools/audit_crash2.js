const path=require('path');const base=path.join(__dirname,'..','js');
['skilldesc','data','game','cards','skills','ai'].forEach(f=>require(path.join(base,f+'.js')));
const SGS=globalThis.SGS;
(async()=>{
  const g=new SGS.Game({mode:'8p',seed:7001,cardPack:'full',humanSeat:-1,onUpdate(){}});
  const agents=[];for(let i=0;i<8;i++)agents.push(new SGS.AI(g,i,{speed:0}));
  g.agents=agents;
  let lastAct=null;
  const origExec=g.executeAction.bind(g);
  g.executeAction=async(p,act)=>{
    lastAct={p:p.general.name,act:JSON.parse(JSON.stringify({kind:act.kind,skill:act.skill,as:act.as,subcards:act.subcards,targets:act.targets}))};
    await origExec(p,act);
    const bad=g.players.map((q,si)=>({si,name:q.general.name,i:q.hand.findIndex(c=>!c)})).filter(x=>x.i>=0);
    if(bad.length){console.log('BAD after action',JSON.stringify(lastAct),'players',JSON.stringify(bad));console.log(g.logs.slice(-15).map(l=>l.text).join('\n'));process.exit(0);}
  };
  const origFA=g.resolveFireAttack.bind(g);
  g.resolveFireAttack=async(p,vc,t)=>{
    const bad=p.hand.findIndex(c=>!c);
    if(bad>=0){console.log('BAD at fireattack',p.general.name,bad,JSON.stringify(lastAct));console.log(g.logs.slice(-20).map(l=>l.text).join('\n'));process.exit(0);}
    return origFA(p,vc,t);
  };
  try{await g.start();console.log('no bad hand');}catch(e){console.log('CRASH',e.message);console.log('lastAct',JSON.stringify(lastAct));console.log(g.logs.slice(-25).map(l=>l.text).join('\n'));}
})();
