# Joey 的生日信箱

朋友们打开网页，写一段祝福，可选再传一段视频。不需要登录，知道网址就能用。

- `public/index.html` 上传页（给朋友们）
- `server/` Node 服务：接收文字和视频，后台存入 Cloudflare R2
- `deploy/setup.sh` 服务器一键安装 / 更新

## 数据存在哪里

| 内容 | 位置 |
|---|---|
| 视频原片 | R2 存储桶里的 `originals/<编号>.<扩展名>` |
| 文字祝福 | R2 存储桶里的 `wishes/<编号>.json`（含署名、时间、对应视频的文件名） |
| 服务器本地 | `data/wishes/` 保留一份文字；视频确认已完整存入 R2 后才从本地删除 |

视频先完整写到服务器硬盘，再复制到 R2，并核对 R2 上的文件大小，核对通过才删除本地那份。
服务器重启后会自动继续没存完的文件。登录 Cloudflare 后台 → R2 → 存储桶，可以看到并下载每个文件。

## 部署（Ubuntu 24.04，root 用户）

开始前需要：一台服务器、一个域名、一个开通了 R2 的 Cloudflare 账号。

1. **域名指向服务器**：在域名的 DNS 设置里加一条 `A` 记录，指向服务器 IP。
   如果域名在 Cloudflare，代理状态要选 **DNS only（灰色云）**，不要开橙色云。
2. **放行端口**：在云服务商控制台的防火墙里放行 TCP `80` 和 `443`。
3. **登录服务器**，依次运行：

   ```bash
   apt-get update && apt-get install -y git
   git clone https://github.com/szy0231/Joey-2026-Birthday.git /opt/joey
   cd /opt/joey
   bash deploy/setup.sh 你的域名
   ```

   仓库是私有的话，`git clone` 会要 GitHub 用户名和访问令牌；最省事的做法是部署时先把仓库设为公开（里面没有任何密钥）。

4. **填 R2 密钥**：

   ```bash
   nano /opt/joey/.env
   ```

   填好 `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`，按 `Ctrl+O` 回车保存，`Ctrl+X` 退出，然后：

   ```bash
   systemctl restart joey
   ```

5. **检查**：脚本最后会打印上传页和管理页的网址。自己寄一份带视频的祝福，然后打开管理页，
   等“视频”一栏变成“已存入 R2”，再去 Cloudflare 后台确认文件在桶里。

## 日常

| 想做的事 | 命令 |
|---|---|
| 更新到最新代码 | `cd /opt/joey && git pull && bash deploy/setup.sh 你的域名` |
| 看运行日志 | `journalctl -u joey -n 100` |
| 重启 | `systemctl restart joey` |
| 看谁寄了 | 打开 `https://你的域名/admin?key=…`（key 在 `.env` 的 `ADMIN_KEY`） |

## 本地开发

```bash
npm install
npm start        # http://127.0.0.1:3000 ，没配 R2 时文件只存在 data/
npm test
```

改了页面文案后，重新生成中文字体子集：见 `scripts/subset-fonts.py` 开头的说明。
