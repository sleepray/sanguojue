#!/usr/bin/env python3
"""生成 Service Worker 缓存清单（离线可玩）。"""
import os, json, hashlib
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
files=['index.html','manifest.webmanifest','css/style.css']
for d in ['js','assets/icons','assets/cards','assets/seat','assets/big','assets/audio','assets/dragon']:
    base=os.path.join(ROOT,d)
    for dirpath,_,names in os.walk(base):
        for n in names:
            if n.startswith('.'): continue
            p=os.path.relpath(os.path.join(dirpath,n),ROOT).replace(os.sep,'/')
            files.append(p)
files=sorted(set(files))
# 用 index.html 的 md5 前 8 位做缓存版本；资源变化时重新生成
h=hashlib.md5(open(os.path.join(ROOT,'index.html'),'rb').read()).hexdigest()[:8]
js=f'''/* 自动生成：{h} */
const CACHE='sgs-offline-{h}';
const CORE={json.dumps(files,ensure_ascii=False)};
self.addEventListener('install',e=>{{
  e.waitUntil((async()=>{{
    const c=await caches.open(CACHE);
    for(let i=0;i<CORE.length;i+=25){{
      await Promise.allSettled(CORE.slice(i,i+25).map(u=>c.add(u)));
    }}
    self.skipWaiting();
  }})());
}});
self.addEventListener('activate',e=>{{
  e.waitUntil((async()=>{{
    for(const k of await caches.keys()) if(k!==CACHE) await caches.delete(k);
    await self.clients.claim();
  }})());
}});
self.addEventListener('fetch',e=>{{
  const req=e.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  if(url.origin!==location.origin) return;
  const dynamic=/\\.(?:html|js|css|webmanifest)$/.test(url.pathname)||req.mode==='navigate';
  if(req.mode==='navigate'){{
    e.respondWith(fetch(req).then(r=>{{const cp=r.clone();caches.open(CACHE).then(c=>c.put('index.html',cp));return r;}}).catch(()=>caches.match('index.html')));
    return;
  }}
  if(dynamic){{
    e.respondWith(fetch(req).then(r=>{{if(r.ok){{const cp=r.clone();caches.open(CACHE).then(c=>c.put(req,cp));}}return r;}}).catch(()=>caches.match(req)));
    return;
  }}
  e.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(r=>{{if(r.ok){{const cp=r.clone();caches.open(CACHE).then(c=>c.put(req,cp));}}return r;}})));
}});
'''
open(os.path.join(ROOT,'sw.js'),'w',encoding='utf-8').write(js)
print('sw.js',len(files),'files, cache',h)
