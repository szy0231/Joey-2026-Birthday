#!/usr/bin/env bash
# 一键安装 / 更新。在服务器上以 root 运行：
#   bash deploy/setup.sh 你的域名
# 可以重复运行：第二次起只做更新和重启，不会动 .env 和已收到的数据。
set -euo pipefail

DOMAIN="${1:?用法: bash deploy/setup.sh 你的域名（例如 dearjoey.com）}"
APP="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "请用 root 运行（前面加 sudo）"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
# 目录属于 joey 用户而 git 由 root 运行，不加这一句 git 会拒绝操作
git config --global --get-all safe.directory | grep -qxF "$APP" || git config --global --add safe.directory "$APP"

echo "==> 安装系统软件"
apt-get update -y
apt-get install -y curl ca-certificates git ffmpeg caddy
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> 准备 2G 交换空间（小内存机器处理视频时需要）"
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile; }
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> 安装依赖"
id joey >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin joey
cd "$APP"
npm ci --omit=dev
mkdir -p data
if [ ! -f .env ]; then
  sed "s/^ADMIN_KEY=.*/ADMIN_KEY=$(openssl rand -hex 12)/" .env.example > .env
  NEW_ENV=1
fi
# Joey 的页面用一个猜不到的网址；老的 .env 里没有就补上
grep -q '^VIEW_KEY=.\+' .env || echo "VIEW_KEY=$(openssl rand -hex 8)" >> .env
chmod 600 .env
chown -R joey:joey "$APP"

echo "==> 配置开机自启"
cat > /etc/systemd/system/joey.service <<UNIT
[Unit]
Description=Joey birthday mailbox
After=network-online.target
Wants=network-online.target

[Service]
User=joey
WorkingDirectory=$APP
ExecStart=$(command -v node) server/index.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable joey >/dev/null
systemctl restart joey

echo "==> 网络调优（BBR 拥塞控制：跨境、有丢包的线路上下载明显更快）"
if modprobe tcp_bbr 2>/dev/null; then
  printf 'net.core.default_qdisc=fq\nnet.ipv4.tcp_congestion_control=bbr\n' > /etc/sysctl.d/60-joey-bbr.conf
  sysctl -q --system || true
fi
echo "    当前拥塞控制：$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo 未知)"

echo "==> 配置 HTTPS（证书由 Caddy 自动申请和续期）"
VIEW_KEY="$(grep '^VIEW_KEY=' .env | cut -d= -f2-)"
chmod o+rx "$APP" "$APP/data"; mkdir -p "$APP/data/play"; chown joey:joey "$APP/data/play"; chmod o+rx "$APP/data/play"
# 视频和视频封面由 Caddy 直接从硬盘发出（支持分段请求），不经过 Node；文件不在硬盘上时才转给 Node。
# 只用 HTTP/1.1：Joey 的页面会开几条连接同时分块下载视频，HTTP/2 会把它们挤进一条连接，跨境线路上就快不起来；
# HTTP/3 走 UDP，跨境线路上常被限速。
cat > /etc/caddy/Caddyfile.new <<CADDY
{
	servers {
		protocols h1
	}
}
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 20MB
	}
	handle_path /media/$VIEW_KEY/* {
		root * $APP/data/play
		@ondisk file
		handle @ondisk {
			header Cache-Control "private, max-age=31536000, immutable"
			file_server
		}
		handle {
			rewrite * /media/$VIEW_KEY{uri}
			reverse_proxy 127.0.0.1:3000
		}
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
CADDY
if caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new >/dev/null 2>&1; then
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
else
  echo "    新的 Caddy 配置没通过检查，改用简单配置（视频经 Node 发出，功能不受影响）。请把下面的报错发给我："
  caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new 2>&1 | tail -5 || true
  rm -f /etc/caddy/Caddyfile.new
  cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 20MB
	}
	reverse_proxy 127.0.0.1:3000
}
CADDY
fi
systemctl enable caddy >/dev/null
systemctl restart caddy

# 以后更新只需要在服务器上输入：joey-update
cat > /usr/local/bin/joey-update <<UPDATE
#!/usr/bin/env bash
set -euo pipefail
cd "$APP"
git -c safe.directory="$APP" pull --ff-only
exec bash deploy/setup.sh "$DOMAIN"
UPDATE
chmod +x /usr/local/bin/joey-update

sleep 2
echo
if curl -fsS http://127.0.0.1:3000/healthz; then echo; echo "服务已启动。"; else echo "服务没有启动，运行 journalctl -u joey -n 50 查看原因"; exit 1; fi
KEY="$(grep '^ADMIN_KEY=' .env | cut -d= -f2-)"
echo
echo "上传页：  https://$DOMAIN"
echo "管理页：  https://$DOMAIN/admin?key=$KEY"
echo "Joey 的页面（只给 Joey）：  https://$DOMAIN/for-joey/$(grep '^VIEW_KEY=' .env | cut -d= -f2-)"
echo "以后更新：输入 joey-update"
if [ "${NEW_ENV:-}" = 1 ] || ! grep -q '^R2_ACCOUNT_ID=.\+' .env; then
  echo
  echo "还差一步：运行  nano $APP/.env  填入 R2 的三项密钥，保存后运行  systemctl restart joey"
  echo "没填之前，视频只保存在这台服务器上，不会进 R2。"
fi
