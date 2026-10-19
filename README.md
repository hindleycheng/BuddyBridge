# BuddyBridge

跨平台托盘应用，通过隔离的 OpenCode 为 WorkBuddy 提供免费模型。Electron 界面 + Node.js 代理核心。

技术支持：@HindleyCheng

## 构建

```sh
npm ci
npm test
npm run desktop      # 开发模式运行
npm run build:mac    # 打包 macOS ARM64 ZIP（含签名完整性校验）
npm run build:win    # 打包 Windows x64
```

运行核心服务：`npm start`。开发依赖 Node.js 22+；打包后的应用不要求用户另装 Node。

## 使用（macOS）

1. 解压 `release/BuddyBridge-<版本>-mac-arm64.zip`，将 `BuddyBridge.app` 拖入"应用程序"。
2. 首次打开若被 macOS 拦截（ad-hoc 临时签名、未公证）：先尝试打开，再到"系统设置 → 隐私与安全性"点击"仍要打开"；仍提示"已损坏"时，确认来源可信后执行：

   ```sh
   xattr -dr com.apple.quarantine "/Applications/BuddyBridge.app"
   ```

3. 请先安装 WorkBuddy。首次启动自动准备 OpenCode（官方 npm 优先，失败尝试 npmmirror）、扫描免费模型、检测可用性；找到有效 WorkBuddy 配置后自动导入。
4. 关闭窗口 = 后台运行：窗口关闭后 macOS 的 Dock 图标一并收起、只保留状态栏图标（首次会有气泡提示），点击状态栏图标重新打开；Windows 最小化到托盘。从托盘退出才会真正退出（并清理本应用导入的模型）。
5. 模型名称为 `BB · ` 加 OpenCode 原名；本地服务端口默认 41980（可用 `BUDDY_PORT` 覆盖）。
6. 免费模型网关有地区限制：检测提示"网关拒绝或限制了请求"时，打开"使用系统代理"开关并让代理出口在允许地区，再点"检测全部"。

## 更新机制（OTA）

侧栏显示当前版本号，"检查更新"按钮（及托盘菜单"检查更新…"）查询 GitHub Releases：发现新版本时弹窗展示说明，点击"前往下载"打开浏览器下载页，覆盖安装即可。启动时也会静默检查一次。

- 更新源仓库配置在 `desktop/main.cjs` 顶部的 `UPDATE_REPO`（默认 `HindleyCheng/BuddyBridge`），也可用环境变量 `BUDDY_UPDATE_REPO` 覆盖。
- 发布新版本：打 tag（如 `v1.0.3`）并在 Release 上传对应的 zip/exe 即可，应用会自动识别。
- 检查更新走系统代理（Chromium 网络栈），国内网络需保证 GitHub 可达。
- 为什么不是全自动静默升级：应用为无签名构建（Mac ad-hoc），electron-updater 的下载-安装式自动更新要求正式签名；获得签名后可平滑升级为全自动。

## 使用（Windows x64）

运行 `BuddyBridge-<版本>-win-x64-setup.exe` 安装后启动（未做发布者签名，SmartScreen 可能提示未知开发者，选择"仍要运行"）。WorkBuddy 配置默认自动识别；找不到时点击"导入 WorkBuddy"旁边的托盘菜单"自动查找/选择 WorkBuddy 配置…"手动指定。首次使用请先在 WorkBuddy 保存一个自定义模型。

## 验证

`npm test` 覆盖协议校验、导入与退出清理、目录能力映射、图片转发、推理档位和系统代理解析（138 项全部通过）。免费模型及额度由上游决定，不承诺所有模型或复杂工作流均稳定。产物为 ad-hoc 临时签名，未做公证/发布者签名。

内部标记 `buddyBridgeOwner` 保持不变：先前由同源版本导入 WorkBuddy 的模型条目可被本版无缝接管与清理。本地服务端口固定 41980，请勿与其他实例同时运行。

---

致谢：本项目内核源自开源项目 [OW Bridge](https://github.com/louchi1984-coder/ow-bridge)（@娄老师说的对）。
