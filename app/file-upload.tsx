"use client";
import { useState, useRef } from "react";
export default function FileUpload({ enabled }: { enabled: boolean }) {
  const [busy, setBusy] = useState(false), [result, setResult] = useState(""), requestId = useRef("");
  return <section className="feature-card"><h2>上传文件</h2><p>选择文件上传到飞书云空间，单个文件最多 4 MiB。上传成功后可让助手把文件导入为飞书文档或表格。</p><form onChange={() => { requestId.current = ""; setResult(""); }} onSubmit={async event => {
    event.preventDefault(); setBusy(true); setResult(""); if (!requestId.current) requestId.current = crypto.randomUUID();
    const form = new FormData(event.currentTarget); form.set("request_id", requestId.current);
    try { const response = await fetch("/api/file-upload", { method: "POST", body: form }); const value = await response.json() as Record<string,string>; setResult(response.ok ? `上传成功：${value.file_name}\n文件标识：${value.file_token}` : value.message || value.error || "上传失败，请稍后重试。"); } catch { setResult("上传结果暂未确认。重试会保留同一请求标识，避免重复创建。"); } finally { setBusy(false); }
  }}><fieldset disabled={!enabled || busy}><label>选择文件<input name="file" type="file" required /></label><label>目标文件夹（可选）<input className="copy-field" name="folder_token" placeholder="不填则上传到根目录" /></label><button className="button secondary" type="submit">{busy ? "正在上传…" : "上传到飞书"}</button></fieldset></form>{!enabled && <p className="small">请先授权「上传文件到云空间」。</p>}{result && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} role="status">{result}</p>}</section>;
}
