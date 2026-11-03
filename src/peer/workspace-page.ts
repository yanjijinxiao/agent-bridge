import { COPY_SCRIPT, COPY_STYLE, copyField } from "../ide/copy-controls.js";

/** No filenames/content are interpolated into markup or executed as HTML. */
export function workspacePage(nonce: string, csrf: string, code?: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>共享工作区 · Connector</title>
<style>
:root{color-scheme:dark;--bg:#11191f;--panel:#18232b;--line:#30414b;--ink:#e6eee9;--muted:#9dafa9;--accent:#a4e5bb}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 'PingFang SC','Noto Sans CJK SC',sans-serif}header{min-height:76px;padding:18px 28px;display:flex;gap:18px;align-items:center;border-bottom:1px solid var(--line)}header b{font-size:20px;letter-spacing:1px}header small{color:var(--muted)}#mode{margin-left:auto;color:var(--accent);font:12px Menlo,monospace;border:1px solid var(--line);padding:5px 12px;border-radius:20px}main{height:calc(100dvh - 76px);display:grid;grid-template-columns:260px minmax(0,1fr)}aside{border-right:1px solid var(--line);padding:20px 14px;overflow:auto;background:var(--panel)}aside h2{font-size:11px;letter-spacing:2px;color:var(--muted);padding:0 12px}button{font:inherit;color:inherit;cursor:pointer;background:none;border:1px solid var(--line);border-radius:5px;padding:8px 14px}button:hover{border-color:var(--accent);color:var(--accent)}button:disabled{cursor:default;opacity:.45}button:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.file{display:block;width:100%;text-align:left;border:0;padding:7px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#editor{min-width:0;display:flex;flex-direction:column}.bar{display:flex;gap:16px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line);min-height:62px}#filename{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:13px Menlo,monospace}#save{margin-left:auto;background:var(--accent);color:var(--bg);font-weight:600}#text{flex:1;width:100%;resize:none;background:transparent;border:0;color:var(--ink);padding:24px;tab-size:2;font:13px/1.8 Menlo,Consolas,monospace;outline:none}#message{min-height:36px;padding:8px 22px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}#login{max-width:640px;margin:8vh auto;padding:32px;display:none}#login h1{font-size:30px;line-height:1.4}#login code{display:block;padding:20px;border:1px solid var(--line);color:var(--accent);font:19px Menlo,monospace;margin:22px 0}#login p{color:var(--muted)}.hidden{display:none!important}@media(max-width:650px){header{padding:14px;font-size:12px}header small{display:none}main{grid-template-columns:145px minmax(0,1fr)}aside{padding:12px 5px}#text{padding:14px;font-size:12px}.bar{padding:10px}#login{margin:4vh 16px;padding:12px}}
${COPY_STYLE}</style><header><b>共享工作区</b><small>CONNECTOR / TEXT WORKSPACE</small><span id="mode">等待身份确认</span></header>
<section id="login"><h1>先确认是你，<br>再进入工作区。</h1><p>在获得授权的机器人聊天中发送以下命令。此操作只确认当前浏览器。</p>${code ? copyField("发送到已授权聊天的浏览器确认命令", `/share browser ${code}`, { purpose: "reply" }) : ""}<button id="check">我已发送，检查授权</button><p id="hint" role="status"></p></section>
<main id="work" class="hidden"><aside><h2>EXPLORER</h2><button id="up" class="file">↑ 上一级</button><div id="files"></div></aside><section id="editor"><div class="bar"><span id="filename">选择一个文本文件</span><button id="save" disabled>保存</button></div><textarea id="text" aria-label="文件内容" spellcheck="false" readonly></textarea><div id="message" role="status">浏览和编辑已授权目录中的现有文本文件；终端未开放。</div></section></main>
<script nonce="${nonce}">${COPY_SCRIPT}</script>
<script nonce="${nonce}">
let csrf=${JSON.stringify(csrf)}, code=${JSON.stringify(code)}, ready=false, writable=false, selected='', version='', directory='', dirty=false;
let editEpoch=0, viewEpoch=0, openEpoch=0, pendingSave;
const $=id=>document.getElementById(id);
function message(t){$('message').textContent=t}
function refreshSave(){$('save').disabled=!writable||!selected||!dirty||Boolean(pendingSave)}
async function api(operation,input={}){const r=await fetch(location.pathname+'/api',{method:'POST',headers:{'Content-Type':'application/json','X-Workspace-CSRF':csrf},body:JSON.stringify({operation,...input})});const data=await r.json();if(!r.ok){if(ready){writable=false;$('text').readOnly=true;refreshSave();$('mode').textContent='访问已失效';$('files').replaceChildren()}throw Error(data.error||'请求失败')}return data}
async function list(dir){if(dirty&&!confirm('有未保存的修改，仍要切换文件？'))return;const data=await api('list',{path:dir});directory=dir;$('files').replaceChildren();for(const item of data.entries){const b=document.createElement('button');b.className='file';b.textContent=(item.directory?'▸ ':'  ')+item.name;b.title=item.name;b.onclick=()=>{const path=[directory,item.name].filter(Boolean).join('/');(item.directory?list(path):openFile(path)).catch(e=>message(e.message))};$('files').append(b)}}
async function openFile(path){if(dirty&&!confirm('有未保存的修改，仍要打开其他文件？'))return;const request=++openEpoch, edits=editEpoch;const data=await api('read',{path});if(request!==openEpoch||edits!==editEpoch)return;viewEpoch++;selected=path;version=data.hash;$('filename').textContent=path;$('text').value=data.text;$('text').readOnly=!writable;dirty=false;refreshSave();message(writable?'已加载 · 修改后可保存':'只读 · 你可以浏览，无法写入文件')}
async function enter(){const data=await api('session');csrf=data.csrf;writable=data.writable;ready=true;$('login').style.display='none';$('work').classList.remove('hidden');$('mode').textContent=writable?'读写授权':'只读授权';await list('')}
$('check').onclick=()=>api('exchange').then(data=>{csrf=data.csrf;return enter()}).catch(e=>$('hint').textContent=e.message);
$('text').oninput=()=>{editEpoch++;dirty=true;refreshSave()};
$('text').onkeydown=e=>{if(e.key==='Tab'&&writable){e.preventDefault();document.execCommand('insertText',false,'  ')}};
// A receipt acknowledges one file revision. It never acknowledges later edits
// or a subsequently opened view, even when that view has the same path.
$('save').onclick=async()=>{
  if(pendingSave||!writable||!selected||!dirty)return;
  const save={path:selected,hash:version,text:$('text').value,edit:editEpoch,view:viewEpoch};
  pendingSave=save;refreshSave();
  try{
    const data=await api('write',{path:save.path,hash:save.hash,text:save.text});
    if(viewEpoch!==save.view||selected!==save.path)return;
    version=data.hash;dirty=editEpoch!==save.edit||$('text').value!==save.text;
    message(dirty?'前一版已保存 · 当前修改尚未保存':'已保存 · '+new Date().toLocaleTimeString());
  }catch(e){if(viewEpoch===save.view&&selected===save.path)message(e.message+' 本地修改仍保留，请刷新文件后比对。')}
  finally{if(pendingSave===save)pendingSave=undefined;refreshSave()}
};
$('up').onclick=()=>list(directory.split('/').slice(0,-1).join('/')).catch(e=>message(e.message));
if(code){$('login').style.display='block';}else enter().catch(e=>message(e.message));
setInterval(()=>{if(ready)api('session').catch(e=>message(e.message))},20000);
addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});
</script></html>`;
}
