#!/bin/bash

# =================================================================
# AOP System Unified Installation Script 
# Restoration: Original Python Logic + User-Preferred Summary
# =================================================================

set -e  # Exit on error

# UI Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' 

clear
echo -e "${BLUE}=== AOP System Installation ===${NC}"

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# --- Step 1: OS Detection ---
echo -e "\n${YELLOW}Step 1: Detecting Operating System...${NC}"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    OS="debian"
fi
echo -e "${GREEN}Detected OS: $OS${NC}"

# --- Step 2: Install Git & Report Tools ---
echo -e "\n${YELLOW}Step 2: Installing Git & Required Tools...${NC}"
if [ "$OS" == "debian" ] || [ "$OS" == "ubuntu" ]; then
    sudo apt-get update && sudo apt-get install -y git lsof mariadb-client curl
elif [[ "$OS" =~ (centos|rhel|rocky|fedora) ]]; then
    sudo dnf install -y git lsof mariadb curl || sudo yum install -y git lsof mariadb curl
fi

# --- Step 3: Repository Setup ---
echo -e "\n${YELLOW}Step 3: Setting Up Repository...${NC}"
PROJECT_ROOT="/opt/AOP"
REPO_URL="https://github.com/Ibrahimgamal99/AOP.git"

if [ -d "$PROJECT_ROOT/.git" ]; then
    cd "$PROJECT_ROOT" && git pull || true
else
    sudo rm -rf "$PROJECT_ROOT"
    sudo mkdir -p "$(dirname "$PROJECT_ROOT")"
    sudo git clone "$REPO_URL" "$PROJECT_ROOT"
    sudo chown -R "$USER:$USER" "$PROJECT_ROOT"
    cd "$PROJECT_ROOT"
fi

# --- Step 4: NVM & Node 24 ---
echo -e "\n${YELLOW}Step 4: Installing NVM & Node.js 24...${NC}"
export NVM_DIR="$HOME/.nvm"
if [ ! -d "$NVM_DIR" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install 24 && nvm use 24 && nvm alias default 24

# --- Step 5: ORIGINAL PYTHON LOGIC ---
echo -e "\n${YELLOW}Step 5: Installing Python ...${NC}"
PYTHON_NEEDS_UPGRADE=false
PYTHON_11_PLUS_PATH=""
PYTHON_11_PLUS_FOUND=false

for PYTHON_VER in "3.13" "3.12" "3.11"; do
    if command_exists python${PYTHON_VER}; then
        PYTHON_11_PLUS_FOUND=true
        PYTHON_11_PLUS_VERSION=$PYTHON_VER
        PYTHON_11_PLUS_PATH=$(which python${PYTHON_VER})
        break
    fi
done

if [ "$PYTHON_11_PLUS_FOUND" == "false" ]; then
    if command_exists python3; then
        PYTHON_VERSION_STR=$(python3 --version 2>&1)
        PYTHON_VERSION=$(echo "$PYTHON_VERSION_STR" | grep -oE '[0-9]+\.[0-9]+' | head -1)
        PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
        PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)
        if [ "$PYTHON_MAJOR" -lt 3 ] || ([ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -lt 11 ]); then
            PYTHON_NEEDS_UPGRADE=true
        fi
    else
        PYTHON_NEEDS_UPGRADE=true
    fi
fi

if [ "$PYTHON_NEEDS_UPGRADE" == "true" ]; then
    if [ "$OS" == "debian" ] || [ "$OS" == "ubuntu" ]; then
        sudo apt-get update && sudo apt-get install -y software-properties-common
        sudo add-apt-repository -y ppa:deadsnakes/ppa && sudo apt-get update
        for VER in "3.13" "3.12" "3.11"; do
            if sudo apt-get install -y python${VER} python${VER}-venv python${VER}-dev; then
                PYTHON_11_PLUS_PATH=$(which python${VER}); break
            fi
        done
    fi
fi

# Create symlinks for python and pip
FINAL_PYTHON_PATH=${PYTHON_11_PLUS_PATH:-$(which python3)}
sudo ln -sf "$FINAL_PYTHON_PATH" /usr/local/bin/python
sudo tee /usr/local/bin/pip > /dev/null << 'EOF'
#!/bin/bash
python -m pip "$@"
EOF
sudo chmod +x /usr/local/bin/pip

# --- Step 6: PBX & Database Config ---
echo -e "\n${YELLOW}Step 6: Detecting PBX Environment & Configuring Database...${NC}"
DB_HOST="localhost"; DB_PORT="3306"; DB_NAME="asterisk"; DB_USER="root"; DB_PASS=""
if [ -d /usr/share/issabel ]; then
    SYSTEM="Issabel"
    DB_PASS=$(grep "mysqlrootpwd" /etc/issabel.conf | cut -d'=' -f2 | xargs 2>/dev/null || echo "")
elif [ -f /etc/freepbx.conf ]; then
    SYSTEM="FreePBX"
    DB_USER="AOP"
    DB_PASS=$(openssl rand -base64 8 | tr -dc 'a-zA-Z0-9' | head -c 8)
    sudo mysql -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';"
    sudo mysql -e "GRANT ALL PRIVILEGES ON *.* TO '$DB_USER'@'localhost' WITH GRANT OPTION; FLUSH PRIVILEGES;"
else
    SYSTEM="Generic"
fi

# --- Step 7: AMI Config ---
echo -e "\n${YELLOW}Step 7: Configuring Asterisk AMI...${NC}"
AMI_HOST="localhost"; AMI_PORT="5038"; AMI_USER="AOP"
AMI_SECRET=$(openssl rand -hex 4)
if [ -f /etc/asterisk/manager.conf ] && ! grep -q "\[$AMI_USER\]" /etc/asterisk/manager.conf; then
    sudo tee -a /etc/asterisk/manager.conf <<EOF
[$AMI_USER]
secret = $AMI_SECRET
read = all
write = all
permit = 127.0.0.1/255.255.255.255
EOF
    sudo asterisk -rx "manager reload" || true
fi

# --- Step 8: App Config ---
echo -e "\n${YELLOW}Step 8: Configuring Application & Installing Dependencies...${NC}"
cd "$PROJECT_ROOT/backend"
python -m pip install --break-system-packages -r requirements.txt || true
cat > .env <<EOF
OS=$OS
PBX=$SYSTEM
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
DB_NAME=$DB_NAME
AMI_HOST=$AMI_HOST
AMI_PORT=$AMI_PORT
AMI_USERNAME=$AMI_USER
AMI_SECRET=$AMI_SECRET
EOF
cd "$PROJECT_ROOT/frontend" && npm install || true

# ===============================================================
# FINAL SUMMARY REPORT
# ===============================================================
echo -e "\n${YELLOW}Step 9: Generating Installation Report...${NC}"

echo -e "${GREEN}==============================================================="
echo "                  AOP INSTALLATION REPORT"
echo -e "===============================================================${NC}"
echo -e "${BLUE}PROJECT DETAILS:${NC}"
echo -e "  Location:      $PROJECT_ROOT"
echo -e "  OS Detected:   $OS"
echo -e "  PBX Platform:  $SYSTEM"
echo ""
echo -e "${BLUE}DATABASE DETAILS:${NC}"
echo -e "  Status:        $(mysqladmin -u$DB_USER -p$DB_PASS ping 2>/dev/null | grep -q "alive" && echo -e "${GREEN}Connected${NC}" || echo -e "${RED}Failed${NC}")"
echo -e "  Host/Port:     $DB_HOST:$DB_PORT"
echo -e "  Username:      $DB_USER"
echo -e "  Password:      $DB_PASS"
echo -e "  Database:      $DB_NAME"
echo ""
echo -e "${BLUE}ASTERISK AMI DETAILS:${NC}"
# Check if AMI Port is listening
AMI_STATUS=$(lsof -i :$AMI_PORT > /dev/null && echo -e "${GREEN}Active${NC}" || echo -e "${RED}Inactive (Check Asterisk)${NC}")
echo -e "  Status:        $AMI_STATUS"
echo -e "  Host/Port:     $AMI_HOST:$AMI_PORT"
echo -e "  Username:      $AMI_USER"
echo -e "  Secret:        $AMI_SECRET"
echo ""
echo -e "${BLUE}RUNTIME VERSIONS:${NC}"
echo -e "  Node.js:       $(node -v)"
echo -e "  Python:        $(python3 --version)"
echo ""
echo -e "${BLUE}COMMANDS:${NC}"
echo -e "  Run App:       ${YELLOW}./start.sh${NC}"
echo -e "  Config File:   ${YELLOW}cat $PROJECT_ROOT/backend/.env${NC}"
echo -e "==============================================================="
echo -e "Installation finished. You can now start the system using ${GREEN}./start.sh${NC}\n"