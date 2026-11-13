'use strict';
const input = document.getElementById('url');
let editing = false;
input.addEventListener('focus', () => {
  editing = true;
  input.select();
});
input.addEventListener('blur', () => (editing = false));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    window.mini.navigate(input.value);
    input.blur();
  }
});
document.getElementById('promote').onclick = () => window.mini.promote();
window.mini.onState((s) => {
  if (!editing) input.value = s.url;
  document.title = s.title;
});
window.mini.onFocus(() => input.focus());
