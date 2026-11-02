const input = document.querySelector('#token'),
  status = document.querySelector('#status');
chrome.storage.local.get('token').then((data) => (input.value = data.token || ''));
document.querySelector('#save').onclick = async () => {
  const token = input.value.trim();
  await chrome.storage.local.set({ token });
  try {
    const response = await fetch('http://127.0.0.1:43110/api/v1/extension/ping', {
      headers: { 'x-campus-token': token },
    });
    if (!response.ok) throw Error();
    status.textContent = '连接成功，设置已保存';
    status.style.color = '#23885a';
  } catch {
    status.textContent = '无法验证令牌，请确认本地服务在线且令牌正确';
    status.style.color = '#cb454c';
  }
};
