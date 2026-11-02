// The Instant clip card on its own, for the web's Clips page (the card itself lives in clipcard.js).
const shell = window.trigglowShell;
if (shell) {
  ClipCard.init(document.getElementById('clipCard'));
  // Framed inside the web page, so main's push events don't reach us — refresh the status while visible.
  ClipCard.refresh();
  setInterval(() => !document.hidden && ClipCard.refresh(), 2000);
}
