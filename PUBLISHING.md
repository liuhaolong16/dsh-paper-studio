# 发布到 npm（两条通路）

包名 `dsh-paper-studio` · 注册表 `https://registry.npmjs.org/` · 打包自足（84 文件 / 643 kB tarball）。

## 通路 A（推荐·无需任何长期凭据）：Trusted Publishing (OIDC)
1. 在 npmjs.com 打开该包 → **Settings → Trusted Publisher → GitHub Actions**，填：
   - Owner: `liuhaolong16` · Repository: `dsh-paper-studio` · Workflow filename: `publish-npm.yml`
2. 到 GitHub 仓库 → Actions → **publish-npm** → Run workflow（`dry_run=true` 先跑一次，确认自检全绿）
3. 再跑一次 `dry_run=false` ⇒ 以 `--provenance` 发布，凭据由 OIDC 短时签发，**仓库里不存 token**。

> 若该包**尚未在 npm 上存在**：先在浏览器里用「Create package」或以一次带 token 的首次发布创建它；
> 之后即可切到本通路。（首次发布若只能走 token，见通路 B 的安全做法。）

## 通路 B：Granular Access Token（首次发布常用）
**关键：token 值不要贴进对话或任何文件里给模型看。** 由你本人在本机执行：
```powershell
# 1) 在浏览器里创建 token：npmjs.com → Access Tokens → Generate New Token
#    选 Granular：Packages = 仅 dsh-paper-studio；权限 = Read and write；有效期尽量短
# 2) 本机写入用户级 .npmrc（模型不需要看到这个值）
npm config set //registry.npmjs.org/:_authToken <你的token>
# 3) 确认登录态（应打印你的用户名）
npm whoami
```
然后：
```powershell
cd E:\DeepSeek\skills\paper-studio
npm pack --dry-run          # 先看会发什么
npm publish --access public
```
**用完即清**：`npm config delete //registry.npmjs.org/:_authToken`

## 回滚
- npm 的发布**不可删除，只能 unpublish**（且受 72 小时/24 小时窗口与下游引用限制）：
  `npm unpublish dsh-paper-studio@3.2.58`
- 因此**先发 `--dry-run`，再发正式版**；发布前确认 `package.json` 版本与 git 标签一致。
- 仓库侧回滚：`git revert <commit>` + 重发一个新补丁版本（不要试图改已发布的版本号）。

## 发布前必须全绿（本机实测）
`node bin/studio.cjs selftest`（168/168）· `node bin/gate-runner.cjs --selftest`（53/53）·
`node plugin/selftest.mjs`（38/38）· `node gates/_journal-contract.cjs --selftest`（69/69）
