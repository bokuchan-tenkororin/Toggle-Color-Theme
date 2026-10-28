// v27 - パリティ管理版
// - ページ全体(html)に1回だけ補色化し、Page.js が各要素の「反転回数の偶奇」を
//   管理して画像・動画・背景画像が常に元の色になるよう補正する
// - 補正ロジックは Page.js に集約（Background.js は注入とイベント管理のみ）
// - MutationObserver は childList + attributes、10秒周期の再走査も実施
// - 記憶(rememberedSites)は「オリジン完全一致」でのみ判定する
//   （旧実装の文字列プレフィックス一致は https://gemini.google で ON にすると
//     https://gemini.google.com まで有効扱きになり、オフに戻せなくなる原因だった）

const FILTER_CSS='Filter.css';

// URL → オリジン文字列（URL として解析できない場合は入力をそのまま返す）
const originOf = u => { try{ return new URL(u).origin; }catch{ return u; } };
// 指定オリジンが記憶済み(=有効)かどうかを判定する。
// 同一オリジンで完全一致したものだけを有効とし、
// "https://gemini.google" が "https://gemini.google.com/..." を
// 誤って含むような文字列接頭辞一致は行わない。
function matchedRememberedKey(origin, remembered){
  for(const k of Object.keys(remembered)) if(originOf(k)===origin) return k;
  return null;
}
async function getRemembered(){
  try{
    const d=await chrome.storage.local.get(['rememberedSites']);
    let r=d.rememberedSites; if(!r) return {};
    if(Array.isArray(r)){ const o={}; r.forEach(x=>o[x]='filter'); await chrome.storage.local.set({rememberedSites:o}); return o; }
    return r;
  }catch{ return {}; }
}
async function saveRemembered(o,m){ try{ const s=await getRemembered(); s[o]=m; await chrome.storage.local.set({rememberedSites:s}); }catch{} }
// 指定オリジンに紐づく記憶をすべて削除する（同一オリジン分は必ず消す）
async function removeRemembered(origin){ try{ const s=await getRemembered(); let c=false; for(const k of Object.keys(s)) if(originOf(k)===origin){ delete s[k]; c=true; } if(c) await chrome.storage.local.set({rememberedSites:s}); }catch{} }
// ページ上でフィルタが実際に有効かを返す。true=反転中 / false=無効 / null=読み取れなかった
async function readPageState(tabId){
  try{
    const [r]=await chrome.scripting.executeScript({
      target:{tabId},
      func:()=>{ const h=document.documentElement; return !!(h&&(h.hasAttribute('data-tct-on')||h.classList.contains('__toggle_color_theme_active'))); }
    });
    return (r&&typeof r.result==='boolean')?r.result:null;
  }catch{ return null; }
}
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
    const origin=originOf(tab.url);
    const remembered=await getRemembered();
    const key=matchedRememberedKey(origin,remembered);
    // 「ON扱い」の条件 = ページ上で実際に反転している または サイトが記憶されている。
    // どちらか一方でも成立したらオフ側へ回すので、
    // ページ表示と記憶がずれている状態(本バグの再発条件)でも
    // 一度のクリックで確実にオフへ戻せる。
    // どちらも無ければ「未記憶=オフ状態」なので従来どおりオンにする。
    const onPage=await readPageState(tab.id);
    if(onPage===true||key){
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
    const origin=originOf(url);
    const remembered=await getRemembered();
    // オリジンの完全一致のみで判定（url.startsWith の接頭辞一致は不可:
    // https://gemini.google の記憶が https://gemini.google.com を
    // 誤って含んでオフに戻せなくなるため）
    const key=matchedRememberedKey(origin,remembered);
    if(!key){
      // 記憶が無くてもフィルタが残っているタブ(別タブでサイトごとにオフにした等)は、
      // バッジが ON の間だけ実際に反転しているかを確認して解除し、表示と記憶を一致させる
      try{
        const t=await chrome.action.getBadgeText({tabId});
        if(t==='ON'&&await readPageState(tabId)===true) await disableAll(tabId);
      }catch{}
      await setBadgeOFF(tabId); return;
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
