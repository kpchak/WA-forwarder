#!/usr/bin/env bash
# ============================================================
#  Hostinger VPS – one-time setup for WA-forwarder
#  Run as root:  bash setup-hostinger.sh
# ============================================================
set -euo pipefail

APP_DIR="/home/wa-forwarder"
APP_USER="wauser"
DOMAIN="${1:-}"  # pass your domain as first arg, or edit nginx later

echo "──────────────────────────────────────────────────"
echo " WA-forwarder Hostinger VPS Setup"
echo "──────────────────────────────────────────────────"

# ── 1. System packages ──────────────────────────────────
echo "[1/8] Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
  curl git nginx certbot python3-certbot-nginx \
  fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 \
  libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 \
  libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
  libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
  libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
  libxrandr2 libxrender1 libxss1 libxtst6 lsb-release \
  xdg-utils ca-certificates gnupg wget

# ── 2. Google Chrome (stable) ──────────────────────────
echo "[2/8] Installing Google Chrome..."
if ! command -v google-chrome-stable &>/dev/null; then
  wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | \
    gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
    http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq && apt-get install -y -qq google-chrome-stable
fi
echo "  Chrome: $(google-chrome-stable --version)"

# ── 3. Node.js 20 LTS ──────────────────────────────────
echo "[3/8] Installing Node.js 20 LTS..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node: $(node -v)  npm: $(npm -v)"

# ── 4. PM2 (process manager) ───────────────────────────
echo "[4/8] Installing PM2..."
npm install -g pm2

# ── 5. App user & directory ─────────────────────────────
echo "[5/8] Setting up app user and directory..."
id -u "$APP_USER" &>/dev/null || useradd -m -s /bin/bash "$APP_USER"
mkdir -p "$APP_DIR" "$APP_DIR/logs"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo ""
echo "  App directory created at: $APP_DIR"
echo "  Copy your project files there (see instructions below)."
echo ""

# ── 6. Swap (2 GB – helps on low-RAM VPS) ──────────────
echo "[6/8] Configuring swap..."
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  2 GB swap created"
else
  echo "  Swap already exists"
fi

# ── 7. Nginx config ────────────────────────────────────
echo "[7/8] Configuring Nginx..."
if [ -f "$APP_DIR/nginx.conf" ]; then
  cp "$APP_DIR/nginx.conf" /etc/nginx/sites-available/wa-forwarder
  if [ -n "$DOMAIN" ]; then
    sed -i "s/YOUR_DOMAIN_OR_IP/$DOMAIN/g" /etc/nginx/sites-available/wa-forwarder
    sed -i "s/YOUR_DOMAIN/$DOMAIN/g" /etc/nginx/sites-available/wa-forwarder
  fi
  ln -sf /etc/nginx/sites-available/wa-forwarder /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  echo "  Nginx configured"
else
  echo "  nginx.conf not found in $APP_DIR – configure manually later"
fi

# ── 8. Firewall ────────────────────────────────────────
echo "[8/8] Configuring firewall..."
if command -v ufw &>/dev/null; then
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  echo "  UFW enabled (22, 80, 443)"
fi

echo ""
echo "══════════════════════════════════════════════════"
echo " Setup complete! Follow these steps to deploy:"
echo "══════════════════════════════════════════════════"
echo ""
echo " 1. Upload your project to the VPS:"
echo "    scp -r ./* root@YOUR_VPS_IP:$APP_DIR/"
echo "    (or use git clone on the VPS)"
echo ""
echo " 2. SSH into VPS and install deps:"
echo "    cd $APP_DIR"
echo "    cp .env.example .env"
echo "    nano .env          # fill in your values"
echo "    npm ci --production"
echo ""
echo " 3. Start with PM2:"
echo "    sudo -u $APP_USER pm2 start ecosystem.config.js"
echo "    sudo -u $APP_USER pm2 save"
echo "    pm2 startup systemd -u $APP_USER --hp /home/$APP_USER"
echo ""
echo " 4. (Optional) SSL with Let's Encrypt:"
echo "    certbot --nginx -d YOUR_DOMAIN"
echo ""
echo " 5. Monitor:"
echo "    sudo -u $APP_USER pm2 logs wa-forwarder"
echo "    sudo -u $APP_USER pm2 monit"
echo ""
