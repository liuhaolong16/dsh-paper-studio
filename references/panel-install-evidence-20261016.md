# 面板 key 连接器 · 装入宿主的可复核读数（2026-10-16 · v3.2.67）

> 用途：**任何人**可以照这份读数复跑一遍，判断"面板真的装上了、且没把宿主搞坏"。
> 原则：所有结论后面都写清**输入是什么、读数从哪来**；拿不到的就说拿不到。

## 一、装入前的可回滚快照

| 项 | 值 |
|---|---|
| 快照目录 | `E:\DeepSeek\backups\paper-keys-20261016-215105\` |
| 内容 | `cordis.yml`（47.81 KB）· `package.json`（profile）· `plugins-before.txt`（**安装前 444 个包**的基线）· `panel-hashes-before.txt`（6 个文件的 sha256 前 16 位） |
| 回滚方式 | ① `plugin_manager` 卸载 `dsh-paper-keys`；② 若配置被改坏，把快照里的 `cordis.yml` 拷回 `%USERPROFILE%\.dsh\profiles\desktop\`；③ `panel/` 本体在仓库里，不受安装影响 |

## 二、装入结果（插件管理器回执）

```
{"stage":"enable","target":"dsh-paper-keys","enabled":true,"changed":true,"application":"applied"}
```

## 三、四条机器证据（不依赖截图）

1. **没有误删任何包**：基线 **444** → 现 **445**，**消失 0 个**、只多 `dsh-paper-keys`。
   ★注意：pnpm 打印的 `Packages: -70` 是**解析期记账**，不是真的删了 70 个包 —— 只有拿安装前的**基线求差**才能判定。
2. **宿主 fiber 活跃**：`include:paper-keys · moduleName=dsh-paper-keys · enabled=true · fiberPhase=active`（宿主半体 `apply` 未抛）。
3. **★客户端槽位已注册**：`settings.section` 的活体占用者里出现
   `{ "id": "paper-keys", "order": 36, "active": true }`
   ⇒ 这条同时证明：**客户端 bundle 加载成功 + `apply` 未抛 + 注册成功**（槽位清单取自运行中的 Shell，不是我的自述）。
4. **宿主没改写我的源码**：装后指纹比对，只有**我自己刚编辑过的 2 个文件**变化（`lib/client.js`、`_check-client.cjs`），其余原样。

## 四、"不白屏"被写成断言（`node panel/_check-client.cjs` ⇒ **25/25**）

| 断言 | 为什么它管白屏 |
|---|---|
| 无效载荷（`null`/`{}`/字符串/`{ok:false,error}`）**绝不进 `ready`** | 原来 `{}` 会被渲染成"空的就绪列表" —— 那正是用户看到的白屏形态（**这条是被夹具逼出来的，已修**） |
| 未接线载荷必须带原因 | 装配错误不许静默显示空白 |
| 畸形行（`providers` 非数组 / 行是 `null` / 字段类型错）降级但不抛 | 服务端/宿主给什么都不能让渲染路径炸 |
| **停用行必须仍显示掩码** | "停用（保留）"的可视证据 —— 否则用户以为凭据被删了 |
| 组件在加载态必须**返回元素而不是抛错** | 白屏的直接防线 |
| 敌意 ctx（`{}`/`null`/依赖抛错/依赖半残）下 `apply` 不得抛 | 宿主传什么你控制不了 |

## 五、源文件完整性 + 兼容性终校

| 检查 | 读数 |
|---|---|
| 随包清单（`npm pack`） | `dsh-paper-studio-3.2.67.tgz` · **711.5 KB** · sha256 `4661AFA7D4EA05E3C191…` · 装后 **103 文件** |
| **★分发缺口（本轮自查发现并修）** | 原 `files` **不含 `panel`** ⇒ 别人装 npm 包拿不到面板插件；已补入 |
| 干净安装自检 | 装后 `studio selftest` ⇒ **202/202** · 装后 `panel/_check-client.cjs` ⇒ **25/25** |
| 门副本逐字节对拍 | 内置 `gates/_journal-contract.cjs` 与本机外部门 sha256 均为 `D8AD214750BE7AA0B8E27A2C…` ⇒ **逐字节一致** |
| 样式锁 | `references/csl-lock.json` 三个 CSL 样式 sha256 **3/3 一致**（注意 `dir` 是**相对仓库根** `assets/csl`） |
| 契约门 | 73/73（内置副本与外部门同分） |
| 审计 / 数字对拍 / MCP 探针 | **6/6 全绿** · **PASS** · **0 缺陷** |

## 六、边界：什么**没有**被验证

- **没有截图**：本机 GUI 要求**鉴权 URL**，工具侧浏览器无会话令牌（打开 `http://127.0.0.1:19387/` 只得到 "dsh web authentication required"），因此**无法由我目视确认**设置页外观。
  替代证据＝上面第三节第 3 条（槽位已被占用且 active）＋第四节（渲染不抛）。**建议你本人扫一眼设置页那一节**。
- **没有真发一次模型请求**：连通性测试（"连接"按钮）要真 key 才跑得通；本轮只用夹具断言了它的**调用路径与错误处理**，没做付费调用。
