# Joey 的生日信箱

朋友们打开网页，写一段祝福，可选再传一段视频。不需要登录，知道网址就能用。

- `public/index.html` 上传页（给朋友们）
- `views/joey.html` Joey 看的页面，只在 `https://你的域名/for-joey/<VIEW_KEY>` 下能打开
- `server/` Node 服务：接收文字、照片和视频，后台存入 Cloudflare R2，并把视频转成浏览器都能播的 1080p
- `deploy/setup.sh` 服务器一键安装 / 更新

## 数据存在哪里

| 内容 | 位置 |
|---|---|
| 视频原片 | R2 存储桶里的 `originals/<编号>.<扩展名>` |
| 明信片封面照片 | R2 存储桶里的 `covers/<编号>.jpg`（上传前在手机上缩到最长边 2000 像素） |
| 视频播放版 | R2 存储桶里的 `play/<编号>-<版本>.mp4` 和封面帧 `.jpg`；服务器 `data/play/` 也留一份用于播放。分辨率和帧率与原片相同（最高 4K、60 帧）：原片本身是 H.264 就原样复制画面，不重新编码；HEVC、HDR 等才转成 H.264 |
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

## 让 Joey 从 Cloudflare 直接拿视频（必须做一次）

Joey 的页面会同时试“香港服务器”和“Cloudflare R2”两条线路，自动用快的那条。R2 这条线需要存储桶允许
`dearjoeyy.com` 读取：Cloudflare 后台 → R2 → `joey-birthday` → Settings → CORS Policy → Add CORS policy，粘贴下面这段并保存。

```json
[
  {
    "AllowedOrigins": ["https://dearjoeyy.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 86400
  }
]
```

存储桶仍然是私有的：Joey 的页面拿到的是有效期 3 天、每次打开页面都会重新生成的单个文件链接。
管理页的“测一下网速”会分别显示两条线路的速度；Cloudflare 那一项测速失败，多半就是这一步还没做。

## 日常

| 想做的事 | 命令 |
|---|---|
| 更新到最新代码 | `joey-update`（第一次用之前先运行一遍 `cd /opt/joey && git pull && bash deploy/setup.sh 你的域名`） |
| 看运行日志 | `journalctl -u joey -n 100` |
| 重启 | `systemctl restart joey` |
| Joey 的页面 | 管理页顶部有链接；网址里的 key 在 `.env` 的 `VIEW_KEY` |
| 看谁寄了 | 打开 `https://你的域名/admin?key=…`（key 在 `.env` 的 `ADMIN_KEY`） |
| 删除一条祝福 | 管理页每行右侧的“删除”，会连同服务器和 R2 里的文件一起删掉，无法恢复 |
| 测网速、看每个视频的码率 | 管理页的“测一下网速” |

## 本地开发

```bash
npm install
npm start        # http://127.0.0.1:3000 ，没配 R2 时文件只存在 data/
npm test
```

改了页面文案后，重新生成中文字体子集：见 `scripts/subset-fonts.py` 开头的说明。
