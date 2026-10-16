# Feishu MCP

公开服务页面：[访问现有站点](https://feishu-mcp.spiffy-bard-9497.chatgpt.site)。该地址用于查看当前服务；自己部署请使用自己的新站点地址与授权。

完整的飞书 MCP 服务与连接网站，可部署到自己的 ChatGPT Sites，连接 ChatGPT、Claude 或兼容的 MCP 客户端。包含前端、服务端、OAuth、D1 schema/迁移、91 个工具、安装构建脚本与回归测试。

应用版本基线 **0.9.8**；工具共 **91 个：48 个读取、43 个写入**。这是实现目录数量，不代表未配置权限的账号能立即调用全部工具。

## 能做什么

- 文档与知识库搜索/读取、结构、图片附件、评论与回复、导入导出。
- 电子表格、多维表格、日历日程、任务与任务清单、群聊/群公告、机器人状态、检查规则与妙记。
- 写入与删除工具覆盖文档、内容块、评论/回复、云空间文件、表格/记录、日程、任务/清单及明确范围的知识库节点；操作前核对目标，写入回执可重放，结果不确定时禁止盲目重复写入。
- 独立用户授权、加密保存飞书 token、OAuth PKCE、读取/写入 scope 隔离、令牌轮换、撤销和用户级限界。

**先部署与授权，再测试。** 项目不附带飞书账号、App Secret、ChatGPT 会话、真实文档、数据库或任何可用 token。飞书与 OpenAI/Anthropic 的产品商标不属于本项目；本项目不是官方产品。

## 快速开始

1. 阅读 [部署到 ChatGPT Sites](docs/DEPLOY_TO_CHATGPT_SITES.md)，从本仓库创建自己的新站点。
2. 按 [配置与权限](docs/CONFIGURATION.md) 创建飞书应用、配置回调、开通所需用户身份权限、发布应用并授权。
3. 通过 Sites 关联 `/mcp`，或将自己的 `/api/client-mcp` 添加到 Claude / ChatGPT，选择 OAuth。
4. 调用 `feishu_connection_status`，再用自己提供的文档链接做只读验证。要测试写入/删除，明确指定可删除的测试资源并在结束后清理。

```sh
pnpm install --frozen-lockfile
node scripts/test-core.mjs
node scripts/test-workspace.mjs
node scripts/test-mcp-oauth.mjs
pnpm typecheck
pnpm build
```

需要 Node.js 22.13+ 与 pnpm 11.25.0。生产依赖 ChatGPT Sites 的可信身份、Workers 和 D1；非 Sites 部署需要自行接好身份层，不能直接信任公网请求头。

## 文档

| 文档 | 内容 |
|---|---|
| [Sites 部署](docs/DEPLOY_TO_CHATGPT_SITES.md) | 导入、新项目、环境变量、D1、发布、ChatGPT/Claude 连接与升级 |
| [配置与权限](docs/CONFIGURATION.md) | 所有变量、飞书应用/用户/MCP 三层权限 |
| [完整工具目录](docs/TOOLS.md) | 从源码生成的 91 个工具与读写分类；JSON schema 一并公开 |
| [故障处理](docs/TROUBLESHOOTING.md) | 权限、删除、错误码、机器人、协议、旧工具列表 |
| [架构](docs/ARCHITECTURE.md) | 代码目录与身份/数据边界 |
| [隐私与完整性审计](docs/PRIVACY_AND_COMPLETENESS.md) | 脱敏项、逐文件对应、测试和边界 |
| [开源变更](docs/RELEASE_NOTES.md) | 相对应用基线的开源适配 |

## 已知限制

飞书应用可用范围、租户策略、资源分享、群类型和 API 权限都会限制调用；外部群公告等限制不能由 MCP 绕过。导入/导出支持类型由飞书接口决定。检查规则并非自带后台定时器，需要客户端或外部自动化调用。工具清单变化不会保证旧对话自动刷新，当前没有声明一个未实际运行的通知流。

## 许可证

项目自有代码采用 [MIT](LICENSE)。第三方构建/样式/协议 fixtures 的原许可证均保留，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。源码开源不包含任何平台服务、账号权限或真实数据授权。
