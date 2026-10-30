// Options.js - オプション画面
// - ON したウェブサイトの一覧表示 / 新規登録 / 個別削除
// - 疑似ブックマークの保存フォルダの選択
// - 変更内容を「疑似ブックマーク」として保存フォルダへ保存する
//   （変更時・画面を閉じるときの2段階で保存を試みる）
//
// 保存処理は Background.js へメッセージで依頼する（画面が閉じられる際も
// Background 側で保存が継続できるようにするため）。渡せなかった場合のみ
// この画面自身が保存する。

let tctSettings = null;        // 編集中の設定
let tctStoredFolderId = null;  // 読み込み時点（＝保存済み）の保存フォルダ
let tctFolderMissing = false;  // 保存済みフォルダが見つからない
let tctFolderListFailed = false; // フォルダ一覧を取得できなかった
let tctDirty = false;          // 未保存の変更があるか
let tctSaving = false;
let tctPendingSave = false;
let tctSaveTimer = null;

const tctEl = id => document.getElementById(id);

function tctMsg(key){
  try{ return chrome.i18n.getMessage(key) || ''; }
  catch{ return ''; }
}

function tctApplyI18n(){
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const v = tctMsg(el.getAttribute('data-i18n')); if(v) el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>{
    const v = tctMsg(el.getAttribute('data-i18n-placeholder')); if(v) el.placeholder = v;
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el=>{
    const v = tctMsg(el.getAttribute('data-i18n-title')); if(v) el.title = v;
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el=>{
    const v = tctMsg(el.getAttribute('data-i18n-aria-label')); if(v) el.setAttribute('aria-label', v);
  });
  const title = tctMsg('optPageTitle'); if(title) document.title = title;
}

function tctSetStatus(kind, detail){
  const el = tctEl('status');
  let text = '';
  switch(kind){
    case 'saving':       text = tctMsg('optSaving'); break;
    case 'loaded':       text = tctMsg('optLoaded'); break;
    case 'saved':        text = tctMsg('optSaved'); break;
    case 'saved-nofolder': text = tctMsg('optSavedNoFolder'); break;
    case 'dirty':        text = tctMsg('optDirty'); break;
    case 'invalid':      text = tctMsg('optInvalidUrl'); break;
    case 'duplicate':    text = tctMsg('optDuplicate'); break;
    case 'folder-missing': text = tctMsg('optFolderMissing'); break;
    case 'folder-error': text = tctMsg('optFolderLoadFailed'); break;
    case 'error':        text = tctMsg('optSaveFailed') + ' ' + (detail || ''); break;
    default:             text = ''; break;
  }
  el.textContent = text;
  el.className = 'status' + (kind==='error' ? ' error' : (kind==='saved'||kind==='saved-nofolder' ? ' ok' : ''));
}

// 設定を読み込む（正本は保存フォルダの疑似ブックマーク、無ければ storage のキャッシュ）
async function tctLoadSettings(){
  try{
    const s = await tctLoadSettingsFromBookmarks();
    if(s) return s;
  }catch(e){ console.warn('TCT: failed to read pseudo bookmarks', e); }
  return await tctGetStoredSettings();
}

async function tctRenderFolders(){
  const select = tctEl('folderSelect');
  let list = [];
  tctFolderListFailed = false;
  try{ list = await tctListFolders(); }
  catch(e){ console.warn('TCT: failed to read folder list', e); list = []; tctFolderListFailed = true; }
  if(!Array.isArray(list)) list = [];

  const currentId = (tctSettings && tctSettings.storageFolderId) ? String(tctSettings.storageFolderId) : '';
  select.innerHTML = '';

  const none = document.createElement('option');
  none.value = '';
  none.textContent = tctMsg('optFolderNone') || '（保存フォルダ未選択）';
  select.appendChild(none);

  let found = false;
  const ownContainerId = (tctSettings && tctSettings.storageContainerId) ? String(tctSettings.storageContainerId) : '';
  for(const f of list){
    // 当拡張機能が作るコンテナフォルダは保存先候補から外す（選択中の場合は除く）
    if(ownContainerId && f.id === ownContainerId && f.id !== currentId) continue;
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = '　'.repeat(f.depth) + f.title;
    if(f.id === currentId) found = true;
    select.appendChild(o);
  }

  tctFolderMissing = !!(currentId && !found);
  if(tctFolderMissing){
    const o = document.createElement('option');
    o.value = currentId;
    o.textContent = currentId + ' ' + (tctMsg('optFolderMissingLabel') || '（見つかりません）');
    select.appendChild(o);
  }
  select.value = currentId;
}

function tctRenderSites(){
  const list = tctEl('siteList');
  list.innerHTML = '';
  const sites = (tctSettings && Array.isArray(tctSettings.sites)) ? tctSettings.sites : [];
  tctEl('emptySites').hidden = sites.length > 0;

  for(const site of sites){
    const li = document.createElement('li');

    const span = document.createElement('span');
    span.className = 'site-url';
    span.textContent = site;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = tctMsg('optDelete') || '削除';
    btn.addEventListener('click', ()=>{
      tctSettings.sites = tctSettings.sites.filter(s => s !== site);
      tctRenderSites();
      tctMarkDirty();
    });

    li.appendChild(span);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function tctAddSite(){
  const input = tctEl('siteInput');
  const origin = tctNormalizeSite(input.value);
  if(!origin){ tctSetStatus('invalid'); input.focus(); return; }
  if(tctSettings.sites.includes(origin)){ tctSetStatus('duplicate'); input.select(); return; }
  tctSettings.sites = tctSettings.sites.concat([origin]);
  input.value = '';
  tctRenderSites();
  tctMarkDirty();
}

// 変更があったら未保存として印を付け、少し待ってから自動保存する
function tctMarkDirty(){
  tctDirty = true;
  tctSetStatus('dirty');
  clearTimeout(tctSaveTimer);
  tctSaveTimer = setTimeout(()=>{ tctDoSave(); }, 200);
}

async function tctSendSave(settings){
  let res = null;
  try{ res = await chrome.runtime.sendMessage({ type: TCT_SAVE_MESSAGE, settings }); }
  catch(e){ res = null; }
  if(res && res.ok) return res.settings;
  if(res && res.ok === false) throw new Error(res.error || 'unknown error');
  // Background へ渡せなかった場合は、この画面自身で保存を試みる
  return await tctSaveSettingsToBookmarks(settings);
}

async function tctDoSave(){
  clearTimeout(tctSaveTimer);
  if(!tctSettings) return;
  if(tctSaving){ tctPendingSave = true; return; } // 保存中なら完了後にまとめて再実行
  tctSaving = true;
  tctDirty = false;
  tctSetStatus('saving');
  try{
    const saved = await tctSendSave(tctSettings);
    tctStoredFolderId = (saved && saved.storageFolderId) || null;
    tctSetStatus(tctStoredFolderId ? 'saved' : 'saved-nofolder');
  }catch(e){
    tctDirty = true; // 未保存のまま残す（閉じるときにもう一度試みる）
    tctSetStatus('error', (e && e.message) || String(e));
  }finally{
    tctSaving = false;
    if(tctPendingSave){
      tctPendingSave = false;
      if(tctDirty) tctDoSave();
    }
  }
}

function tctFlush(){
  // 画面を閉じるとき: 未保存の変更（保存フォルダの変更を含む）を保存フォルダへ保存する。
  // 画面自身は破棄される可能性があるため、まず Background へ依頼し、
  // 渡せなかった場合のみこの画面から直接保存する。
  if(!tctSettings || (!tctDirty && !tctSaving)) return;
  clearTimeout(tctSaveTimer);
  const snapshot = tctSettings;
  tctDirty = false;
  tctSetStatus('saving');

  const onOk = saved=>{
    if(saved && saved.storageFolderId) tctStoredFolderId = saved.storageFolderId;
    tctSetStatus(tctStoredFolderId ? 'saved' : 'saved-nofolder');
  };
  const onFail = ()=>{ tctDirty = true; tctSetStatus('error', ''); };
  const direct = ()=>{ tctSaveSettingsToBookmarks(snapshot).then(onOk).catch(onFail); };

  try{
    const p = chrome.runtime.sendMessage({ type: TCT_SAVE_MESSAGE, settings: snapshot });
    if(p && typeof p.then === 'function'){
      p.then(res=>{
        if(res && res.ok) onOk(res.settings);
        else if(res && res.ok === false) onFail();
        else direct();
      }).catch(direct);
    }else{ direct(); }
  }catch{ direct(); }
}

// 読み込み直後などの表示用ステータス
function tctInitStatus(){
  if(tctFolderMissing) tctSetStatus('folder-missing');
  else if(tctFolderListFailed) tctSetStatus('folder-error');
  else if(tctSettings && tctSettings.storageFolderId) tctSetStatus('loaded');
  else tctSetStatus('saved-nofolder');
}

async function tctInit(){
  tctApplyI18n();
  try{ tctSettings = await tctLoadSettings(); }
  catch(e){ console.warn(e); tctSettings = await tctGetStoredSettings(); }
  tctSettings.sites = Array.isArray(tctSettings.sites) ? tctSettings.sites : [];
  tctStoredFolderId = tctSettings.storageFolderId;

  await tctRenderFolders();
  tctRenderSites();
  tctInitStatus();

  tctEl('folderSelect').addEventListener('change', (e)=>{
    tctSettings.storageFolderId = e.target.value || null;
    tctMarkDirty(); // 変更後のフォルダへ移す処理は保存時に実行される
  });
  tctEl('folderReload').addEventListener('click', async ()=>{
    await tctRenderFolders();
    if(!tctDirty) tctInitStatus();
  });
  tctEl('addSite').addEventListener('click', tctAddSite);
  tctEl('siteInput').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){ e.preventDefault(); tctAddSite(); }
  });
  tctEl('saveNow').addEventListener('click', ()=>{ tctDirty = true; tctDoSave(); });

  window.addEventListener('pagehide', tctFlush);
  document.addEventListener('visibilitychange', ()=>{ if(document.hidden) tctFlush(); });
}

document.addEventListener('DOMContentLoaded', tctInit);
