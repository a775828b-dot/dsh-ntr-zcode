# Dsh ntr Zcode

[English](README.en.md) | [验证记录](test/verification.md) | [Apache-2.0](LICENSE)

通过 ZCode 原版移动网页，在手机浏览器访问 DeepSeek Harness (DSH) 桌面端的真实工作区和会话。

**独立、实验性的第三方插件，不是 ZCode 或 DeepSeek 官方产品。** 插件转换协议，不修改 DSH 官方源码、不另起智能体。当前版本 **0.4.1**，已验证 DSH **0.2.0-rc.2**，并通过 **0.2.1-alpha.2** 源码 Host 的四组 Chrome 回归（[兼容记录](test/compatibility-0.2.1-alpha.2.md)）；不保证其他版本或未来升级兼容。**尚未实现 ZCode 全部功能。**

## 介绍视频

[在哔哩哔哩观看插件介绍与使用演示](https://www.bilibili.com/video/BV19Spo6yEkA/)。视频可能展示较早版本，当前功能与限制以本 README 为准。

## 工作方式

```text
iPhone / 手机浏览器
  ZCode 原版网页 https://zcode.z.ai/remote/v4
            |
  官方中继 wss://zcode.z.ai/ws
            |
  Dsh ntr Zcode 插件
            |
  DSH 桌面 Host、真实会话、模型和权限
```

不要求同一局域网，不需要手机 App。电脑上的 DSH 必须保持运行且能联网。这不是 P2P，也不是端到端加密：WSS 只提供逐跳传输加密，网页和中继运营方是信任依赖。第三方调用官方公共中继仅验证了技术兼容性，不代表获得服务承诺或长期可用保证。

## 功能和边界

| 功能 | 0.4.1 状态 |
| --- | --- |
| 选择已共享工作区、读取真实会话、新建会话 | 支持 |
| 文本发送、回复流式显示、停止生成 | 支持 |
| 切换已有模型和推理强度 | 读取 DSH 实际模型目录，发送时生效 |
| 图片发送、持久化及历史预览 | PNG/JPEG/WebP/GIF；最多 4 张，每张 8 MiB |
| 手机切换三档权限 | 需要先在桌面插件设置中单独授权 |
| 开启、停止、刷新二维码、复制链接 | 支持 |
| 网页刷新后恢复当前会话 | 支持 |
| 手机审批、结构化问答 | 本地单独授权后支持单次允许/拒绝、多选与自由文本 |
| 排队、撤回编辑、删除 | 已接入真实 DSH Inbox；插话映射下一步 steering |
| 计划模式、待办、目标创建/暂停/继续 | 已接入 DSH；停止生成同时暂停活动目标 |
| 历史翻页、上下文压缩 | 已接入；Chrome 验证 230 条历史与真实压缩检查点 |
| 会话分支、置顶、归档及恢复 | 已接入；Chrome 验证 Host 持久状态 |
| 普通文件上传 | 与图片合计最多 4 个，每个 8 MiB；不代表模型能理解所有文件格式 |
| 工具输入/输出、实时及持久化思考、上下文和 Token 用量 | 映射 DSH 记录；实时思考有单测，尚未 Chrome 验证；不包含计费报表 |
| 桌面目录实时同步 | 新会话、标题和归档变更轮询推送，无需手动刷新 |
| 更多菜单重命名、复制回复/会话 ID、三档主题 | 支持；主题只影响网页，不修改 DSH 设置 |
| 新建工作区目录、终端、文件浏览器、Git 审查 | 未实现 |
| 队列拖动排序、暂停自动消费、立即中断并发送 | 未实现；不把下一步插话冒充立即发送 |
| HEIC/SVG 图片、音视频播放、普通文件历史预览 | 未实现；非图片可作为普通附件传入 DSH |
| 全局设置、密钥、MCP/Skills/插件管理、机器人、子代理控制 | 未实现，仍使用桌面 |

原版网页可能仍显示不支持的控件，不能据此认定功能已适配。图片理解还取决于模型自身的视觉能力。跨项目请返回手机任务首页。详细优先级、语义差异与验证范围见[验证记录](test/verification.md)。

0.4.1 已修复桌面改名后手机标题栏不同步，严格 `--history` 回归及置顶会话改名验证通过。放弃草稿时，仅归档本次远程创建、尚未使用且未改名/置顶的空会话，**可从归档恢复，不永久删除**；已有会话不会自动清理。异常断网或退出时未送达清理请求，仍可能留下空草稿。“标记为未读”、调用轨迹、点赞/点踩、引用会话/插件/文件等入口未适配，不能视为所有按钮均可用。

审批接管默认关闭，只处理授权工作区的新请求。手机断开、停止配对或 120 秒未答复会交回桌面，不自动批准。限时问答受 DSH 自身期限约束；手机只能延后一次，不能无限占用请求。已交回桌面的请求不能从旧手机卡片重复批准。

DSH 停止保留后续队列，不等价于 ZCode 暂停自动消费。目标完成映射网页的完成状态，不代表执行了 ZCode 独立验证器；目标计时、验证历史尚未映射。普通附件没有任意路径读取能力，历史文本文件在原版网页中也没有预览按钮。

## 安装

前提：Node.js 22 或更新版本、npm，以及已安装的 DSH 桌面端。以下命令在 PowerShell 中执行：

```powershell
git clone https://github.com/a775828b-dot/dsh-ntr-zcode.git
cd dsh-ntr-zcode
# 正常退出 DSH 后安装；脚本不会强制结束 DSH。
.\scripts\install.ps1
```

脚本安装依赖、运行单元测试、打包，再调用桌面自带 CLI 安装到 `desktop` profile。非默认安装位置可指定 `-DshCli '完整路径\dsh.cmd'`。只构建安装包：`.\scripts\install.ps1 -PackOnly`。安装不会自动开启远程访问。

也可以手动打包并使用自己的 DSH CLI：

```sh
npm ci --ignore-scripts
npm test
npm pack
dsh plugin --profile desktop add ./dsh-ntr-zcode-0.4.1.tgz
```

实际验证环境是 Windows 桌面端；macOS/Linux 安装未验证。此仓库发布不等于已发布到 npm registry。

## 手机连接

1. 重新打开 DSH，在设置中打开 **Dsh ntr Zcode**。
2. 选择允许共享的已注册工作区，阅读并确认远程访问提示。
3. 按需勾选手机权限切换、接管新审批和问答，两项授权默认关闭，必须在开启远程前选择。
4. 开启远程，用 iPhone 相机扫码，在浏览器打开完整链接；也可以复制链接。
5. 从手机任务首页选择项目和会话，再发送消息。

不要单独打开不带配对参数的 `/remote/v4`。停止、刷新二维码或重启后，必须使用新二维码/链接。

## 权限和模型

| ZCode 网页模式 | DSH 权限 | 说明 |
| --- | --- | --- |
| 变更前确认 | 仅可查看 (`read-only`) | 保守映射，比原模式更严格，不完全等价 |
| 自动编辑 | 工作区内修改 (`workspace-write`) | 更广泛操作仍受 DSH 审批约束 |
| 完全访问 | 完全权限 (`danger-full-access`) | 允许完整 DSH 权限，谨慎授权 |

未授权手机切换权限时，仅接受与会话当前权限一致的模式。插件调用标准 `/permission` 命令并检查结果，不修改部署默认权限。网页草稿模式和模型选择通常在发送时生效。

推理强度完全来自 DSH 配置：如 GLM 只配置 `max`，手机就没有其他档位。模型切换使用 DSH 标准接口，会像桌面选择器一样更新默认模型。插件不把模型 API 密钥或服务地址发给手机。

## 安全与有效期

- 二维码和完整链接是访问凭证，**不要公开截图、提交到 Issue 或分享给不可信的人**。持有有效链接的人可读取共享会话，并以会话权限发起任务。
- 只暴露明确选择的工作区。默认关闭远程，默认禁止远程修改权限。
- 凭证只在内存保存。停止、刷新、插件重载、进程重启或连接失败会丢弃活动桥接，旧链接失效；已接受的 DSH 任务可能继续执行。
- 插件没有定时过期策略；官方中继服务器端有效期未公开，不能承诺永久有效。手机网络出错后可手动刷新二维码。
- 待发附件限定于配对、工作区和会话，合计最多 24 MiB，10 分钟过期。成功发送后释放上传缓存，DSH 保留持久化附件。停止/刷新清除待发附件。
- 附件读取验证 DSH 会话归属及持久引用，不接受任意本地文件路径。
- Issue 仅提供脱敏错误信息，不提交真实会话、配置、密钥、配对链接或二维码。

## 开发和验证

```sh
npm ci --ignore-scripts
npm test
```

66 项单元测试覆盖协议校验、作用域隔离、去重、停止撤权、刷新恢复、附件、权限、审批交回、队列、历史、目标及压缩投影。0.4.1 修复逐轮状态、标题同步、重命名菜单接口、主题广播、权限元数据及设置页错误恢复，并加入可恢复的空草稿归档。GitHub Actions 运行单元测试和打包检查，不访问真实会话或官方中继。

集成测试需要另行安装 Playwright 和 Chrome；真实 Host 测试还需要构建好的 DSH 源码。通过 `PLAYWRIGHT_MODULE_PATH` 指定 Playwright 模块，通过 `DSH_SOURCE` 指定 DSH 源码根目录（包含 `apps`、`packages`）。从本仓库根目录运行：

```powershell
$env:PLAYWRIGHT_MODULE_PATH = 'Playwright模块的绝对路径'
$env:DSH_SOURCE = '构建好的DSH源码根目录'
$env:DSH_EXPECT_VERSION = '0.2.1-alpha.2' # 可选：限定本次测试目标版本
node test/live-web.mjs --live
node test/real-host.mjs --live --flows
node test/real-host.mjs --live --flows --audit
node test/real-host.mjs --live --features
node test/real-host.mjs --live --extended
node test/real-host.mjs --live --history
```

`--live` 连接官方网页和中继，仅发送隔离测试数据。Chrome 使用真实按钮、菜单、输入、滚动并核对 Host 数据；模型输出来自确定性回放，**不是付费模型 API 验证，也不是 iPhone/Safari 实机验证**。各测试选项分别运行。详见[验证记录](test/verification.md)。临时 profile 和截图不进入仓库。

### 重建上游协议包

安装和单元测试使用已提交的 `lib/zcode-wire.js`，无需克隆 ZCode。仅在重建时：

```powershell
git clone https://github.com/zai-org/ZCode.git .references/ZCode
git -C .references/ZCode checkout aac4755666d09fdcd70272fcf063c077a639015f
$env:ZCODE_SOURCE = (Resolve-Path .references/ZCode).Path
npm run build:vendor
npm test
```

构建脚本检查固定 commit，`licenses/upstream.json` 记录上游及输入。插件使用上游传输、RPC、协议校验代码，不打包 ZCode 智能体。

## 许可证与声明

本项目采用 [Apache License 2.0](LICENSE)。上游 ZCode、Zod 及其他依赖保留各自许可证和版权声明，参见 [NOTICE](NOTICE) 和 [licenses](licenses)。不提供官方背书，不保证公共中继稳定性；使用者需自行确认符合所使用服务的条款。
