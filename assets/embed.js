// Panels are framed inside the web app; report our natural height so the frame fits exactly (no inner scrollbar).
// The parent only acts on messages coming from its own iframe.
if (parent !== window) {
  const send = () => parent.postMessage({ type: 'trigglow:panel-height', height: Math.ceil(document.body.getBoundingClientRect().height) }, '*');
  new ResizeObserver(send).observe(document.body);
  send();
}
