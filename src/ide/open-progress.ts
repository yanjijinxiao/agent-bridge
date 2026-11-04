/** The approved browser stays on one document while preparation runs. POST
 * retains CSRF/Origin checks; polling never grants access or trusts a new root.
 * Bounded retries and an explicit retry button replace navigation loops. */
export const IDE_OPEN_PROGRESS_SCRIPT = String.raw`
(()=>{
 const form=document.querySelector('[data-ide-auto-open]'),status=document.querySelector('[data-ide-open-status]');
 if(!form||!status)return;
 const button=form.querySelector('button');let busy=false,timer,attempts=0;
 const phases={checking:'正在检查主机环境','remote-download':'正在主机下载 code-server','gateway-download':'正在 Gateway 下载 code-server',transferring:'正在传输安装包',verifying:'正在校验安装包',ready:'安装完成，正在启动编辑器'};
 const show=text=>{status.textContent=text};
 const run=async()=>{
  if(busy)return;busy=true;button.disabled=true;clearTimeout(timer);
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),240000);
  try{
   const response=await fetch(form.action,{method:'POST',credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(form)),signal:controller.signal});
   const result=await response.json();
   if(response.ok&&result.status==='ready'&&typeof result.location==='string'&&/^\/ide\/[a-f0-9]{32}\//.test(result.location)){location.replace(result.location);return;}
   if(response.status===202&&result.status==='preparing'){
    let text=phases[result.phase]||'正在准备 code-server';
    if(Number.isFinite(result.bytes)&&Number.isFinite(result.total)&&result.total>0)text+=' · '+(result.bytes/1048576).toFixed(1)+' / '+(result.total/1048576).toFixed(1)+' MB';
    show(text+'。准备完成后自动进入；浏览器授权已保留。');
    if(++attempts<240)timer=setTimeout(run,5000);else show(text+'。自动检查已暂停，可点击继续检查。');
   }else show(result.error||'暂时无法打开 IDE，请点击重试。原浏览器授权仍保留。');
  }catch{show('暂时无法取得准备状态，请点击重试。原浏览器授权仍保留。');}
  finally{clearTimeout(deadline);busy=false;button.disabled=false;}
 };
 form.addEventListener('submit',event=>{event.preventDefault();attempts=0;void run()});
 void run();
})();
`;
