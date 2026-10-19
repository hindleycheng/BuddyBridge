# OpenCode 2 兼容验证（2026-10-18）

本次使用 macOS ARM64 和 Windows x64 实机、官方 `@opencode/cli` 2.0.32。

- 新增 V2 CLI 版本识别、原生二进制发现、模型目录映射、会话提交/等待、权限拒绝、消息读取与取消适配。已有外部工具解析、纠正和转换逻辑继续复用。
- 1.x 使用原 `opencode` 数据目录；2.x 使用 `opencode-v2`，避免两个版本的数据库相互冲突。
- 删除此前加入的免费层 403 自动回退 1.x 逻辑，不通过降级掩盖 V2 请求错误。
- 无本地运行时时仍使用原官方 npm `opencode-ai` 下载路径；本次没有把默认下载通道切换到 V2。

## 实际网络对照

使用相同官方 V2 二进制、适配层和独立配置，仅切换系统代理环境：

| 模型 | 直连（再次复测） | 系统 HTTP/HTTPS 代理 |
| --- | --- | --- |
| Big Pickle | 403 FreeTierError | 正确返回外部 Read 调用 |
| Space Bunny | 403 FreeTierError | 正确返回外部 Read 调用 |

报错为 `OpenCode's free tier can only be used from within OpenCode`。此前官方 CLI 自身在直连下也复现了这一错误。此对照证明网络路径影响本机结果，不能据此确定上游具体拒绝原因。未修改鉴权、请求头，也未复制用户凭据；保留用户保存的系统代理开关。

## Mac 直连进一步定位（2026-10-18）

同一官方 2.0.32 二进制、相同隔离配置、Big Pickle 与 Space Bunny 两个模型，逐轮切换网络路径：

| 路径 | 结果 |
| --- | --- |
| 默认直连 | 本轮三次启动共 6 次模型检测均返回 FreeTierError |
| 本地宽带固定 IPv4 | 两轮共 4 次检测均返回 FreeTierError |
| 本地宽带固定 IPv6 | 两轮共 4 次检测均成功返回正确外部 Read 调用 |
| 已配置系统代理 | 本轮 2 次检测均成功 |

固定地址类型使用测试用的本机 CONNECT 转发器，仅限制上游 socket 的 `family`；TLS 由官方 OpenCode 与服务端直接协商，未解密请求、伪造请求头、改鉴权或经过外部代理。两轮分别命中不同的服务端地址，结果保持一致。

通过 `lsof` 记录默认直连 OpenCode 子进程，确认实际推理连接使用 IPv4，而非根据 curl 的地址选择推断。curl/Node 的 Cloudflare trace 另确认本机 IPv4 与 IPv6 均为国内出口；系统代理是另一出口。因而不能把结果解释成“必须使用 VPN”或“中国出口一律不可用”。Windows 的 IPv4 出口与 Mac 相同，IPv6 地址不同；此前 Windows 直连成功时未记录推理 socket，不能断言它用了哪一种。

可以确定本机当前默认 IPv4 推理路径被上游拒绝，本地 IPv6 路径可用。仍不能仅凭统一 FreeTierError 判断是出口 IP 限制、额度、风险判断，还是上游不同路径的服务策略异常；具体拒绝规则需要服务端日志。排查阶段未修改产品网络默认值、系统 DNS 或 VPN 设置。随后按用户要求，将关闭系统代理的模型路径固定为本地 IPv6，开启开关则保留系统代理路径。

相关上游报告：[官方客户端的同类网络相关 403](https://github.com/anomalyco/opencode/issues/56334)。该报告不是本机根因的证明，以上结论来自本机对照实验。

## 完整请求验证

通过 OW Bridge 的真实 `/v1/chat/completions` HTTP 接口，对上述两个模型分别验证：

1. 返回正确的外部 Read 工具调用，原生工具执行尝试为 0。
2. 回传模拟的外部工具结果 `OW-V2-ROUNDTRIP-OK`。
3. SSE 回答包含该结果并以 `[DONE]` 正常结束。
4. 实际运行版本始终为 2.0.32，无版本回退。
5. 使用打包后 Mac App 的 Electron Node 运行时及包内源码重复上述两模型流程，全部通过。Mac ZIP 解包后通过 codesign 深度完整性验证。

全部 110 项自动化测试通过。自动化用例另覆盖原生调用拒绝并交接、上游错误、取消和清理、模型能力映射与版本发现。

## Windows 实机补测

- Node.js 22.16.0，官方 npm `@opencode/cli@2.0.32` 独立安装；未替换用户全局 OpenCode，也未修改 WorkBuddy 配置。
- 修复前 110 项自动测试通过，但真实服务启动报 SQLite `unable to open database file`。更换斜杠格式、预建父目录、完整环境及显式数据库路径均未解决；预建空数据库后变成 `attempt to write a readonly database`，标准版与 baseline 二进制均复现。
- 官方 `OPENCODE_DB=:memory:` 使服务正常启动。因此仅对 Windows V2 设置内存数据库，继续保留独立配置和缓存目录。桥接每轮提交完整上下文并清理临时会话，不依赖 OpenCode 跨进程保存对话；WorkBuddy 中的对话不受影响。
- 修复后 Windows 实机再次通过 110 项自动测试，Mac 回归同样 110 项通过。
- 内存数据库实测读取 12 个免费模型，Big Pickle 与 Space Bunny 在直连下均通过外部 Read 调用、结果回传、SSE 结束验证，没有原生工具执行尝试。
- 这台 Windows 的系统代理配置为启用，但配置的回环端口拒绝连接；npm 经该代理失败，直连官方下载成功。没有更改用户系统代理配置，不能将无效代理的失败算作模型接口失败，也不能宣称已通过 Windows 系统代理端到端测试。
- 打包后的 Windows Electron 程序（包内源码）再次通过两模型完整 HTTP 往返，进程退出码 0。生成 `OW-Bridge-0.2.10-win-x64-portable.zip`；electron-builder 的 GitHub 下载超时，改用本机同版本 Electron 缓存完成程序目录，再以标准 ZIP 压缩。未进行桌面 UI 点击或 WorkBuddy GUI 任务测试。
- 可复现的真实验证脚本：`node scripts/smoke-opencode-v2.mjs <OpenCode 2 binary> [--proxy]`。脚本使用独立临时目录和本地随机端口，工具结果为测试数据，不导入 WorkBuddy。90 秒限时仅用于测试请求，不改变产品超时策略。

## 边界

补跑 Mac 时 Big Pickle 在工具结果回传后有一次 `invalid_model_output`，Space Bunny 通过；此前成功不能保证每次模型输出都符合格式。

未在 WorkBuddy GUI 中复测完整任务；不能将两个模型的成功推广为所有模型或所有复杂任务均通过。Mac 产物使用临时签名，不是 Apple Developer ID 签名或公证。

## IPv6 开关实现

Bun 官方支持 `BUN_OPTIONS=--dns-result-order=ipv6first`，但在本机 2.0.32 二进制中实测推理连接仍使用 IPv4 并被拒绝，因此未采用该参数。实现采用仅监听回环地址的 CONNECT 转发器，固定 `net.connect` 的 `family: 6`，TLS 仍由官方客户端与服务器协商。转发器随运行时停止、异常退出或启动失败清理；不更改系统 DNS，不回退 IPv4。开启系统代理时不创建该转发器。

新增测试覆盖 IPv6 连接选项、字节透传、活动连接关闭、连接失败和目标范围校验。

本轮验证：Mac 与 Windows 各通过 112 项测试；Mac OpenCode 2.0.32 在 IPv6 直连和系统代理两种模式下，Big Pickle、Space Bunny 均完成工具调用与 SSE 结果回传。Windows 免安装包中的 Electron/源码在 IPv6 直连下完成同样两模型往返。Mac 旧版 1.19.3 的两个模型工具探测也通过。修复了一处客户端连接重置未被捕获的问题，避免网络断开导致进程退出。以上均使用独立测试目录，未修改 WorkBuddy 配置。

Mac 新包签名完整性校验通过。包内 Electron 复测 Space Bunny 完整通过；Big Pickle 本轮触发测试脚本 90 秒等待上限，源码同路径此前通过。仍需保留模型响应波动的限制说明，不代表所有调用稳定。

Windows 最后一轮包内复测 Big Pickle 的首次工具调用通过，结果回传阶段超过测试脚本 90 秒上限；前一轮同版本双模型完整通过。最后补丁仅捕获客户端 socket 错误，不能据此宣称模型响应波动已解决。
