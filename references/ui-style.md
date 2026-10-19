# UI 风格约束（style-card）

> 真源：`assets/ui-style/style-card.paper-editorial.json`（卡）+ `bin/style-card.cjs`（取卡/机检）。

## 为什么需要

AI 生成的界面丑且风格漂移，根因不是缺审美，是缺约束——给不出 token 时，模型只会回落到训练集里频率最高的那套默认值（灰底、圆角、渐变、彩色单边强调）。约束不是"再好看一点"，而是三样可检查的东西：**风格卡（token）+ 禁止项 + 提示词**。

## 默认卡：paper-editorial

面向论文工具的阅读场景：

- 暖米白 `#F9F8F6` + 软黑 `#1C1C1C`，长文不刺眼；
- 衬线标题 + 无衬线正文，层级靠字体与留白，不靠颜色；
- 直角、无阴影、1px 细边框；
- 颜色只留给状态（success / warning / danger / info），不做装饰；
- 23 条禁止类名 + 6 条禁止正则（圆角/阴影/粗边框/渐变/彩色单边强调/卡外色）。

## 用法

```powershell
node bin/style-card.cjs --list                 # 可用卡
node bin/style-card.cjs --card                 # 打印卡 JSON（直接喂模型）
node bin/style-card.cjs --prompt               # 填空式提示词模板
node bin/style-card.cjs --check <文件或目录>    # 扫卡外色/禁类名/禁模式
node bin/style-card.cjs --selftest
```

一个产品同时只允许一张卡生效；换页面不换卡，换卡要整站换。需要数据看板时另配同族 `paper-dashboard` 卡（同色板、同字号阶梯，只加指标卡与表格壳），不要混用两套色。

## 验收

机检：`style-card --check` 0 违规（卡外颜色、`rounded-*`、`shadow-*`、`border-2+`、渐变、彩色单边）。
人检：5 秒内能找到入口 → 摘要 → 异常 → 明细 → 导出；同类信息对齐；间距落在 4/8/12/16/24/32/48/64 阶梯。
