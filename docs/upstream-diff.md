# 与上游 OW Bridge 的差异（内部维护参考）

基于上游 v0.2.13（github.com/louchi1984-coder/ow-bridge）定制，便于日后比对合并上游更新。

| 项目 | 上游 | 本项目 |
|---|---|---|
| 应用名 / 产物名 | OW Bridge | BuddyBridge |
| Bundle ID | local.buddy.bridge | local.buddybridge.desktop |
| 模型前缀 | OC · | BB · |
| 数据目录 | ~/Library/Application Support/Buddy Bridge | ~/Library/Application Support/BuddyBridge |
| 图标 | 蓝色连接符 | 蓝绿渐变悬索桥 |

未改动：内部所有权标记 `buddyBridgeOwner: buddy-bridge-v1`、本地端口 41980、代理核心 `src/` 全部行为（v1.0.2 仅增加运行时二进制绝对路径校验的安全加固，`exec` 更名 `execFileAsync`）。

## 本项目新增（上游没有）

- 关闭窗口 = 后台运行：macOS 收起 Dock 图标 + 一次性气泡提示（desktop/main.cjs）
- 侧栏微信二维码名片，点击放大（desktop/contact-card.jpg + #card-overlay）
- 侧栏版本号 + GitHub Releases 检查更新（UPDATE_REPO 常量在 desktop/main.cjs 顶部，默认 hindleycheng/BuddyBridge）
