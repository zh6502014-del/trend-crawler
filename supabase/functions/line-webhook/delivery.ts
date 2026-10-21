// No request text, credentials or provider response bodies are written to logs.
export async function reply(fetchFn, token, replyToken, messages) {
  try {
    const r=await fetchFn('https://api.line.me/v2/bot/message/reply',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
      body:JSON.stringify({replyToken,messages:messages.slice(0,5)}),signal:AbortSignal.timeout(7500),
    });
    if (r.ok) return {status:'replied',error:null};
    return {status:r.status===429 || r.status>=500 ? 'retry':'failed',error:'reply_http_'+r.status};
  } catch (_) { return {status:'retry',error:'reply_network'}; }
}

export function durableReply(cmd, messages) {
  // Never persist a dashboard sign-in capability. Replays direct the owner to request a fresh link.
  return cmd.cmd==='dash' ? [{type:'text',text:'網頁登入連結請重新取得：傳送「儀表板」即可，不需要收 Email。'}] : messages;
}

export async function systemStatus(db) {
  const [events,deliveries]=await Promise.all([
    db.get('line_events?or=(error_code.not.is.null,status.eq.retry,status.eq.failed)&select=status,error_code,updated_at&order=updated_at.desc&limit=5'),
    db.get('line_deliveries?delivery_key=like.line:*&select=status,last_error,attempted_at,sent_at&order=created_at.desc&limit=5'),
  ]);
  const names={replied:'已回覆',retry:'回覆待重試',failed:'失敗，需確認',pending:'待送出',sent:'LINE 已接受',skipped:'額度限制，未發送',unknown:'額度暫時查不到',expired:'超過安全重試時間'};
  const e=events.map(r=>`${String(r.updated_at).slice(0,16).replace('T',' ')} UTC｜${names[r.status] || r.status}（${r.error_code || '未知'}）`);
  const d=deliveries.map(r=>`${String(r.attempted_at || r.sent_at || '').slice(0,16).replace('T',' ')} UTC｜${r.sent_at?'已接受':names[r.status] || r.status}${r.last_error ? '（'+r.last_error+'）':''}`);
  return [{type:'text',text:'系統狀態\n最近異常（最多 5 筆，事件保留 7 天）：\n'+(e.join('\n') || '目前沒有已記錄的異常。')+'\n\n最近推播（最多 5 筆）：\n'+(d.join('\n') || '尚無推播紀錄。')+'\n\nLINE 接受請求不代表已讀。寫入中斷時請先查清單，避免重複操作。'}];
}
