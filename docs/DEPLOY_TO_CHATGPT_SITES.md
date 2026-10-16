# 部署到自己的 ChatGPT Sites

本指南对应本仓库代码快照。需要当前账号/工作区具有 Sites、GitHub 导入和 MCP 插件功能；入口名称与可用范围可能变化。这里部署的是自己的新站点，不会继承原作者的账户、数据、域名或密钥。

## 1. 从仓库创建新站点

在可使用 Sites 的 ChatGPT 对话中给出本仓库 URL，要求 Sites 导入完整工程并部署。可以使用以下提示词：

```text
使用 Sites 将 https://github.com/Xv-Bowen/Feishu-MCP 部署成我的新站点。
先阅读 README 和 docs/DEPLOY_TO_CHATGPT_SITES.md。
保留所有 API、MCP、OAuth、前端、build 源码、锁文件、D1 schema 和 migrations。
创建新的 Sites 项目，填入新返回的 project_id；不要复用别人的项目标识。
保留 .openai/hosting.json 的 d1=DB 与 capabilities=["mcp"]。
先安装依赖、运行测试和生产构建，再配置部署变量、迁移 D1 并发布。
请通过安全的密钥设置收集敏感值，不要把它们写入仓库、公开聊天或构建日志。
发布后验证网页、未授权访问、OAuth 发现、工具列表和一个获授权的只读调用。
```

仓库已移除 `.openai/hosting.json` 中原有 `project_id`。该文件保留数据库与 MCP 能力声明；新标识由 Sites 创建项目时返回，不能自行编造。`build/` 是项目实际依赖的源码，不能为了“精简”删掉。

## 2. 安装与构建

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

本工程是 Next.js API 风格、Vinext/Vite、Cloudflare Workers 运行时。不能只上传静态 HTML 或只部署前端。Sites 负责托管 Worker、D1 和可信用户身份；`drizzle/` 内 SQL 及元数据均需随源码保留，部署流程将迁移应用到绑定 `DB`。先部署测试实例并查看迁移日志，升级前备份生产数据库。

Linux Sites 托管环境提供 `pnpm install:ci` 安装入口。普通电脑直接使用上述 pnpm 命令；`scripts/install-ci.mjs` 是保留的历史 npm 辅助文件，不是本 pnpm 项目的推荐安装入口。不要照搬某次会话的绝对路径或工具缓存目录。

## 3. 设置环境变量

变量清单见 [CONFIGURATION.md](CONFIGURATION.md) 和根目录 `.env.example`。填写自己新站点的完整 HTTPS 源地址作为 `SITE_ORIGIN`，不带路径、查询参数或末尾多余部分。生产敏感值放在 Sites 的环境变量/密钥设置中。

先创建自己的飞书应用，开通所需用户身份权限、配置回调并发布应用，再用自己的飞书账号授权。应用权限、用户授权、MCP 写入许可是不同层，缺一不可。

## 4. 发布与连接

| 连接方式 | MCP 地址 | 说明 |
|---|---|---|
| Sites 自动关联插件 | `https://你的站点/mcp` | 由平台管理身份与插件，保留 `capabilities: ["mcp"]` |
| Claude / 手动 ChatGPT MCP | `https://你的站点/api/client-mcp` | OAuth，客户端自动注册或官方客户端身份；通常无需填写 client secret |

外部客户端需要能够访问 HTTPS OAuth 发现入口。若整站仍是平台私有入口，第三方客户端可能先收到平台 403 或登录页。需要外部连接时，将新站点入口设为可访问，并保留应用内 OAuth 与用户隔离；不要通过删除鉴权解决 401。还需设置 CLIENT_MCP_PUBLIC=true。

首次连接的正确顺序：访问站点 → 登录 ChatGPT → 连接自己的飞书并选择功能权限 → 添加 MCP 地址 → 在授权页确认范围 → 返回客户端 → 调用状态工具。客户端界面可能变化，以其当前官方入口为准。

## 5. 发布后验收

- 匿名请求只能获得允许公开的元数据/工具 schema；读取业务数据必须要求身份或 OAuth。
- 使用自己账号完成一次 OAuth 授权、工具列表和只读调用；再验证退出或撤销后无法访问。
- 确认 91 个工具的完整列表；只读授权不能执行写入，写入必须具有 feishu.write 和相应飞书权限。
- OAuth 的 issuer、resource、回调都应指向自己的站点；任何原作者域名都不应出现。
- 升级后刷新关联插件/手动连接器的工具列表，再新开对话；旧对话可能保留旧 schema。

## 本地开发及非 Sites 托管

复制 `.env.example` 为忽略的本地配置，根据本地 Workers 工具要求使用 `.dev.vars`，再运行 `pnpm dev`。本地模拟身份的逻辑在 `build/sites-vite-plugin.ts`，它仅用于开发服务；要调试所有者限制，测试身份必须与本地变量匹配。生产必须使用真实可信身份。

可以移植到其他 Cloudflare/VPS 环境，但需要自行实现身份代理、D1 绑定和迁移、OAuth 回调、HTTPS、secret 管理；本仓库不提供绕过 Sites 身份体系的一键公网部署命令。

参考官方说明：[Sites 概览](https://learn.chatgpt.com/docs/sites)、[创建站点](https://learn.chatgpt.com/docs/sites/creating-a-site)、[发布与分享](https://learn.chatgpt.com/docs/sites/publishing-and-sharing)、[ChatGPT MCP 连接](https://developers.openai.com/plugins/deploy/connect-chatgpt)。本仓库开源应用代码，不包含或重新分发 OpenAI 的托管平台本身。
