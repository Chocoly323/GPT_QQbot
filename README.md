# QQ接入GPT

- 自动聊天：会回复桥接器上报的所有他人私信（包括临时会话），忽略群聊、你发给其他人的消息；填写 `QQ_ACCOUNT` 后支持你给自己发消息。支持图片与常用文档附件；语音、视频和合并转发暂不支持。

## 准备

- Node.js 22+， `Codex` 安装好并已完成登录/服务配置。
- 单独运行支持 OneBot v11 HTTP API + HTTP 事件上报的 QQ 桥接器，登录**你自己的 QQ 号**。

## 启动

```bash
cd /home/yili/Codex-Remote-Contact
cp .env.example .env
# 编辑 .env，填写 QQ_ACCOUNT 和桥接器地址/令牌。
npm start
```

默认通过 PATH 查找 Codex；也可将 `CODEX_CLI_PATH` 设置成 `command -v codex` 的输出。默认沿用本机 Codex 的模型与服务配置；需要覆盖模型时填写 `CODEX_MODEL`。`CODEX_REASONING_EFFORT` 可指定思考强度；`CODEX_SERVICE_TIER=priority` 启用快速模式。修改 `.env` 后重启。

桥接器配置：

| 项目 | 值 |
| --- | --- |
| HTTP API 监听 | `127.0.0.1:3000`，与 `ONEBOT_API_BASE` 一致 |
| HTTP 事件上报 | `http://127.0.0.1:3789/api/onebot/event` |
| 消息格式 | OneBot 消息段数组（推荐）；也支持 CQ 字符串中的文字 |
| 自己发出的消息上报 | 开启以支持自聊；服务端只放行绑定账号发给自己的消息 |

`ONEBOT_ACCESS_TOKEN` 是访问桥接器 API 的 Bearer token；`EVENT_TOKEN` 是回调密钥，支持 NapCat HTTP 上报的 `X-Signature: sha1=<HMAC-SHA1>`（按原始请求体计算），也兼容 `Authorization: Bearer ...`。

默认只监听本机。桥接器在 Docker 中时，需保证它能访问宿主机服务；容器内的 `127.0.0.1` 是容器自身。如要修改 HOST，请同时配置回调鉴权及网络访问限制。

## 使用与检查

```bash
curl http://127.0.0.1:3789/health
npm test
```

`/health` 表示进程存活、返回待处理数量，不代表 QQ 登录或 Codex 调用成功。

每个联系人有独立记录，保存在 `data/conversations/<你的QQ>-<对方QQ>.json`，默认保留最近 20 轮，重启保留。对方发送 `/清除记忆` 清除自己的会话。

事件先确认收到，再串行处理，最多排队 30 条；内存队列和 10 分钟去重记录不跨进程重启保存。Ctrl+C 会等待已接收的队列处理结束。

Codex 生成失败会记录错误并尝试发送一条固定提示；QQ 发送失败则暂停所有自动回复。

本项目会把私信及该联系人的近期记录发送给你配置的 Codex 服务。基础文字模式使用 read-only 沙箱。原生文件模式由独立 Landlock 沙箱限制整个 Codex 进程及其子进程，只开放当前任务目录和必要运行库；登录凭据留在沙箱外的本地模型代理。

## 文件

- `src/server.js`：HTTP 回调、过滤、排队、Codex 调用、OneBot 发信、会话记录。
- `.env.example`：部署配置示例。
- `test/private-chat.test.js`：模拟 Codex/OneBot 的回归测试。


```bash
# 查看状态
systemctl --user status codex-qq-private.service napcat-qq.service
# 停止全部接入
systemctl --user stop codex-qq-private.service napcat-qq.service
# 手动启动
systemctl --user start codex-qq-private.service napcat-qq.service
# 查看日志（NapCat 日志可能包含登录密钥，勿公开）
journalctl --user -u codex-qq-private.service -f
```

首次登录需要手机 QQ 扫码确认。遇到验证码或账号异常，请停止接入并通过官方 QQ 处理，不反复尝试登录或绕过验证。非官方接入无法保证账号不受限。


## 发送频率与故障暂停

以下是本项目的保守流量设置，不是腾讯公布的安全阈值，也不能保证账号不受限：

- `SEND_INTERVAL_MS=3000`：所有真实 QQ 发信请求之间至少间隔 3 秒，包括长回复各分段和错误提示。
- `CONTACT_WINDOW_MS=600000`、`CONTACT_MAX_REPLIES=10`：同一联系人每 10 分钟最多接收 10 个回复任务（包括清除记忆和生成失败）。超过限额的消息直接忽略。不同联系人分别计数；限额计数存于内存，重启重置。
- 任意 QQ 发信失败（含网络超时、接口拒绝、部分分段失败）会暂停所有自动回复，后续队列和新消息不再生成或发送；已发送部分不会重发。
- 暂停状态写入 `data/sending-paused.json`。`/health` 中的 `sendingPaused` 显示状态；`ok` 表示 HTTP 服务存活。
- 排查 QQ 官方客户端、桥接器及网络后，确认可以恢复时，先停止私聊服务，删除上述暂停文件，再启动私聊服务。此操作无需重启 QQ；暂停期间的消息不会补发。


## 自己给自己发消息

程序依据 QQ 号码判断身份，不依据可修改的昵称。

NapCat 的 HTTP 客户端已开启 `reportSelfMessage`。服务仅接受 `user_id = self_id = target_id = QQ_ACCOUNT` 的自聊事件，你发给别人的消息仍被忽略。自聊的 AI 回复每个分段都加 `[Codex] ` 前缀，带该前缀的自聊消息不再触发模型，避免即时或延迟回显、重启后的循环。你自己的提问不要以 `[Codex]` 开头。

自聊记录保存在 `data/conversations/

## 调整回复风格

编辑项目根目录的 `style.md`，写明语气、长短、格式、emoji 等偏好。服务在每次开始生成回复时重新读取文件，保存后的下一次生成生效，不需要重启；所有联系人和自聊共用此风格。

文件留空或删除时使用基础提示词；其他读取错误会按生成失败处理并记录日志。需要完全重新开始时，可在对应私聊发送 `/清除记忆`。

## 回复耗时

QQ 服务通过 Codex 的 JSON 事件读取最终回答；收到 `turn.completed` 后即可发信，。子进程继续排空输出，退出后清理临时目录；清理异常拖延时会终止子进程。未完成或失败的回合不会将中间文本发给联系人。

基础文字模式单独关闭 Codex 的 memories、plugins、apps、shell_tool；原生文件模式保留 shell 工具，允许模型按需生成并检查文件，并限制技能目录提示的 token 预算，以减少与文字聊天无关的上下文；账号登录、服务配置、指定模型、思考强度和快速模式继续沿用。

服务日志中的 `reply_timing` 提供 `queueMs`（排队及准备）、`generationMs`（生成）、`sendMs`（发送及限频等待）、`totalMs`，不记录消息正文。失败或跳过的任务可能只包含部分耗时字段。任务串行，其他人的长任务可能造成等待。

```bash
journalctl --user -u codex-qq-private.service -f
```

## 多气泡回复

`style.md` 可以要求按内容分成多个气泡。系统提示会要求模型在气泡之间用独占一行的 `[[QQ_BUBBLE]]` 分隔，发送程序移除分隔符并依次发送。


## QQ 内置表情

现在可以发送真正的 OneBot `face` 消息段，与文字混排或单独成为气泡。支持：微笑、害羞、大哭、流泪、呲牙、惊讶、偷笑、可爱、奋斗、疑问、鼓掌、笑哭、捂脸、爱心、赞、OK、抱拳、握手。名称和 ID 来自 NapCat v4.18.41 的 sysface 表。


## 图片与文档附件

直接在 QQ 私聊（含给自己发消息）发送 JPG/JPEG、PNG、WebP 图片，或 DOCX、PDF、TXT、MD、XLSX、CSV 文件。发送附件时静默保存，**不会调用模型分析**；接收失败会提示；不再需要时发送 `/清除附件`。`/清除记忆` 只清聊天记录，不清附件。

- 单文件 20 MiB（界面称 20 MB）；每个联系人最多保留 10 个附件，整个服务最多 100 个，每条消息最多接收 10 个。
- 文件存放于 `data/attachments/<登录QQ>-<联系人QQ>/<随机ID>/`，包含 `source` 原文件、`meta.json` 元信息，以及图片解析后生成的 `image.png`。文件夹权限 700，原文件与元信息 600，部署服务使用 UMask=0077。
- 保留 24 小时；每分钟排队清理一次，正在分析时会等本次任务结束。清理范围是本项目附件副本，**不包含 QQ 自身缓存、对话历史及已发送给模型的数据**。分析后的聊天记录仍按现有历史规则保存。
- 接收通过本机 NapCat 的 `get_image` / `get_file` 获取缓存文件，只允许 QQ 数据目录和桥接器安装目录中的普通文件。不会根据用户给出的 URL 下载，也不会执行文件中的代码、宏或链接。已知超大文件在调用桥接器前拒绝；若事件未提供大小，桥接器可能先缓存原文件，项目读取时仍检查 20 MiB 限制。
- 图片使用 Pillow 解码并缩小至最长边 2048 像素后传入 Codex `--image`，拒绝超过 2500 万像素的图片。DOCX 提取正文和表格文字；XLSX 提取各表的单元格位置、缓存值及公式。TXT/MD/CSV 支持 UTF-8 与 GB18030。
- PDF 提取前 200 页文字。每份文档及每次分析的附件文字最多 60000 字符。


## 原生文件输出

**QQ → NapCat → 原生 Codex CLI → GPT 自主调用工具生成、检查文件 → NapCat 发回 QQ**。

在 QQ 中直接说“把刚才的分析整理成 Word 发给我”“生成预算 Excel”“导出 PDF”。普通消息直接文字回答；附件仍静默保存，等提问后使用。成品支持 TXT、MD、DOCX、PDF、XLSX、CSV，以及常见代码文本文件；每次最多 3 个、每个不超过 20 MiB。

每次会话的目录布局：

```text
data/outputs/<登录QQ>-<联系人QQ>/<任务ID>/
├── inputs/     当前联系人原附件的副本
├── scripts/    GPT 自己编写的生成脚本
├── output/     最终成品；仅此目录根部文件会发给 QQ
└── tmp/        预览、中间文件、无登录凭据的临时 Codex HOME
```

旁边的 `<任务ID>.json` 由服务维护发送记录，模型无法修改。下一轮会复制该联系人最近一次生成的成品到 inputs/，支持继续修改；不会带入其他联系人的成品。任务结束后先检查成品路径、类型、大小和链接，再上传文件，最后发送模型的文字回复；文件与文字共享发送间隔。上传失败或返回结果不明确时暂停发送，不自动重传。自聊文件名加 `Codex-<任务ID前8位>-` 前缀，结合持久记录识别回传，避免重复接收。原附件仍按原规则隔离和过期。任务目录（包括脚本）默认保留 24 小时，清理任务在同一队列中运行，不删除正在生成的文件；需要长期复用的脚本请另存。

运行条件与配置：

- Linux Landlock ABI ≥ 6、libseccomp、Python 3、当前安装的 Codex CLI。无需 root、Docker 或 Bubblewrap 用户命名空间。
- `NATIVE_FILES=1` 开启；`NATIVE_TIMEOUT_MS=300000` 设置单轮最大 5 分钟。关闭后恢复基础文字模式。
- `.venv-files/` 是文档运行环境，模型自行调用其中的 Python。依赖锁定于 `requirements-output.txt`：python-docx、openpyxl、reportlab、Pillow 等。系统提供 pdftotext、pdftoppm 和 `/usr/share/fonts/truetype/arphic/uming.ttc` 中文字体。
- 重建环境：`/usr/bin/python3 -m venv --without-pip .venv-files`，再用可用 pip 执行 `python3 -m pip --python .venv-files/bin/python install -r requirements-output.txt`；Node 依赖执行 `npm ci`。
- `CODEX_PROXY_URL` 指定沙箱外模型代理使用的上游 HTTP 代理；当前本机默认 `http://127.0.0.1:17897`。模型与思考强度仍使用 `.env` 中的配置。

`src/native-runtime.js` 在沙箱外读取本机 Codex 登录凭据，仅转发模型 Responses 请求；每轮随机端口和访问令牌，结束即关闭。沙箱内不保存账号 access/refresh token，工具环境不继承 QQ 接口密钥。每次请求重新读取登录凭据；若凭据失效，需通过正常 Codex 登录恢复，不在本项目中复制刷新登录逻辑。

`scripts/native_sandbox.py` 使用内核 Landlock 限制文件读写及 TCP 端口，使用 seccomp 阻止宿主 Unix 控制套接字、非 TCP 网络、进程内存读取等。Codex 使用外部沙箱模式运行原生工具；CLI 参数中的 `--dangerously-bypass-approvals-and-sandbox` 仅跳过不能在此机运行的内置 Bubblewrap，**外围内核沙箱始终先启用且失败时不启动 Codex**。不读取 QQ 配置、真实 Codex HOME 或其他任务目录。上游登录与模型请求由沙箱外代理负责，代理不会向模型返回凭据。

`src/outputs.js` 只负责输入副本、成品收集、自聊回传识别与清理；`src/server.js` 负责消息队列和 NapCat `upload_private_file`。没有固定 Word/Excel/PDF 生成脚本。

## 每日工作时段

每天 **北京时间 01:00 停止 NapCat/QQ，07:00 启动**。启动条件会阻止在 01:00–07:00 通过此 QQ 服务手动启动。机器错过定时时刻时，用户级 systemd 恢复后会按当前北京时间重新决定启停。

`.env` 中 `QQ_NIGHT_OFFLINE=1` 同时抑制夜间消息处理及文字/文件发送。

定时器配置模板在 `config/systemd/`，执行脚本为 `scripts/qq-schedule.mjs`，统一时段判断在 `src/quiet-hours.js`。本机安装在 `~/.config/systemd/user/`，NapCat 的启动条件安装在 `napcat-qq.service.d/night-hours.conf`。模板中的路径需在其他机器部署时调整。

查看状态：`systemctl --user list-timers qq-online-schedule.timer`。取消计划需同时停用定时器、删除该启动条件 drop-in，并将 `.env` 的 `QQ_NIGHT_OFFLINE` 改为 `0`，再重新加载 systemd 和重启私聊服务。
