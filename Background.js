// v27 - パリティ管理版
// - ページ全体(html)に1回だけ補色化し、Page.js が各要素の「反転回数の偶奇」を
//   管理して画像・動画・背景画像が常に元の色になるよう補正する
// - 補正ロジックは Page.js に集約（Background.js は注入とイベント管理のみ）
// - MutationObserver は childList + attributes、10秒周期の再走査も実施

const FILTER_CSS='Filter.css';

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

// ページに Page.js を読み込んでコマンドを実行する
async function runPageScript(tabId, command){
  await safeExec(tabId, async()=>{ await chrome.scripting.executeScript({target:{tabId}, files:['Page.js']}); });
  await safeExec(tabId, async()=>{
    await chrome.scripting.executeScript({
      target:{tabId},
      func:(cmd)=>{ try{ if(window.__tct) window.__tct[cmd](); }catch{} },
      args:[command]
    });
  });
}

async function enableFilterMode(tabId){
  if(!tabId) return;
  if(await isExtensionUrl(tabId)) return;
  await safeExec(tabId, async()=>{ await chrome.scripting.insertCSS({target:{tabId}, files:[FILTER_CSS]}); });
  await runPageScript(tabId, 'enable');
}

async function disableAll(tabId){
  if(!tabId) return;
  await runPageScript(tabId, 'disable');
  await safeExec(tabId, async()=>{ try{ await chrome.scripting.removeCSS({target:{tabId}, files:[FILTER_CSS]}); }catch{} });
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
    const enabled = !!remembered[origin] || Object.keys(remembered).some(k=>url.startsWith(k));
    if(!enabled){ await setBadgeOFF(tabId); return; }
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
