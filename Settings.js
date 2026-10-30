// Settings.js
// - オプションの設定を「疑似ブックマーク」として保存・読み込みする共通ロジック
// - Background.js からは importScripts('Settings.js') で読み込む
// - Options.html からは <script src="Settings.js"> で読み込む
//
// 疑似ブックマークの保存構造（ユーザが選択した保存フォルダの直下）:
//
//   保存フォルダ/
//     └── [Toggle Color Theme 設定]        … 自動作成するコンテナフォルダ
//           ├── タイトル: 設定のJSON / URL: オプションページ
//           │     … オプションの設定一式（保存フォルダの設定を含む）
//           ├── タイトル: https://a.example / URL: https://a.example
//           └── タイトル: https://b.example / URL: https://b.example
//                 … ON したウェブサイト（1サイト = 1疑似ブックマーク）
//
// ウェブページを開くためのブックマークではなく、あくまで設定を保存するための
// 疑似ブックマークとして扱う。保存フォルダを変更したときは、変更前のフォルダから
// コンテナフォルダごと削除し、変更後のフォルダへ作り直す。

const TCT_CONTAINER_NAME = 'Toggle Color Theme 設定';
const TCT_SETTINGS_VERSION = 1;
const TCT_DEFAULT_SETTINGS = {
  version: TCT_SETTINGS_VERSION,
  storageFolderId: null,   // 設定を保存するブックマークフォルダのID
  storageContainerId: null, // 保存フォルダ直下に作ったコンテナフォルダのID
  sites: []                 // ON したウェブサイト（オリジン文字列）
};
// Background.js / Options.js 間で使うメッセージ種別
const TCT_SAVE_MESSAGE = 'tct-save-settings';
const TCT_GET_MESSAGE = 'tct-get-settings';

// オプションページのURL（設定を格納する疑似ブックマークのURLにも使う）
function tctSettingsPageUrl(){
  try{ return chrome.runtime.getURL('Options.html'); }
  catch{ return 'Options.html'; }
}

// 任意の入力（"example.com", "https://example.com/path" 等）をオリジンに正規化する。
// 正しくは URL として解釈できなければ null を返す。
function tctNormalizeSite(input){
  if(input===null||input===undefined) return null;
  let s = String(input).trim();
  if(!s) return null;
  // スキームが無ければ https:// を補う（"localhost:3000" 等も扱えるようにするため
  // "://" の有無で判定する。":" のみでは URL スキームと誤認してしまう）
  if(!/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(s)) s = 'https://' + s;
  try{
    const u = new URL(s);
    const origin = u.origin;
    if(!origin || origin==='null') return null;
    return origin;
  }catch{ return null; }
}

function tctCleanId(v){
  if(v===null||v===undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// 設定オブジェクトを保存可能な形に整える（未知の設定もそのまま保持する）
function tctSanitizeSettings(raw){
  const src = (raw && typeof raw==='object' && !Array.isArray(raw)) ? raw : {};
  const out = {};
  for(const k of Object.keys(src)){
    if(k.indexOf('__')===0) continue; // プロトタイプ汚染のおそれのあるキーは無視
    out[k] = src[k];
  }
  out.version = TCT_SETTINGS_VERSION;
  out.storageFolderId = tctCleanId(src.storageFolderId);
  out.storageContainerId = tctCleanId(src.storageContainerId);
  const sites = Array.isArray(src.sites) ? src.sites : [];
  out.sites = [...new Set(sites.map(s=>tctNormalizeSite(s)).filter(Boolean))];
  return out;
}

// 旧形式(rememberedSites のみ)からサイト一覧を作る
function tctSitesFromRemembered(r){
  if(!r) return [];
  if(Array.isArray(r)) return r.slice();
  if(typeof r==='object') return Object.keys(r);
  return [];
}

// chrome.storage.local から設定を読む（疑似ブックマークの読み込み前/失敗時の代替）
async function tctGetStoredSettings(){
  try{
    const d = await chrome.storage.local.get(['tctSettings','rememberedSites']);
    // 保存された設定が無ければ既定値から始める（旧形式は rememberedSites から移行）
    const hasStored = !!(d.tctSettings && typeof d.tctSettings==='object');
    const raw = hasStored ? d.tctSettings : TCT_DEFAULT_SETTINGS;
    const sites = (hasStored && Array.isArray(raw.sites)) ? raw.sites : tctSitesFromRemembered(d.rememberedSites);
    return tctSanitizeSettings(Object.assign({}, raw, {sites}));
  }catch{ return tctSanitizeSettings(TCT_DEFAULT_SETTINGS); }
}

// 設定を chrome.storage.local へ保存する（background が高速に参照するためのキャッシュ。
// 正本は疑似ブックマーク）
async function tctPutStoredSettings(settings){
  const clean = tctSanitizeSettings(settings);
  const remembered = {};
  for(const site of clean.sites) remembered[site] = 'filter';
  await chrome.storage.local.set({ tctSettings: clean, rememberedSites: remembered });
  return clean;
}

// サイト一覧だけを storage へ同期する（ツールバーのON/OFF操作用）
async function tctSyncStoredSites(sites){
  try{
    const cur = await tctGetStoredSettings();
    cur.sites = Array.isArray(sites) ? sites : [];
    return await tctPutStoredSettings(cur);
  }catch{ return null; }
}

async function tctReadFolder(folderId){
  if(!folderId) return null;
  try{
    const a = await chrome.bookmarks.getSubTree(String(folderId));
    return (a && a[0]) ? a[0] : null;
  }catch{ return null; }
}

// そのノードが「設定」を格納する疑似ブックマークかを判定する
function tctIsSettingsNode(node){
  if(!node || typeof node.title!=='string') return false;
  if(node.url && node.url===tctSettingsPageUrl()) return true;
  try{
    const j = JSON.parse(node.title);
    return !!(j && typeof j==='object' && !Array.isArray(j) &&
      ('sites' in j || 'storageFolderId' in j || 'version' in j));
  }catch{ return false; }
}
function tctParseSettingsNode(node){
  try{
    const j = JSON.parse(node.title);
    return (j && typeof j==='object' && !Array.isArray(j)) ? j : null;
  }catch{ return null; }
}

// コンテナフォルダそのものである根拠（設定ブックマーク or サイト疑似ブックマークの存在）。
// 同名のユーザーフォルダを誤って削除しないようにするため使用する。
function tctHasContainerEvidence(node){
  const kids = (node && node.children) || [];
  if(kids.some(k=>tctIsSettingsNode(k))) return true;
  return kids.some(k=>k.url && k.url===k.title && /^https?:/.test(k.url));
}

// 保存フォルダ直下から当拡張機能のコンテナフォルダを見つける
function tctFindContainer(folderNode, hintId){
  const kids = (folderNode && folderNode.children) || [];
  if(hintId){
    const h = kids.find(k=>k.id===hintId);
    if(h) return h;
  }
  const c = kids.find(k=>!k.url && k.title===TCT_CONTAINER_NAME);
  if(c && tctHasContainerEvidence(c)) return c;
  return null;
}

// 保存フォルダから設定を読み込む。
// 読み込めなかった（フォルダ未設定・フォルダ削除済み等）場合は null。
async function tctLoadSettingsFromBookmarks(){
  const stored = await tctGetStoredSettings();
  const folderId = stored.storageFolderId;
  if(!folderId) return null;
  const folder = await tctReadFolder(folderId);
  if(!folder) return null;
  const container = tctFindContainer(folder, stored.storageContainerId);
  if(!container) return null;

  const kids = container.children || [];
  let parsed = null;
  const siteUrls = [];
  for(const n of kids){
    if(tctIsSettingsNode(n)){
      const j = tctParseSettingsNode(n);
      if(j) parsed = j;
    }else if(n.url){
      siteUrls.push(n.url);
    }
  }

  // サイト一覧は個別の疑似ブックマークを優先し、それが無ければ設定JSONのsitesを使う。
  // さらにそれも無ければ storage のキャッシュで補う。
  let sites;
  if(siteUrls.length>0) sites = siteUrls;
  else if(parsed && Array.isArray(parsed.sites)) sites = parsed.sites;
  else if(!parsed) sites = stored.sites;
  else sites = [];

  const merged = Object.assign({}, stored, parsed || {}, {
    storageFolderId: folderId,
    storageContainerId: container.id,
    sites
  });
  return tctSanitizeSettings(merged);
}

// 保存フォルダ直下のコンテナフォルダを取得（無ければ作成する）
async function tctEnsureContainer(folderId, hintId){
  const folder = await tctReadFolder(folderId);
  if(!folder) throw new Error('保存フォルダが見つかりません ('+folderId+')');
  const found = tctFindContainer(folder, hintId);
  if(found) return found.id;
  try{
    const created = await chrome.bookmarks.create({ parentId: folder.id, title: TCT_CONTAINER_NAME });
    return created.id;
  }catch(e){ throw new Error('保存フォルダに書き込めません: '+((e&&e.message)||e)); }
}

// コンテナフォルダの中身を設定に合わせて差分更新する。
//  - 設定ブックマーク: JSON（保存フォルダの設定を含むオプション設定一式）を更新
//  - サイト疑似ブックマーク: 不要分を削除し、不足分を作成する
async function tctSyncContainer(containerId, payload){
  const node = await tctReadFolder(containerId);
  const kids = (node && node.children) || [];
  const settingsNode = kids.find(k=>tctIsSettingsNode(k)) || null;
  const json = JSON.stringify(payload);
  const settingsUrl = tctSettingsPageUrl();

  if(settingsNode){
    await chrome.bookmarks.update(settingsNode.id, { title: json, url: settingsUrl });
  }else{
    await chrome.bookmarks.create({ parentId: containerId, title: json, url: settingsUrl });
  }

  const want = new Set(payload.sites);
  const seen = new Set();
  for(const k of kids){
    if(tctIsSettingsNode(k)) continue;
    if(!k.url) continue; // 中に入れたフォルダ等には触れない
    // 不要になったサイト、および重複した疑似ブックマークを削除する
    if(!want.has(k.url) || seen.has(k.url)){
      try{ await chrome.bookmarks.remove(k.id); }catch{}
      continue;
    }
    seen.add(k.url);
  }
  for(const site of payload.sites){
    if(seen.has(site)) continue;
    try{ await chrome.bookmarks.create({ parentId: containerId, title: site, url: site }); }
    catch(e){ console.warn('TCT: failed to create site bookmark:', site, e); }
  }
}

// 指定フォルダから当拡張機能の疑似ブックマーク（コンテナフォルダごと）を削除する。
// ユーザ自身のブックマークには一切触れない。
async function tctDeletePseudoBookmarks(folderId, containerIdHint){
  const folder = await tctReadFolder(folderId);
  if(!folder) return false;
  const container = tctFindContainer(folder, containerIdHint);
  if(!container) return false;
  try{ await chrome.bookmarks.removeTree(container.id); return true; }
  catch{
    try{ await chrome.bookmarks.remove(container.id); return true; }
    catch{ return false; }
  }
}

// 設定を疑似ブックマークとして保存フォルダへ書き込む（正本の更新）。
//  - 保存フォルダが変わっていた場合は、変更前のフォルダから削除してから移動する
//  - 保存フォルダが未設定なら chrome.storage.local への保存のみ行う
async function tctSaveSettingsToBookmarks(settings){
  const clean = tctSanitizeSettings(settings);
  const prev = await tctGetStoredSettings();       // 直近に保存済みの設定
  const prevFolder = prev.storageFolderId;
  const prevContainer = prev.storageContainerId;
  const newFolder = clean.storageFolderId;

  // まず移動先を用意しておく（移動先が用意できなければ旧フォルダは触らない）。
  let containerId = null;
  if(newFolder){
    containerId = await tctEnsureContainer(newFolder, prevFolder===newFolder ? prevContainer : null);
  }

  // 保存フォルダの変更（または解除）→ 変更前のフォルダから疑似ブックマークを削除
  if(prevFolder && prevFolder!==newFolder){
    await tctDeletePseudoBookmarks(prevFolder, prevContainer);
    clean.storageContainerId = null;
  }

  if(!newFolder){
    return await tctPutStoredSettings(clean);      // フォルダ未選択なら拡張機能内のみ
  }

  const payload = tctSanitizeSettings(Object.assign({}, clean, { storageContainerId: containerId }));
  await tctSyncContainer(containerId, payload);
  return await tctPutStoredSettings(payload);
}

// ブックマークフォルダの一覧（セレクトボックス用・ルートは除外）。
// 一覧を取得できなかった場合は例外を送出する（呼び出し側でエラー表示するため）。
async function tctListFolders(){
  const tree = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (nodes, depth)=>{
    for(const n of (nodes||[])){
      const isFolder = !n.url && (n.type==='folder' || Array.isArray(n.children) || n.id==='0');
      if(!isFolder) continue;
      if(n.id==='0'){ walk(n.children, depth); continue; } // ルート直下には作成できない
      out.push({ id: n.id, depth, title: (n.title && String(n.title).trim()) || n.id });
      walk(n.children, depth+1);
    }
  };
  walk(tree, 0);
  return out;
}
