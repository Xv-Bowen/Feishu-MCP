# 参与开发

1. 使用 Node.js 22.13+（发布验证使用 Node 24）与 `package.json` 固定的 pnpm 11.25.0。
2. `pnpm install --frozen-lockfile`，不要删除锁文件或切换包管理器来绕过安装错误。
3. 使用个人测试站点、测试账号与可删除的数据；不要把生产凭据写入源码或测试。
4. 运行 README 中的测试、`pnpm typecheck` 和 `pnpm build`。修改鉴权、权限或删除逻辑时同时补充对应行为测试。
5. 新工具更新工具目录、scope、服务版本和部署说明；旧客户端通常需要刷新工具列表或新开对话。
6. 发布前更新文件清单并扫描：`node scripts/audit-release.mjs --write`，然后 `node scripts/audit-release.mjs`。

项目采用 MIT；第三方内容保持其原许可。数据来源的使用条款、品牌与商标权不随本仓库许可证转让。
