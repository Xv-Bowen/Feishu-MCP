"use client";
import { useState } from "react";
export default function ConnectionTest({ enabled }: { enabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [document, setDocument] = useState("");
  async function test() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/test-read", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ document: document.trim() }) });
      const reply = await response.json() as { error?: unknown; result?: { isError?: boolean; structuredContent?: { message?: string; total_characters?: number } } };
      if (!response.ok) throw new Error(typeof reply.error === "string" ? reply.error : "连接测试未完成，请刷新页面重试。");
      const result = reply.result;
      if (reply.error || result?.isError || typeof result?.structuredContent?.total_characters !== "number") throw new Error(result?.structuredContent?.message || "连接测试未完成。");
      setMessage(`读取成功：这篇文档共有 ${result.structuredContent.total_characters.toLocaleString()} 个字符。已连接的 AI 客户端可使用相同的工具。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "连接测试未完成，请重试。"); }
    finally { setBusy(false); }
  }
  return <section className="test-card"><div><h3>用自己的文档验证连接</h3><p>输入你有权访问的飞书新版文档链接或 ID，确认授权和接口可用。</p><label htmlFor="test-document">文档链接或 ID</label><input id="test-document" className="copy-field" value={document} onChange={event => setDocument(event.target.value)} maxLength={2048} placeholder="https://your-tenant.feishu.cn/docx/…" disabled={!enabled || busy} />{message && <p className="test-result" role="status">{message}</p>}</div><button className="button secondary" disabled={!enabled || busy || !document.trim()} onClick={test}>{busy ? "正在读取…" : "测试读取"}</button></section>;
}
