const tokenElement = document.querySelector('#token');
const apiBaseElement = document.querySelector('#apiBase');
const collectButton = document.querySelector('#collect');
const statusElement = document.querySelector('#status');

function status(message, error = false) {
  statusElement.textContent = message;
  statusElement.style.color = error ? '#a53f38' : '#46636a';
}

async function readCurrentPage(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'collect-current-page' });
  } catch {
    status('当前标签页尚未加载采集脚本，正在自动连接…');
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, { type: 'collect-current-page' });
  }
}

async function collect() {
  const token = tokenElement.value.trim();
  const apiBase = apiBaseElement.value.trim().replace(/\/$/, '');
  if (!token) { status('请先粘贴工作台采集令牌。', true); return; }
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(apiBase)) { status('工作台地址必须是本机 http://127.0.0.1:端口 或 localhost 地址。', true); return; }
  collectButton.disabled = true;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id || !/^https:\/\/(?:[^/]+\.)?(?:cma-cgm\.com|hapag-lloyd\.(?:com|cn))\//i.test(tab.url || '')) {
      throw new Error('当前标签页不是达飞或赫伯罗特官网。');
    }
    status('正在读取当前结果页面…');
    const page = await readCurrentPage(tab.id);
    if (!page?.ok) throw new Error(page?.message || '无法读取当前页面。');
    if (!page.data.pageText || page.data.pageText.length < 20) throw new Error('当前页面没有足够的结果文字，请先完成查询并打开结果详情。');
    status('正在截取可见区域并发送到工作台…');
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const screenshotBlob = await (await fetch(screenshotDataUrl)).blob();
    const body = new FormData();
    body.append('token', token);
    body.append('pageUrl', page.data.pageUrl);
    body.append('pageText', page.data.pageText);
    body.append('pageHtml', page.data.pageHtml || '');
    body.append('resourceUrls', JSON.stringify(page.data.resourceUrls || []));
    body.append('screenshot', screenshotBlob, 'manual-collection.png');
    const response = await fetch(`${apiBase}/api/manual-collection/submit`, {
      method: 'POST',
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `工作台返回 HTTP ${response.status}`);
    status(`采集成功：${payload.session?.carrierName || ''}\n已写入 Excel，可关闭此窗口。`);
  } catch (error) {
    status(error instanceof Error ? error.message : '采集失败', true);
  } finally {
    collectButton.disabled = false;
  }
}

collectButton.addEventListener('click', () => { void collect(); });
