"use client";
import { useState } from "react";
type Credentials = { url: string; headers: Record<string, string>; client_id?: string; expires_at?: number };
function Fields({ credentials }: { credentials: Credentials }) {
  return <div className="credential-fields"><label>统一 MCP 地址<input className="copy-field" value={credentials.url} readOnly onFocus={event => event.currentTarget.select()} /></label>{credentials.client_id && <label>OAuth 客户端 ID<input className="copy-field" value={credentials.client_id} readOnly onFocus={event => event.currentTarget.select()} /></label>}{Object.entries(credentials.headers).map(([name, value]) => <label key={name}>请求头：<code>{name}</code><input className="copy-field" type="password" value={value} readOnly aria-label={name} onFocus={event => { event.currentTarget.type = "text"; event.currentTarget.select(); }} onBlur={event => { event.currentTarget.type = "password"; }} /></label>)}<p className="small">{Object.keys(credentials.headers).length ? "点击输入框复制完整值，请保留凭据开头的 Bearer 和空格。" : credentials.client_id ? "点击输入框复制地址和客户端 ID；客户端密钥、请求标头全部留空。" : "点击输入框复制地址；客户端 ID、密钥、请求标头全部留空。"}</p></div>;
}
export default function ClientConnection({ enabled, url, clientId }: { enabled: boolean; url: string; clientId?: string }) {
  const [oauth, setOAuth] = useState<Credentials>({ url, client_id: clientId, headers: {} });
  const [legacy, setLegacy] = useState<Credentials | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function act(action: "setup" | "revoke" | "legacy" | "remove-legacy") {
    setBusy(true); setMessage("");
    try {
      const endpoint = action === "setup" ? "/api/claude-oauth/setup" : action === "revoke" ? "/api/claude-oauth/revoke-all" : "/api/client-keys";
      const method = action === "setup" ? "GET" : action === "remove-legacy" ? "DELETE" : "POST";
      const response = await fetch(endpoint, { method });
      const data = await response.json() as Credentials & { error?: string; error_description?: string };
      if (!response.ok) throw new Error(data.error_description || data.error || "连接设置暂时不可用。");
      if (action === "setup") setOAuth(data);
      else if (action === "legacy") setLegacy(data);
      else if (action === "remove-legacy") { setLegacy(null); setMessage("已撤销当前账号的固定客户端凭据。"); }
      else setMessage("已撤销当前账号的客户端 OAuth 授权。ChatGPT 原平台插件和飞书账号连接仍可使用。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作未完成。"); }
    finally { setBusy(false); }
  }
  return <section className="client-card">
    <div className="section-heading"><h2>连接 ChatGPT 或 Claude</h2><span>统一地址 · 自动 OAuth</span></div>
    <p>复制同一个 MCP 地址，登录并确认授权后自动返回客户端。无需手填客户端 ID、密钥或访问令牌；续期由客户端管理。</p>
    <p>Claude：选择「立即登录」。OAuth 客户端支持「使用 Claude 的已发布身份」和「自动注册」；客户端密钥、请求标头留空。</p>
    <p>如果官方身份服务暂时无法读取，请改选「自动注册」并重新开始连接。两种方式都需要你登录本站并确认授权。</p>
    <p>ChatGPT：原飞书插件可继续使用。自行添加连接时使用下方地址，选择 OAuth 官方身份或自动注册。</p>
    <Fields credentials={{ ...oauth, client_id: undefined }} />
    <div className="client-actions"><button className="button primary" disabled={!enabled || busy} onClick={() => act("setup")}>{busy ? "处理中…" : "刷新连接设置"}</button><button className="button secondary" disabled={!enabled || busy} onClick={() => act("revoke")}>撤销客户端 OAuth 授权</button></div>
    {message && <p role="status">{message}</p>}
    {oauth.client_id && <details className="legacy-connection"><summary>高级：已有手动 OAuth 客户端</summary><p>之前使用手动客户端 ID 建立的连接仍然有效。只有需要复用旧配置时，才选择「使用您自己的 OAuth 客户端」。</p><Fields credentials={oauth}/></details>}
    <details className="legacy-connection"><summary>高级：固定客户端凭据</summary><p>支持固定凭据的客户端可选择「无需登录」，并添加生成的 Authorization 请求头。凭据有效期为 90 天；重新生成会撤销原来的固定凭据，OAuth 授权仍保留。</p><div className="client-actions"><button className="button secondary" disabled={!enabled || busy} onClick={() => act("legacy")}>生成固定客户端凭据</button><button className="button secondary" disabled={!enabled || busy} onClick={() => act("remove-legacy")}>撤销固定凭据</button></div>{legacy && <Fields credentials={legacy} />}</details>
  </section>;
}
