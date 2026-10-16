# 代码结构与数据边界

| 目录 | 内容 |
|---|---|
| `app/` | 网站页面、登录/授权页、API、OAuth metadata 与 MCP HTTP 路由 |
| `lib/` | 飞书 API、权限、用户隔离、加密、幂等写入、删除核验、MCP 工具 |
| `db/`、`drizzle/` | D1 表定义、完整迁移 SQL 与 Drizzle 元数据 |
| `build/` | Sites/Vite/Workers 运行和本地开发接入源码 |
| `scripts/` | 安装/构建辅助、回归测试、发布审计 |
| `components/`、`public/`、`vendor/` | UI 组件、静态资源及保留许可证的样式 |
| `.openai/hosting.json` | 新站点所需 D1/MCP 能力声明，不含原项目 ID |


HTTP 请求经 Sites 身份层到应用。原生 `/mcp` 接受平台验证的身份；外部 MCP 先验证自身 OAuth token 后确定用户，不能用客户端自报身份覆盖。OAuth state、PKCE、CSRF、一次性授权码、refresh rotation 与撤销均有回归测试。

飞书用户 token、写入回执等敏感内容在 D1 加密保存，外部客户端获得的是本站 OAuth token，不直接得到飞书 token。每个用户单独授权；机器人权限有独立检查，不能因用户权限不足而偷偷使用机器人身份。

此次发布以两个当前生产项目的完整跟踪源文件为基线。旧工作目录中的同项目历史检出不重复收录；已被当前同站 OAuth 路径替代的旧独立 Claude 转发网关不属于当前部署依赖。开源快照不携带原 Git 历史、运行数据、平台凭据或构建产物。具体文件对应关系与排除原因见 [PRIVACY_AND_COMPLETENESS.md](PRIVACY_AND_COMPLETENESS.md)。
