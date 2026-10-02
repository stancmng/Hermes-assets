import { App } from './app.js';

const app = new App(document.getElementById('app'));
window.hermes = app; // handy for debugging in devtools
app.boot();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
