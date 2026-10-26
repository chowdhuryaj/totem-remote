export const $ = (s) => document.querySelector(s);
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k.startsWith('on') ? e.addEventListener(k.slice(2), v) : k in e ? (e[k] = v) : e.setAttribute(k, v);
  e.append(...kids.flat().filter((x) => x != null));
  return e;
}
