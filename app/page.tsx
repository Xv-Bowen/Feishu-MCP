import { env } from "cloudflare:workers";
import { getChatGPTUser, chatGPTSignInPath } from "./chatgpt-auth";
import { configuration, status } from "../lib/feishu";
import { SCOPES } from "../lib/core";
import { EXTRA_FEATURES } from "../lib/features";
import { SERVICE_DESCRIPTION, SERVER_INFO } from "../lib/branding";
import { MCP_SCOPES } from "../lib/client-permissions";
import ConnectionTest from "./connection-test";
import ChatTest from "./chat-test";
import BotCheck from "./bot-check";
import FileUpload from "./file-upload";
import { CLIENT_TOOLS, CLIENT_READ_TOOLS, CLIENT_WRITE_TOOLS } from "../lib/client-access";
export const dynamic = "force-dynamic";
const ERRORS: Record<string, string> = {
  configuration_required: "请先配置应用密钥，并应用更新后的托管设置。",
  invalid_state: "授权链接已过期或已使用，请重新连接。",
  invalid_input: "授权功能选项无效，请重新选择。",
  access_denied: "你取消了飞书授权，可以随时重新连接。",
  invalid_code: "没有收到有效授权码，请重新连接。",
  oauth_error: "飞书授权未成功。请检查应用密钥、回调地址及所选功能的权限是否已开通并发布。",
  reauthorization_required: "飞书授权需要更新。请检查应用配置，再重新连接。",
  identity_required: "请使用你的 ChatGPT 账号登录此连接页面。",
  missing_offline_access: "请在飞书应用中开通 offline_access，并发布应用后重新连接。",
  identity_failed: "飞书账号验证失败，请检查用户基本信息权限。",
  feishu_api_error: "飞书权限或账号验证未成功，请检查应用权限并重新连接。",
  service_error: "服务暂时不可用，请稍后重试。",
  encryption_key_unavailable: "服务的授权保护配置尚未就绪，请联系创建此服务的助手修复。",
  provider_redirect: "飞书接口发生跳转，连接已中止，请联系创建此服务的助手检查。",
};
const cards = [
  ["≡", "文档阅读与编辑", "搜索和阅读正文、结构与评论；创建编辑文档，添加、回复和解决评论。"],
  ["⌕", "知识库与目录", "列出可访问的知识空间，解析知识库链接，逐页查看目录。"],
  ["▧", "图片与附件", "查看图片和下载附件，上传文件，导入或导出云文档。图片最多 5 MB，上传最多 4 MiB，下载最多 64 MiB。"],
  ["▦", "电子表格与多维表格", "读写单元格、操作工作表与样式；筛选、排序和批量新增多维表格记录，创建数据表。"],
  ["◷", "日历与日程", "查看忙闲、日程和参会人，创建和修改普通、全天或重复日程，按需邀请参会人。"],
  ["↳", "群聊与话题阅读", "读取群公告、Pin 和标签页，搜索并核对消息全文与表情反馈，阅读话题回复。"],
  ["✓", "任务与清单", "创建、分派和完成飞书任务，设置截止时间，管理个人任务清单。"],
  ["♫", "妙记文字记录", "读取有权访问的会议转写，保留说话人与时间戳，分段核对会议内容。"],
  ["↻", "定时增量检查", "保存指定群的新消息和公告变化，支持关键词、检查进度与去重；通过已连接的定时任务触发。"],
];
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getChatGPTUser();
  const params = await searchParams;
  const cfg = configuration(env);
  let connection: { connected: boolean; account_name?: string | null; messaging_ready?: boolean; features?: Array<{ id: string; ready: boolean }> } = { connected: false };
  let unavailable = false;
  try { connection = await status(env, user?.userId || null); } catch { unavailable = true; }
  const error = typeof params.error === "string" ? ERRORS[params.error] || ERRORS.service_error : null;
  const grantedFeatures = new Set(connection.features?.filter(feature => feature.ready).map(feature => feature.id));
  const allFeaturesGranted = connection.connected && grantedFeatures.size === EXTRA_FEATURES.length;
  const authorizationLabel = connection.connected ? "更新授权范围" : "连接飞书";
  return <main>
    <header><a className="brand" href="/"><img className="brand-icon" src="/favicon.svg" alt="飞书" width={33} height={33} />飞书<span className="brand-tag">CLOUD</span></a><span className="private-pill"><i />公开入口 · 按账号授权</span></header>
    <section className="hero"><div className="eyebrow">文档、表格、日程与群聊</div><h1>{SERVICE_DESCRIPTION}</h1><p>在 ChatGPT 中按你的授权读取资源、编辑文档与表格、管理日程。</p></section>
    {error && <div className="notice error" role="alert">{error}</div>}
    {unavailable && <div className="notice error" role="alert">连接存储暂时不可用，请稍后刷新。</div>}
    {allFeaturesGranted && <div className="notice">{EXTRA_FEATURES.length} 组新增功能均已授权，可以继续使用已有连接。需要调整功能范围时，再点击「更新授权范围」。</div>}
    {connection.connected && grantedFeatures.size < EXTRA_FEATURES.length && <div className="notice">原有连接仍可使用。新增功能需先在飞书应用中开通权限，再在下方选择功能并补充授权。</div>}
    {params.disconnected && <div className="notice">已移除本服务保存的飞书授权。若需撤销应用权限，可前往飞书的已授权应用管理。</div>}
    <section className="connection-card"><div><span className={`status-dot ${connection.connected ? "ready" : ""}`} /><span className="status-text">{!user ? "尚未登录网站" : connection.connected ? allFeaturesGranted ? "新增功能授权已齐全" : "飞书账号已连接" : cfg.configured ? "等待飞书授权" : "等待完成应用配置"}</span><h2>{!user ? "登录以查看你的连接" : connection.connected ? connection.account_name : "连接你的飞书账号"}</h2><p>{!user ? "使用原先的 ChatGPT 账号登录，查看该账号已有的飞书连接和授权。" : connection.connected ? "此账号已有飞书连接；下方可查看或调整功能范围。访问和编辑范围还取决于目标资源的权限。" : "完成应用设置，选择需要的功能，在飞书页面确认授权。"}</p></div>
      <div className="connection-actions">{!user ? <a className="button primary" href={chatGPTSignInPath("/")} target="_top">使用 ChatGPT 登录</a> : <><button className="button primary" form="feature-authorization" disabled={!cfg.configured || unavailable}>{authorizationLabel}<span>↗</span></button>{connection.connected && <form action="/api/connection" method="post"><button className="button secondary">解除此连接</button></form>}</>}</div>
    </section>
    <section className="feature-card"><h2>选择需要的功能</h2><p>默认保留文档与群聊阅读、搜索和离线续期。勾选编辑功能后，AI 可按你的明确请求写入有权编辑的资源。重新授权时保留需要继续使用的选项。</p>
      <form id="feature-authorization" action="/auth/feishu/start" method="post"><fieldset disabled={!user || !cfg.configured || unavailable}><legend className="sr-only">补充功能授权</legend><div className="feature-options">{EXTRA_FEATURES.map(feature => <label key={feature.id}><input type="checkbox" name="features" value={feature.id} defaultChecked={grantedFeatures.has(feature.id) || params.feature === feature.id || params.feature === "all"} /><span>{feature.title}{feature.write && <em>可写入</em>}<small>{!user ? "登录后查看" : grantedFeatures.has(feature.id) ? "已授权" : "待授权"}</small></span></label>)}</div></fieldset><button className="button primary" disabled={!user || !cfg.configured || unavailable}>{authorizationLabel}</button></form>
    </section>
    <section className="feature-card"><h2>MCP 连接</h2><p>当前接口提供 {CLIENT_TOOLS.length} 个工具：{CLIENT_READ_TOOLS.length} 个读取工具、{CLIENT_WRITE_TOOLS.length} 个创建和修改工具。写入同时需要本次插件的 MCP 写入许可和上方对应的飞书编辑权限。</p>
      <p className="small">新增工具后，在现有 ChatGPT 插件管理页刷新工具列表，再新开对话加载。若写入仍提示只有读取许可，再重新连接并确认「允许读取和编辑」。已有飞书账号和功能授权会保留。</p>
      <p className="small">Claude 看不到新增工具时，先新开对话；仍未更新，再到连接器设置中断开并重新连接此服务。已有对话可能继续使用旧工具列表。单纯的服务端修复不需要重做飞书授权。</p>
      <p className="small">Claude 若显示只有读取许可，请在 Claude 的连接器设置中断开并重新连接此服务。新授权页应显示「允许读取和编辑」；只刷新工具列表或重做飞书授权，不会改变旧的 MCP 只读许可。</p>
      <label>服务器 URL<input className="copy-field" aria-label="MCP 服务器 URL" value={`${cfg.origin}/api/client-mcp`} readOnly /></label>
      <p>选择 OAuth 后重新检测服务器设置，使用自动客户端识别或动态注册，无需手填客户端 ID 和密钥。首次连接需确认授权，之后在授权有效期内自动续期。</p>
      {env.MCP_OAUTH_CLIENT_ID && <details><summary>手动客户端设置（仍可使用）</summary><label>OAuth 客户端 ID<input className="copy-field" aria-label="MCP OAuth 客户端 ID" value={env.MCP_OAUTH_CLIENT_ID} readOnly /></label><p className="small">客户端密钥留空，Token 端点身份验证方法为 none。原有手动连接可以继续使用。</p></details>}
      <label>OAuth 授权范围<input className="copy-field" aria-label="MCP OAuth 授权范围" value={MCP_SCOPES.join(" ")} readOnly /></label>
      <p className="small">读取和写入许可分别确认；旧只读授权仍可读取，写入时会提示确认新增许可。固定 API 凭据继续保持只读。</p>
    </section>
    <section className="steps"><div className="section-heading"><h2>应用设置与补充授权</h2><span>全程无需运行本地程序</span></div>
      <article><div className="step-number">01</div><div><h3>配置飞书应用</h3><p>在飞书开放平台打开已有应用，在「安全设置」中添加以下重定向 URL：</p><input className="copy-field" aria-label="飞书重定向 URL" value={cfg.callback_url} readOnly /><p className="small">应用 ID：<code>{cfg.app_id}</code>。保留原有回调地址，再增加这一条。</p><a className="text-link" href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">打开飞书开发者后台 ↗</a></div></article>
      <article><div className="step-number">02</div><div><h3>确认密钥与功能权限</h3><p>在应用的「权限管理」中搜索并开通下方所需权限，保存并发布版本。新增功能需对应的用户身份权限；组织可能要求管理员审批。</p><p className="small">应用密钥保存在 ChatGPT Sites 的秘密设置中。新增功能沿用已有 App Secret，无需创建另一套应用。</p><span className={`inline-state ${cfg.configured ? "done" : ""}`}>{cfg.configured ? "✓ 托管应用配置已就绪" : "○ 待配置：应用密钥"}</span></div></article>
      <article><div className="step-number">03</div><div><h3>{allFeaturesGranted ? "飞书功能授权已完成" : "按需授权功能"}</h3><p>{allFeaturesGranted ? `当前账号的 ${EXTRA_FEATURES.length} 组新增功能均已授权。只有需要调整所选功能时，才使用「更新授权范围」。` : "飞书应用发布后，在上方勾选需要的功能并连接飞书；已有连接可使用「更新授权范围」补充或调整权限。完成后刷新页面，确认各项显示「已授权」。"}</p><p className="small">OAuth 插件的读取、写入许可分别确认；飞书功能授权不会自动扩大旧插件的只读许可。请在 MCP 连接中批准 feishu.write 后使用创建和修改工具。</p></div></article>
    </section>
    <section className="tools-grid">{cards.map(([symbol,title,description]) => <div className="tool-card" key={title}><span className="tool-symbol">{symbol}</span><h3>{title}</h3><p>{description}</p></div>)}</section>
    <FileUpload enabled={grantedFeatures.has("file_upload")} />
    <BotCheck enabled={connection.connected} appId={cfg.app_id} />
    <ConnectionTest enabled={connection.connected} /><ChatTest enabled={!!connection.messaging_ready} />
    <details className="permissions"><summary>查看所需飞书权限<span>＋</span></summary><h3>原有阅读与搜索</h3><ul>{SCOPES.map(scope => <li key={scope}><code>{scope}</code></li>)}</ul>{EXTRA_FEATURES.map(feature => <div key={feature.id}><h3>{feature.title}</h3><ul>{feature.scopes.map(scope => <li key={scope}><code>{scope}</code></li>)}</ul></div>)}<p>电子表格、多维表格、日历及文档的完整编辑权限也可用于对应读取功能。功能授权不改变文件、表格或日历自身的访问权限。</p><p>每次按需读取一页或一个范围。API 调用计入飞书组织配额，管理员可在管理后台「我的配额」查看实际用量。消息资源下载还受飞书会话和应用能力限制。</p></details>
    <footer><span>飞书 · {SERVER_INFO.version}</span><span>公开页面 · 数据按账号隔离 · 授权加密保存</span></footer>
  </main>;
}
