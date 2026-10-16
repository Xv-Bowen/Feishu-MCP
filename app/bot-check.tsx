"use client";
import { useState } from "react";

type Check = { message?: string; next_step?: string; bot?: { name: string | null; enabled: boolean } | null; bot_in_chat?: boolean | null; announcement_metadata_readable?: boolean | null; diagnostic?: { message?: string } };
type Reply<T> = { error?: string; result?: { isError?: boolean; structuredContent?: T } };
type Groups = { message?: string; chats?: Array<{ chat_id: string; name: string }>; has_more?: boolean };
export default function BotCheck({ enabled, appId }: { enabled: boolean; appId: string }) {
  const [busy, setBusy] = useState(false), [groups, setGroups] = useState<Array<{ chat_id: string; name: string }>>([]);
  const [chat, setChat] = useState(""), [result, setResult] = useState<Check | null>(null), [message, setMessage] = useState("");
  async function loadGroups() {
    setBusy(true); setMessage("");
    try {
      const reply = await fetch("/api/test-chats", { method: "POST" });
      const payload = await reply.json() as Reply<Groups>;
      const data = payload.result?.structuredContent;
      if (!reply.ok || payload.result?.isError || !Array.isArray(data?.chats)) throw new Error(data?.message || "群列表暂未读取成功。");
      setGroups(data.chats);
      if (data.has_more) setMessage("这里仅显示本页群聊，AI 可继续分页选择其他群。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "群列表暂未读取成功。"); }
    finally { setBusy(false); }
  }
  async function check() {
    setBusy(true); setMessage(""); setResult(null);
    try {
      const reply = await fetch("/api/bot-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(chat ? { chat_id: chat } : {}) });
      const payload = await reply.json() as Reply<Check>;
      const data = payload.result?.structuredContent as Check | undefined;
      if (!reply.ok || payload.result?.isError || !data) throw new Error(data?.message || payload.error || "机器人检查暂未完成。");
      setResult(data);
    } catch (error) { setMessage(error instanceof Error ? error.message : "机器人检查暂未完成。"); }
    finally { setBusy(false); }
  }
  return <section className="feature-card bot-check"><h2>外部群公告机器人</h2>
    <p>群公告受外部群限制时，可由同一应用的机器人尝试读取。你本人和机器人都需在目标群内；检查会明确显示缺少的配置。</p>
    <div className="bot-controls"><label>目标群聊<select value={chat} onChange={event => { setChat(event.target.value); setResult(null); }} disabled={!enabled || busy}><option value="">先检查机器人状态</option>{groups.map(group => <option key={group.chat_id} value={group.chat_id}>{group.name}</option>)}</select></label>
      <button className="button secondary" disabled={!enabled || busy} onClick={loadGroups}>载入我的群聊</button><button className="button primary" disabled={!enabled || busy} onClick={check}>{busy ? "正在检查…" : "检查机器人"}</button></div>
    {message && <p className="test-result" role="status">{message}</p>}
    {result && <div className="bot-result" role="status"><p>{result.bot ? `${result.bot.name || "本应用机器人"}：${result.bot.enabled ? "已启用" : "未启用或已停用"}` : "尚未确认机器人状态"}</p>{chat && <p>机器人入群：{result.bot_in_chat === true ? "已确认" : result.bot_in_chat === false ? "尚未加入" : "尚未确认"}；公告元信息访问：{result.announcement_metadata_readable === true ? "已通过，正文待读取验证" : "尚未通过"}</p>}<p>{result.next_step || result.diagnostic?.message}</p></div>}
    <details><summary>查看飞书后台开通步骤</summary><ol><li>在当前应用添加机器人能力，保存并发布。</li><li>按飞书要求完成实名或组织认证，并开启机器人的对外共享。</li><li>开通应用身份权限 <code>im:chat:read</code> 和 <code>im:chat.announcement:read</code>，发布生效。</li><li>在有权操作的群中添加该应用机器人，然后选择目标群重新检查。</li></ol><p><a className="text-link" href={appId ? `https://open.feishu.cn/app/${encodeURIComponent(appId)}` : "https://open.feishu.cn/app"} target="_blank" rel="noreferrer">打开当前应用后台 ↗</a> · <a className="text-link" href="https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/develop-robots/add-bot-to-external-group" target="_blank" rel="noreferrer">查看飞书开通说明 ↗</a></p></details>
  </section>;
}
