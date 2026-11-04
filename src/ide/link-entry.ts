/** Automatic, same-origin exchange. No SDK, channel identity or URL credential.
 * A failed exchange stops on this page instead of redirecting in a loop. */
export const IDE_LINK_ENTRY_SCRIPT = `(() => {
  const form = document.querySelector('form[data-ide-link-enter]');
  if (!form) return;
  const status = document.querySelector('[data-ide-link-status]'), button = form.querySelector('button');
  let busy = false;
  const enter = async event => {
    event?.preventDefault(); if (busy) return; busy = true; button.disabled = true;
    try {
      const response = await fetch(form.action, { method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json' }, body: new URLSearchParams(new FormData(form)), signal: AbortSignal.timeout(90000) });
      const result = await response.json();
      if (!response.ok || result.location !== location.pathname) throw new Error();
      location.replace(result.location);
    } catch { status.textContent = '项目暂时无法打开，请稍后重试。'; busy = false; button.disabled = false; }
  };
  form.addEventListener('submit', enter); void enter();
})();`;
