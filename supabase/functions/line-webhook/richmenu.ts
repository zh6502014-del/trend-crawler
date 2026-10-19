import config from './menu.json' with { type: 'json' };
export const MENU_W = config.width, MENU_H = config.height, MENU_TAB_H = config.tabHeight;
export const MENU = config.markets.us.cells.map((c) => c.text);
export const MENU_TW = config.markets.tw.cells.map((c) => c.text);
export function menuAreas(cells) {
  const tabs = Object.values(config.markets).map((m, i) => ({
    bounds: { ...config.tabAreas[i] },
    action: { type: 'richmenuswitch', richMenuAliasId: m.alias, data: 'menu=' + m.alias.slice(6) },
  }));
  return [...tabs, ...cells.map((text, i) => ({
    bounds: { ...config.cellAreas[i] },
    action: { type: 'message', text },
  }))];
}
const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) => x.toString(16).padStart(2, '0')).join('');

// New images/definitions are prepared before switching. Old menus remain for rollback.
// Content-derived names make a rerun reuse the same uploaded menus.
export async function syncRichMenus(fetchFn, { token, owner, images }) {
  if (!token || !owner) throw new Error('Missing LINE menu credentials');
  const request = async (path, method = 'GET', body, optional = false, dataHost = false) => {
    const binary = body instanceof Uint8Array;
    const res = await fetchFn(`https://${dataHost ? 'api-data' : 'api'}.line.me/v2/bot/${path}`, {
      method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': binary ? 'image/png' : 'application/json' } : {}) },
      ...(body ? { body: binary ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
    if (optional && res.status === 404) return null;
    if (!res.ok) throw new Error(`LINE menu ${method} failed (HTTP ${res.status})`);
    return res;
  };
  const json = async (...args) => { const res = await request(...args); return res ? res.json() : null; };
  const [listed, aliasList, oldOwner] = await Promise.all([
    json('richmenu/list'), json('richmenu/alias/list'), json(`user/${owner}/richmenu`, 'GET', undefined, true),
  ]);
  const aliases = Object.fromEntries((aliasList.aliases || []).map((a) => [a.richMenuAliasId, a.richMenuId]));
  const ownerMarket = oldOwner?.richMenuId && oldOwner.richMenuId === aliases['trend-tw'] ? 'tw' : 'us';
  const menus = listed.richmenus || [];
  const setAlias = async (alias, id) => {
    if (aliases[alias] === id) return;
    if (aliases[alias]) await json(`richmenu/alias/${alias}`, 'POST', { richMenuId: id });
    else await json('richmenu/alias', 'POST', { richMenuAliasId: alias, richMenuId: id });
    aliases[alias] = id;
  };
  const make = async (key, tabs = true) => {
    const m = config.markets[key], bytes = images[key];
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Missing menu image ' + key);
    const definition = { size: { width: MENU_W, height: MENU_H }, selected: true,
      chatBarText: `研究助理・${m.label}`, areas: menuAreas(m.cells.map((c) => c.text)).filter((a) => tabs || a.action.type !== 'richmenuswitch') };
    const imageHash = await digest(bytes);
    const hash = await digest(new TextEncoder().encode(JSON.stringify(definition) + imageHash));
    const name = `trend-menu-${key}-${tabs ? '' : 'boot-'}${hash.slice(0, 16)}`;
    const existing = menus.find((x) => x.name === name);
    if (existing) {
      const content = await request(`richmenu/${existing.richMenuId}/content`, 'GET', undefined, true, true);
      if (content && await digest(await content.arrayBuffer()) === imageHash) return existing.richMenuId;
    }
    const { richMenuId } = await json('richmenu', 'POST', { ...definition, name });
    await request(`richmenu/${richMenuId}/content`, 'POST', bytes, false, true);
    const uploaded = await request(`richmenu/${richMenuId}/content`, 'GET', undefined, false, true);
    if (await digest(await uploaded.arrayBuffer()) !== imageHash) throw new Error('Uploaded menu image verification failed');
    return richMenuId;
  };
  // First installation needs aliases before tabbed menus may reference them.
  for (const key of ['us', 'tw']) if (!aliases[config.markets[key].alias])
    await setAlias(config.markets[key].alias, await make(key, false));
  const ids = {};
  for (const key of ['us', 'tw']) ids[key] = await make(key);
  for (const key of ['us', 'tw']) await setAlias(config.markets[key].alias, ids[key]);
  await request(`user/all/richmenu/${ids.us}`, 'POST');
  // A user who switched tabs has a personal binding overriding the default.
  await request(`user/${owner}/richmenu/${ids[ownerMarket]}`, 'POST');
  const [defaultMenu, personalMenu, finalAliases] = await Promise.all([
    json('user/all/richmenu'), json(`user/${owner}/richmenu`), json('richmenu/alias/list'),
  ]);
  if (defaultMenu.richMenuId !== ids.us || personalMenu.richMenuId !== ids[ownerMarket] ||
      ['us','tw'].some((key) => !finalAliases.aliases.some((a) => a.richMenuAliasId === config.markets[key].alias && a.richMenuId === ids[key])))
    throw new Error('LINE menu binding verification failed');
  return { version: config.version, menus: ids, ownerMarket, verified: true };
}
