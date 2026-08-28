// v26 - div背景画像も補色化除外版
// - filter方式、背景とテキストは自動で補色化
// - 画像・動画・背景画像(urlを含む)を二重反転で除外
// - MutationObserverはchildListのみ

const FILTER_CSS='filter.css';
const CLASS_FILTER='__toggle_color_theme_active';

async function getOrigin(u){ try{ return new URL(u).origin; }catch{ return u; } }
async function getRemembered(){
  try{
    const d=await chrome.storage.local.get(['rememberedSites']);
    let r=d.rememberedSites; if(!r) return {};
    if(Array.isArray(r)){ const o={}; r.forEach(x=>o[x]='filter'); await chrome.storage.local.set({rememberedSites:o}); return o; }
    return r;
  }catch{ return {}; }
}
async function saveRemembered(o,m){ try{ const s=await getRemembered(); s[o]=m; await chrome.storage.local.set({rememberedSites:s}); }catch{} }
async function removeRemembered(o){ try{ const s=await getRemembered(); delete s[o]; await chrome.storage.local.set({rememberedSites:s}); }catch{} }
async function safeExec(tabId, fn){ if(!tabId) return; try{ await fn(); }catch{} }
async function isExtensionUrl(tabId){
  try{
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || tab.pendingUrl || '';
    return url.startsWith('chrome://')||url.startsWith('edge://')||url.startsWith('about:')||url.startsWith('chrome-extension://');
  }catch{ return false; }
}
async function setBadgeON(tabId){ try{ await chrome.action.setBadgeText({tabId,text:'ON'}); await chrome.action.setBadgeBackgroundColor({tabId,color:'#111'}); }catch{} }
async function setBadgeOFF(tabId){ try{ await chrome.action.setBadgeText({tabId,text:''}); }catch{} }

async function enableFilterMode(tabId){
  if(!tabId) return;
  if(await isExtensionUrl(tabId)) return;
  await safeExec(tabId, async()=>{ try{ await chrome.scripting.removeCSS({target:{tabId}, files:['forced.css']}); }catch{} });
  await safeExec(tabId, async()=>{ await chrome.scripting.insertCSS({target:{tabId}, files:[FILTER_CSS]}); });
  await safeExec(tabId, async()=>{
    await chrome.scripting.executeScript({
      target:{tabId},
      func:(cf)=>{
        const html=document.documentElement;
        if(html.dataset.__toggle_enabled==='1' && html.classList.contains(cf)) return;
        html.classList.add(cf);
        html.dataset.__toggle_enabled='1';

        const MEDIA_SEL = 'img, picture, video, iframe';

        const hasBgImage = (el) => {
          try{
            if(!(el instanceof HTMLElement)) return false;
            const bg = getComputedStyle(el).backgroundImage;
            return bg && bg !== 'none' && bg.includes('url(');
          }catch{ return false; }
        };

        const restore = (el, cls) => {
          try{
            if(!el || !el.style) return;
            if(cls && el.classList.contains(cls)) return;
            el.style.setProperty('filter','invert(1) hue-rotate(180deg)','important');
            el.style.setProperty('-webkit-filter','invert(1) hue-rotate(180deg)','important');
            if(cls) el.classList.add(cls);
          }catch{}
        };

        const fixMedia = (root) => {
          try{
            if(root instanceof HTMLElement){
              if(root.matches && root.matches(MEDIA_SEL)){
                restore(root, root.tagName==='IFRAME' ? '__preserve-iframe' : '__preserve-img');
              } else if(hasBgImage(root)){
                restore(root, '__has-bg-img');
              }
            }
            const list = root.querySelectorAll ? root.querySelectorAll(MEDIA_SEL) : [];
            for(let i=0;i<list.length;i++){
              restore(list[i], list[i].tagName==='IFRAME' ? '__preserve-iframe' : '__preserve-img');
            }
            // div背景画像も保護
            const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for(let i=0;i<all.length;i++){
              const el = all[i];
              if(el.matches && el.matches(MEDIA_SEL)) continue;
              if(hasBgImage(el)){
                restore(el, '__has-bg-img');
              }
            }
          }catch{}
        };

        fixMedia(document);

        if(window.__toggleObserver){ try{ window.__toggleObserver.disconnect(); }catch{} }
        let pending=false;
        const obs=new MutationObserver((muts)=>{
          if(html.dataset.__toggle_enabled!=='1'){ obs.disconnect(); return; }
          if(pending) return;
          pending=true;
          requestAnimationFrame(()=>{
            pending=false;
            if(html.dataset.__toggle_enabled!=='1') return;
            for(const mut of muts){
              if(mut.type==='childList'){
                for(const node of mut.addedNodes){
                  if(!(node instanceof HTMLElement)) continue;
                  fixMedia(node);
                }
              }
            }
          });
        });
        obs.observe(document.documentElement, {childList:true, subtree:true});
        window.__toggleObserver=obs;

        window.addEventListener('pageshow', ()=>{
          if(html.dataset.__toggle_enabled==='1') fixMedia(document);
        });
      },
      args:[CLASS_FILTER]
    });
  });
}

async function disableAll(tabId){
  if(!tabId) return;
  await safeExec(tabId, async()=>{ try{ await chrome.scripting.removeCSS({target:{tabId}, files:[FILTER_CSS,'forced.css']}); }catch{} });
  await safeExec(tabId, async()=>{
    await chrome.scripting.executeScript({
      target:{tabId},
      func:(cf)=>{
        const html=document.documentElement;
        try{ if(window.__toggleObserver){ try{ window.__toggleObserver.disconnect(); }catch{} window.__toggleObserver=null; } }catch{}
        html.dataset.__toggle_enabled='0';
        html.classList.remove(cf);
        try{
          document.querySelectorAll('.__preserve-img, .__preserve-iframe, .__has-bg-img').forEach(el=>{
            el.style.removeProperty('filter');
            el.style.removeProperty('-webkit-filter');
            el.classList.remove('__preserve-img');
            el.classList.remove('__preserve-iframe');
            el.classList.remove('__has-bg-img');
          });
        }catch{}
      },
      args:[CLASS_FILTER]
    });
  });
}

chrome.action.onClicked.addListener(async(tab)=>{
  try{
    if(!tab?.id||!tab?.url) return;
    if(tab.url.startsWith('chrome://')||tab.url.startsWith('edge://')||tab.url.startsWith('about:')||tab.url.startsWith('chrome-extension://')) return;
    const origin=await getOrigin(tab.url);
    const remembered=await getRemembered();
    if(remembered[origin]){
      await disableAll(tab.id); await removeRemembered(origin);
      await setBadgeOFF(tab.id);
    }else{
      await enableFilterMode(tab.id);
      await saveRemembered(origin,'filter');
      await setBadgeON(tab.id);
    }
  }catch{}
});

async function autoApply(tabId,url){
  try{
    if(!tabId||!url) return;
    if(url.startsWith('chrome://')||url.startsWith('edge://')||url.startsWith('about:')||url.startsWith('chrome-extension://')) return;
    const origin=await getOrigin(url);
    const remembered=await getRemembered();
    let mode=remembered[origin];
    if(!mode){
      const k=Object.keys(remembered).find(k=>url.startsWith(k));
      if(!k){ await setBadgeOFF(tabId); return; }
      mode=remembered[k];
    }
    await enableFilterMode(tabId);
    await setBadgeON(tabId);
  }catch{}
}

chrome.tabs.onUpdated.addListener((tabId,ci,tab)=>{ try{ if((ci.status==='loading'||ci.status==='complete')&&tab?.url) autoApply(tabId,tab.url).catch(()=>{}); }catch{} });
chrome.webNavigation?.onCommitted?.addListener((d)=>{ try{ if(d.frameId===0&&d.tabId&&d.url) autoApply(d.tabId,d.url).catch(()=>{}); }catch{} });
chrome.tabs.onActivated?.addListener(async (activeInfo)=>{
  try{ const tab = await chrome.tabs.get(activeInfo.tabId); if(tab?.url) autoApply(activeInfo.tabId, tab.url).catch(()=>{}); }catch{}
});
chrome.runtime.onStartup?.addListener(async ()=>{
  try{ const tabs = await chrome.tabs.query({}); for(const t of tabs){ if(t.id && t.url) autoApply(t.id, t.url); } }catch{}
});

chrome.runtime.onInstalled.addListener(async()=>{
});
