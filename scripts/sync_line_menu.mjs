import { readFile } from 'node:fs/promises';
import { syncRichMenus } from '../supabase/functions/line-webhook/richmenu.ts';
const images = {};
for (const [key, file] of [['us','richmenu.png'],['tw','richmenu_tw.png']])
  images[key] = new Uint8Array(await readFile(new URL('../docs/' + file, import.meta.url)));
try {
  const result = await syncRichMenus(fetch, { token: process.env.LINE_CHANNEL_TOKEN,
    owner: process.env.LINE_USER_ID, images });
  console.log('LINE rich menus synchronized and verified:', JSON.stringify(result));
} catch (error) {
  console.error('::error title=LINE menu synchronization::' + String(error.message).replaceAll('\n', ' '));
  process.exitCode = 1;
}
