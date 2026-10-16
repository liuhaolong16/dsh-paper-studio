# dsh-paper-keys —— 论文插件外置 key 连接器（面板）

在 DSH **设置面板**里加一节「论文插件外置 key 连接器」，用来管理 paper-studio 的模型凭据。

## 为什么单独一个包

paper-studio 的硬承诺是**零面板**（`SKILL.md`：不注册任何客户端 Slot / 路由 / 前端资产 ⇒ 不会出现面板消失/白屏）。
面板另立一包 ⇒ **卸载面板不影响论文能力本体**；面板插件本身出问题也不会连累 paper-studio。

## 面板上能做什么

| 操作 | 说明 |
|---|---|
| **录入 token** | 粘贴后保存到**本机**（默认 `~/.dsh/paper-studio/keys.json`，可用 `DSH_PAPER_KEYS_FILE` 改；**不在仓库内**） |
| **连接** | **真连通性测试**：向该 provider 发一次最小请求（`/chat/completions`）；失败如实报错，不吞成成功 |
| **查看** | 只显示**掩码**（`sk-***ab（长度 N）`）与来源、状态、上次测试；**服务端从不回显明文** |
| **停用** | **保留凭据但关闭**；★**停用优先于环境变量** —— 点停用就是停用，env 里的同名 key 不会被偷偷拿来用 |
| **删除** | 连凭据一起删（不可恢复） |

## 与 CLI 的关系（同判）

面板与 CLI 写的是**同一份**存储、走**同一份** `bin/keys-store.cjs`（唯一真源），因此：

```bash
node bin/studio.cjs model providers      # 「面板」列显示 已连接 / 已停用（保留）/ 未录入 + 掩码
node bin/studio.cjs model keys list      # 面板凭据的 CLI 通道（无面板也能用）
```

面板里启用的 provider，就是 `model …` 能用的 provider —— 这一条有**跨实现锁**（`_check-client.cjs` 的
「同判」夹具：面板写入 ⇒ CLI 必须报「面板」来源；面板停用 ⇒ CLI 必须报「已停用」且不算已配置）。

## 安全设计

- **纯具名导出**（无 default）；`apply` 全程护栏，**任何畸形 ctx 都不抛**（不白屏）
- 路由只服务**同源**请求（跨源一律 403）；写操作只接受 **POST + JSON**；provider 必须在真源里
- 只注册 `settings.section` 这一**列表槽**中的自己一格（`replaceRisk: none`），不覆盖任何既有节
- 未接线（找不到 paper-studio 的 store）时**如实报"未接线"且不改动任何文件**

## 隔离验证

```bash
node panel/_check-client.cjs     # 20 条：加载面 / 敌意 ctx / 正控注册 / 必失败面 / 明文不泄露 / 跨源 403 / 同判
```

## 安装

```bash
# 从本仓链接安装（开发态）
plugin_manager install_bundle target="link:<本仓路径>/panel"
```
