'use strict';

const MAX_LOG_BYTES = 700 * 1024;

function flattenLog4j(text) {
  if (!text.includes('<log4j:')) return text;
  const lines = [];
  const re = /<log4j:Event\b([^>]*)>[\s\S]*?<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?(?:<log4j:Throwable><!\[CDATA\[([\s\S]*?)\]\]>)?[\s\S]*?<\/log4j:Event>/g;
  let m;
  let matched = false;
  while ((m = re.exec(text))) {
    matched = true;
    const attrs = m[1] || '';
    const level = (attrs.match(/\blevel="([^"]+)"/i) || [])[1] || 'INFO';
    const logger = (attrs.match(/\blogger="([^"]+)"/i) || [])[1] || '';
    const stamp = (attrs.match(/\btimestamp="(\d+)"/i) || [])[1];
    const time = stamp
      ? new Date(+stamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      : '';
    const head = time ? `[${time}] [${logger || 'main'}/${level}]` : `[${logger || 'main'}/${level}]`;
    for (const line of String(m[2] || '').split('\n')) lines.push(`${head}: ${line}`);
    if (m[3]) for (const line of String(m[3]).split('\n')) lines.push(line);
  }
  if (!matched) {
    const loose = /<log4j:(?:Message|Throwable)><!\[CDATA\[([\s\S]*?)\]\]>/g;
    while ((m = loose.exec(text))) lines.push(...m[1].split('\n'));
  }
  const rest = text.replace(/<log4j:Event[\s\S]*?<\/log4j:Event>/g, '').trim();
  if (rest) lines.push(...rest.split('\n'));
  return lines.join('\n');
}

function takeLogLines(state, id, text) {
  state.pending = (state.pending + text).slice(-MAX_LOG_BYTES);
  const buf = state.pending;
  if (id === 'output' && buf.includes('<log4j:')) {
    const end = buf.lastIndexOf('</log4j:Event>');
    if (end < 0) return '';
    const cut = end + '</log4j:Event>'.length;
    state.pending = buf.slice(cut);
    return flattenLog4j(buf.slice(0, cut));
  }
  const nl = buf.lastIndexOf('\n');
  if (nl < 0) return '';
  state.pending = buf.slice(nl + 1);
  return buf.slice(0, nl + 1);
}

module.exports = { MAX_LOG_BYTES, flattenLog4j, takeLogLines };
