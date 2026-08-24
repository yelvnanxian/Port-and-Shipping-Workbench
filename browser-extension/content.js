function cleanHtmlSnapshot() {
  const root = document.documentElement?.cloneNode(true);
  if (!root) return '';
  root.querySelectorAll?.('script,style,noscript,iframe,svg').forEach((node) => node.remove());
  return root.outerHTML.slice(0, 2_000_000);
}

function visibleFormValues() {
  return [...document.querySelectorAll('input, textarea, select')].flatMap((element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return [];
    if (element instanceof HTMLInputElement && ['password', 'hidden'].includes(element.type)) return [];
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || !element.getClientRects().length) return [];
    const value = element instanceof HTMLSelectElement
      ? element.selectedOptions[0]?.textContent?.trim() || element.value.trim()
      : element.value.trim();
    if (!value) return [];
    const associatedLabel = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim() : '';
    const label = associatedLabel || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('name') || element.id || '表单字段';
    return [`${label}: ${value}`];
  });
}

function collectCurrentPage() {
  const bodyText = (document.body?.innerText || '').replace(/\u00a0/g, ' ').trim();
  const formText = visibleFormValues();
  const pageText = [bodyText, formText.length ? `[Visible form values]\n${formText.join('\n')}` : ''].filter(Boolean).join('\n\n');
  const resources = performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((value) => /^https:\/\/(?:[^/]+\.)?(?:cma-cgm\.com|hapag-lloyd\.(?:com|cn))\//i.test(value))
    .slice(-200);
  return {
    pageUrl: location.href,
    pageTitle: document.title,
    pageText,
    pageHtml: cleanHtmlSnapshot(),
    resourceUrls: resources,
  };
}

if (!globalThis.__portWorkbenchCollectorInstalled) {
  globalThis.__portWorkbenchCollectorInstalled = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'collect-current-page') return false;
    try {
      sendResponse({ ok: true, data: collectCurrentPage() });
    } catch (error) {
      sendResponse({ ok: false, message: error instanceof Error ? error.message : '无法读取当前页面' });
    }
    return true;
  });
}
