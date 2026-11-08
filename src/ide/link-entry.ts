/** Automatic, same-origin exchange. No SDK, channel identity or URL credential.
 * A failed exchange stops on this page instead of redirecting in a loop. */
export const IDE_LINK_ENTRY_SCRIPT = `(() => {
  const form = document.querySelector('form[data-ide-link-enter]');
  if (!form) return;
  const status = document.querySelector('[data-ide-link-status]'), button = form.querySelector('button');
  const title = document.querySelector('h1'), description = document.querySelector('h1 + p');
  let busy = false, reopen = false;
  const enter = async event => {
    event?.preventDefault(); if (busy) return;
    if (reopen) { location.replace(location.pathname); return; }
    busy = true; button.disabled = true;
    if (title) title.textContent = '正在打开 Web IDE';
    if (description) description.textContent = '正在准备项目，完成后自动进入。';
    status.textContent = '正在连接…';
    // Embedded WebViews may implement AbortController but not the newer
    // AbortSignal.timeout static method. Always clear the per-attempt deadline.
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 90000);
    let failure = '连接失败，请检查网络后点击重试。';
    try {
      const response = await fetch(form.action, { method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json' }, body: new URLSearchParams(new FormData(form)), signal: controller.signal });
      if (response.status === 401 || response.status === 403) {
        reopen = true; failure = '访问请求已过期或权限已改变，请点击重新打开，核对当前项目入口。'; throw new Error();
      }
      if (!response.ok) { failure = '项目服务暂时不可用（HTTP ' + response.status + '），请稍后重试。'; throw new Error(); }
      failure = '入口响应无效，未跳转到其他地址。请稍后重试。';
      const result = await response.json();
      if (result.location !== location.pathname) throw new Error();
      location.replace(result.location);
    } catch {
      if (title) title.textContent = 'Web IDE 尚未打开';
      if (description) description.textContent = '本次连接未完成。';
      status.textContent = controller.signal.aborted ? '连接超时，请检查网络后点击重试。' : failure;
      button.textContent = reopen ? '重新打开' : '重试打开';
    } finally { clearTimeout(deadline); busy = false; button.disabled = false; }
  };
  form.addEventListener('submit', enter); void enter();
})();`;
