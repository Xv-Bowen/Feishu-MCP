"use client";
import { useState } from "react";
export default function ChatTest({ enabled }: { enabled: boolean }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  async function test() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/test-chats", { method: "POST" });
      if (!response.ok) throw new Error("群聊测试未完成，请刷新页面重试。");
      const reply = await response.json() as { result?: { isError?: boolean; structuredContent?: { message?: string; chats?: Array<{ name?: string }>; has_more?: boolean } } };
      const data = reply.result?.structuredContent;
      if (reply.result?.isError || !Array.isArray(data?.chats)) throw new Error(data?.message || "群聊测试未完成。");
      const names = data.chats.map(item => item.name).filter(Boolean).join("、");
      setMessage(`读取成功：${data.has_more ? "本页" : "共"}${data.chats.length} 个群${names ? `，包括 ${names}` : ""}。${data.has_more ? "AI 可继续分页查询。" : ""}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "群聊测试未完成。"); }
    finally { setBusy(false); }
  }
  return <section className="test-card"><div><h3>验证群聊连接</h3><p>仅读取一页你加入的群，不拉取聊天记录。</p>{message && <p className="test-result" role="status">{message}</p>}</div><button className="button secondary" disabled={!enabled || busy} onClick={test}>{busy ? "正在查询…" : "测试群聊"}</button></section>;
}
