// Shows a key-moments report saved by the side panel, with buttons to print it to PDF or save it.
(async () => {
  const id = new URLSearchParams(location.search).get('id');
  const root = document.getElementById('tx-root');
  const data = id && (await chrome.storage.local.get(id))[id];
  if (!data) {
    root.innerHTML = '<p style="font:14px system-ui;padding:24px">This report is no longer available. Capture the moments again from the Transcripter panel.</p>';
    return;
  }
  const doc = new DOMParser().parseFromString(data.html, 'text/html');
  doc.querySelectorAll('style').forEach(s => document.head.appendChild(s));
  document.title = doc.title;
  root.replaceChildren(...doc.body.childNodes);
  document.getElementById('tx-pdf').addEventListener('click', () => window.print());
  document.getElementById('tx-html').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data.html], { type: 'text/html' }));
    a.download = data.name + '.html';
    document.body.appendChild(a); a.click(); a.remove();
  });
})();
