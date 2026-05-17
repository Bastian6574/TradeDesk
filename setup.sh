#!/bin/bash
# ══════════════════════════════════════════════════════
#  TradeDesk - Raspberry Pi Setup Script
#  Run once:  bash setup.sh
# ══════════════════════════════════════════════════════

set -e
echo "══════════════════════════════════════════"
echo "  TradeDesk Setup"
echo "══════════════════════════════════════════"

# 1. Update & install python3/pip
echo "[1/4] Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y python3 python3-pip python3-venv -qq

# 2. Create venv
echo "[2/4] Creating virtual environment..."
python3 -m venv venv
source venv/bin/activate

# 3. Install Python dependencies
echo "[3/4] Installing Python packages (may take a few minutes)..."
pip install --quiet --upgrade pip
pip install --quiet flask flask-cors yfinance pandas

# 4. Create systemd service for auto-start
echo "[4/4] Installing systemd service..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

sudo tee /etc/systemd/system/tradedesk.service > /dev/null <<EOF
[Unit]
Description=TradeDesk Trading Dashboard
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/venv/bin/python3 $SCRIPT_DIR/server.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable tradedesk
sudo systemctl start tradedesk

echo ""
echo "══════════════════════════════════════════"
echo "  ✓ Setup complete!"
echo ""
echo "  Dashboard: http://$(hostname -I | awk '{print $1}'):5000"
echo ""
echo "  Commands:"
echo "    sudo systemctl start tradedesk"
echo "    sudo systemctl stop tradedesk"
echo "    sudo systemctl status tradedesk"
echo "    journalctl -u tradedesk -f   (logs)"
echo "══════════════════════════════════════════"