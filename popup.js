// popup.js - small multi-timezone digital clock and options launcher

function fmt(d) {
  return d.toLocaleTimeString();
}
function updateClocks() {
  const now = new Date();
  document.getElementById('t_local').textContent = fmt(now);
  document.getElementById('t_utc').textContent = now.toUTCString().split(' ')[4];
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  document.getElementById('t_ny').textContent = fmt(ny);
  const ldn = new Date(now.toLocaleString('en-GB', { timeZone: 'Europe/London' }));
  document.getElementById('t_ldn').textContent = fmt(ldn);
  const tok = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  document.getElementById('t_tok').textContent = fmt(tok);
}

document.getElementById('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
setInterval(updateClocks, 1000);
updateClocks();