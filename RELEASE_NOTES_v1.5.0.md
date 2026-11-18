## v1.5.0 — 写入目标可勾选，并新增 ZCode 支持

### 新增：写入目标勾选栏

主界面新增「写入目标」一栏，模型写入哪些平台由你决定：

| 平台 | 说明 |
|---|---|
| **WorkBuddy** | 国内版 `~/.workbuddy/models.json` |
| **国际版** | `~/.workbuddy-ai/models.json` |
| **DeepSeek Harness** | `~/.dsh` 的自定义提供商 |
| **ZCode**（新） | `~/.zcode/v2/provider_config.json` 个人提供商 |

- 只写入勾选的平台
- 取消勾选会**立即清理**该平台上本应用导入的条目，不动你自己的模型
- 未检测到配置的平台自动置灰不可勾选
- 默认全部开启（与旧版行为一致，升级即用）

### 新增：ZCode 写入目标

以「BuddyBridge」个人提供商身份写入，OpenAI 兼容接口指向本地服务：

- 模型名带 `BB · ` 前缀，与其他平台一致
- ZCode 侧热加载，无需重启
- 退出 BuddyBridge 或取消勾选时，只移除 buddybridge 提供商与对应条目
- 写入前自动备份（保留最近 5 份），配置损坏时拒绝写入、不覆盖原文件
- 个人提供商的 schema 已按 ZCode 运行时校验规则逐项对齐

### 修复

- ZCode 写入曾缺失 provider 声明、baseUrl 形式错误、`providerOrder` 位置错误，三者均已修正
- 重复导入时 ZCode 备份文件不再无限堆积

### 平台支持现状

| 平台 | 方式 |
|---|---|
| WorkBuddy 国内版 / 国际版 | 自动 |
| DeepSeek Harness | 自动 |
| ZCode | 自动 |
| Qoder CN | 需手动添加一次自定义端点（其凭据为应用内加密存储，无法外部写入） |

Qoder CN 手动配置三项：

- 端点 URL：`http://127.0.0.1:41980/v1/chat/completions`
- API Key：BuddyBridge 数据目录下的 `api-key` 文件内容
- 模型名：必须与 BuddyBridge 界面显示的名字逐字符一致

### 升级

安装后即可在「写入目标」中勾选需要的平台。已有配置不会被动到，未勾选的平台在首次导入前不会写入。
