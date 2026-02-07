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
    sudo apt-get update && sudo apt-get install -y git lsof curl
elif [[ "$OS" =~ (centos|rhel|rocky|fedora) ]]; then
    sudo dnf install -y git lsof curl || sudo yum install -y git lsof  curl
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

# Check for Python 3.11+ versions
for PYTHON_VER in "3.13" "3.12" "3.11"; do
    if command_exists python${PYTHON_VER}; then
        PYTHON_11_PLUS_FOUND=true
        PYTHON_11_PLUS_VERSION=$PYTHON_VER
        PYTHON_11_PLUS_PATH=$(which python${PYTHON_VER} 2>/dev/null)
        if [ -n "$PYTHON_11_PLUS_PATH" ]; then
            echo -e "${GREEN}Found Python ${PYTHON_VER} at $PYTHON_11_PLUS_PATH${NC}"
            break
        fi
    fi
done

# Check existing python3 version if 3.11+ not found
if [ "$PYTHON_11_PLUS_FOUND" == "false" ]; then
    if command_exists python3; then
        PYTHON_VERSION_STR=$(python3 --version 2>&1)
        PYTHON_VERSION=$(echo "$PYTHON_VERSION_STR" | grep -oE '[0-9]+\.[0-9]+' | head -1)
        if [ -n "$PYTHON_VERSION" ]; then
            PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
            PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)
            if [ "$PYTHON_MAJOR" -lt 3 ] || ([ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -lt 11 ]); then
                PYTHON_NEEDS_UPGRADE=true
                echo -e "${YELLOW}Python version $PYTHON_VERSION is less than 3.11, upgrade needed${NC}"
            else
                PYTHON_11_PLUS_PATH=$(which python3 2>/dev/null)
                PYTHON_11_PLUS_FOUND=true
                echo -e "${GREEN}Found Python $PYTHON_VERSION at $PYTHON_11_PLUS_PATH${NC}"
            fi
        else
            PYTHON_NEEDS_UPGRADE=true
        fi
    else
        PYTHON_NEEDS_UPGRADE=true
    fi
fi

# Install Python 3.11+ if needed
if [ "$PYTHON_NEEDS_UPGRADE" == "true" ]; then
    echo -e "${YELLOW}Installing Python 3.11+...${NC}"
    if [ "$OS" == "debian" ] || [ "$OS" == "ubuntu" ]; then
        sudo apt-get update || true
        sudo apt-get install -y software-properties-common || true
        sudo add-apt-repository -y ppa:deadsnakes/ppa || true
        sudo apt-get update || true
        PYTHON_INSTALLED=false
        for VER in "3.13" "3.12" "3.11"; do
            if sudo apt-get install -y python${VER} python${VER}-venv python${VER}-dev 2>/dev/null; then
                PYTHON_11_PLUS_PATH=$(which python${VER} 2>/dev/null)
                if [ -n "$PYTHON_11_PLUS_PATH" ]; then
                    PYTHON_INSTALLED=true
                    echo -e "${GREEN}Successfully installed Python ${VER}${NC}"
                    break
                fi
            fi
        done
        if [ "$PYTHON_INSTALLED" == "false" ]; then
            echo -e "${YELLOW}Attempting to install python3 from default repositories...${NC}"
            sudo apt-get install -y python3 python3-pip python3-venv || true
            PYTHON_11_PLUS_PATH=$(which python3 2>/dev/null)
        fi
    elif [[ "$OS" =~ (centos|rhel|rocky|fedora) ]]; then
        # For RHEL-based systems
        if command_exists dnf; then
            sudo dnf install -y python3.11 python3.11-pip python3.11-devel || \
            sudo dnf install -y python3.12 python3.12-pip python3.12-devel || \
            sudo dnf install -y python3 python3-pip python3-devel || true
        else
            sudo yum install -y python3.11 python3.11-pip python3.11-devel || \
            sudo yum install -y python3 python3-pip python3-devel || true
        fi
        # Find installed Python version - check common paths directly
        for VER in "3.13" "3.12" "3.11" ""; do
            if [ -z "$VER" ]; then
                # Try which first, then common paths
                PYTHON_11_PLUS_PATH=$(which python3 2>/dev/null || echo "")
                if [ -z "$PYTHON_11_PLUS_PATH" ]; then
                    for COMMON_PATH in "/usr/bin/python3" "/usr/local/bin/python3"; do
                        if [ -f "$COMMON_PATH" ]; then
                            PYTHON_11_PLUS_PATH="$COMMON_PATH"
                            break
                        fi
                    done
                fi
            else
                # Try which first, then check common system paths
                PYTHON_11_PLUS_PATH=$(which python${VER} 2>/dev/null || which python3.${VER#*.} 2>/dev/null || echo "")
                if [ -z "$PYTHON_11_PLUS_PATH" ]; then
                    for COMMON_PATH in "/usr/bin/python${VER}" "/usr/bin/python3.${VER#*.}" "/usr/local/bin/python${VER}"; do
                        if [ -f "$COMMON_PATH" ]; then
                            PYTHON_11_PLUS_PATH="$COMMON_PATH"
                            break
                        fi
                    done
                fi
            fi
            if [ -n "$PYTHON_11_PLUS_PATH" ] && [ -f "$PYTHON_11_PLUS_PATH" ]; then
                echo -e "${GREEN}Found Python at $PYTHON_11_PLUS_PATH${NC}"
                break
            fi
        done
    else
        echo -e "${YELLOW}Unknown OS, attempting to use system python3...${NC}"
        PYTHON_11_PLUS_PATH=$(which python3 2>/dev/null)
    fi
fi

# Verify Python is available - try multiple methods
if [ -z "$PYTHON_11_PLUS_PATH" ] || [ ! -f "$PYTHON_11_PLUS_PATH" ]; then
    # Try which first
    PYTHON_11_PLUS_PATH=$(which python3 2>/dev/null || echo "")
    # If which failed, check common system paths
    if [ -z "$PYTHON_11_PLUS_PATH" ] || [ ! -f "$PYTHON_11_PLUS_PATH" ]; then
        for COMMON_PATH in "/usr/bin/python3.11" "/usr/bin/python3.12" "/usr/bin/python3.13" "/usr/bin/python3" "/usr/local/bin/python3"; do
            if [ -f "$COMMON_PATH" ]; then
                PYTHON_11_PLUS_PATH="$COMMON_PATH"
                echo -e "${GREEN}Found Python at $PYTHON_11_PLUS_PATH${NC}"
                break
            fi
        done
    fi
fi

if [ -z "$PYTHON_11_PLUS_PATH" ] || [ ! -f "$PYTHON_11_PLUS_PATH" ]; then
    echo -e "${RED}Error: Python installation failed. Please install Python 3.11+ manually.${NC}"
    exit 1
fi

# Create symlinks for python and pip
FINAL_PYTHON_PATH="$PYTHON_11_PLUS_PATH"
echo -e "${GREEN}Using Python: $FINAL_PYTHON_PATH${NC}"
sudo ln -sf "$FINAL_PYTHON_PATH" /usr/local/bin/python || true
sudo tee /usr/local/bin/pip > /dev/null << 'EOF'
#!/bin/bash
python -m pip "$@"
EOF
sudo chmod +x /usr/local/bin/pip || true

# Verify Python works
if ! "$FINAL_PYTHON_PATH" --version >/dev/null 2>&1; then
    echo -e "${RED}Error: Python verification failed${NC}"
    exit 1
fi
echo -e "${GREEN}Python installation verified: $($FINAL_PYTHON_PATH --version 2>&1)${NC}"
echo -e "${GREEN}Python installation completed successfully. Continuing with next steps...${NC}"

# --- Step 6: PBX & Database Config ---
echo -e "\n${YELLOW}Step 6: Detecting PBX Environment & Configuring Database...${NC}"
DB_HOST="localhost"
DB_PORT="3306"
DB_NAME="asterisk"
DB_USER="root"
DB_PASS=""
PBX="Generic"

# Detect PBX system
if [ -d /usr/share/issabel ]; then
    PBX="Issabel"
    echo -e "${GREEN}Detected Issabel PBX${NC}"
    if [ -f /etc/issabel.conf ]; then
        DB_PASS=$(grep -E "^mysqlrootpwd\s*=" /etc/issabel.conf 2>/dev/null | cut -d'=' -f2 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || echo "")
        if [ -z "$DB_PASS" ]; then
            DB_PASS=$(grep "mysqlrootpwd" /etc/issabel.conf 2>/dev/null | cut -d'=' -f2 | xargs 2>/dev/null || echo "")
        fi
        if [ -n "$DB_PASS" ]; then
            echo -e "${GREEN}Retrieved MySQL root password from Issabel config${NC}"
        else
            echo -e "${YELLOW}Could not retrieve MySQL password from Issabel config${NC}"
        fi
    fi
elif [ -f /etc/freepbx.conf ]; then
    PBX="FreePBX"
    echo -e "${GREEN}Detected FreePBX${NC}"
    DB_USER="AOP"
    DB_PASS=$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c 16 2>/dev/null || echo "$(date +%s | sha256sum | base64 | head -c 16)")
    
    # Check if MySQL/MariaDB is running
    if command_exists systemctl; then
        if systemctl is-active --quiet mysql || systemctl is-active --quiet mariadb; then
            echo -e "${GREEN}MySQL/MariaDB service is running${NC}"
        else
            echo -e "${YELLOW}MySQL/MariaDB service may not be running. Attempting to start...${NC}"
            sudo systemctl start mysql 2>/dev/null || sudo systemctl start mariadb 2>/dev/null || true
        fi
    fi
    
    # Try to create database user
    echo -e "${YELLOW}Creating database user '$DB_USER'...${NC}"
    if command_exists mysql; then
        # Try with sudo mysql (no password)
        if sudo mysql -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';" 2>/dev/null; then
            sudo mysql -e "GRANT ALL PRIVILEGES ON *.* TO '$DB_USER'@'localhost' WITH GRANT OPTION; FLUSH PRIVILEGES;" 2>/dev/null
            echo -e "${GREEN}Successfully created database user '$DB_USER'${NC}"
        # Try with mysql as root user
        elif mysql -u root -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';" 2>/dev/null; then
            mysql -u root -e "GRANT ALL PRIVILEGES ON *.* TO '$DB_USER'@'localhost' WITH GRANT OPTION; FLUSH PRIVILEGES;" 2>/dev/null
            echo -e "${GREEN}Successfully created database user '$DB_USER'${NC}"
        else
            echo -e "${YELLOW}Could not create database user automatically. You may need to create it manually.${NC}"
            echo -e "${YELLOW}Run: mysql -u root -p -e \"CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS'; GRANT ALL PRIVILEGES ON *.* TO '$DB_USER'@'localhost' WITH GRANT OPTION; FLUSH PRIVILEGES;\"${NC}"
        fi
    else
        echo -e "${YELLOW}MySQL client not found. Please install mysql-client and create user manually.${NC}"
    fi
else
    echo -e "${YELLOW}No specific PBX detected, using Generic configuration${NC}"
fi

# Verify database connection if possible
if command_exists mysql; then
    echo -e "${YELLOW}Verifying database connection...${NC}"
    if [ -n "$DB_PASS" ]; then
        if mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" -e "SELECT 1;" 2>/dev/null >/dev/null; then
            echo -e "${GREEN}Database connection successful${NC}"
        elif sudo mysql -e "SELECT 1;" 2>/dev/null >/dev/null; then
            echo -e "${GREEN}Database connection successful (using sudo)${NC}"
        else
            echo -e "${YELLOW}Could not verify database connection. Please check credentials manually.${NC}"
        fi
    else
        if sudo mysql -e "SELECT 1;" 2>/dev/null >/dev/null; then
            echo -e "${GREEN}Database connection successful (using sudo)${NC}"
        else
            echo -e "${YELLOW}Could not verify database connection. Please check MySQL/MariaDB is running.${NC}"
        fi
    fi
fi

echo -e "${GREEN}PBX System: $PBX${NC}"
echo -e "${GREEN}Database Host: $DB_HOST:$DB_PORT${NC}"
echo -e "${GREEN}Database User: $DB_USER${NC}"

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

# Only use --break-system-packages on Debian/Ubuntu systems
if [ "$OS" == "debian" ] || [ "$OS" == "ubuntu" ]; then
    echo -e "${YELLOW}Installing Python dependencies (Debian/Ubuntu)...${NC}"
    python -m pip install --break-system-packages -r requirements.txt || true
else
    echo -e "${YELLOW}Installing Python dependencies (non-Debian system)...${NC}"
    python -m pip install -r requirements.txt || true
fi
cat > .env <<EOF
OS=$OS
PBX=$PBX
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
clear
echo -e "\n${YELLOW}Step 9: Generating Installation Report...${NC}"

echo -e "${GREEN}==============================================================="
echo "                  AOP INSTALLATION REPORT"
echo -e "===============================================================${NC}"
echo -e "${BLUE}PROJECT DETAILS:${NC}"
echo -e "  Location:      $PROJECT_ROOT"
echo -e "  OS Detected:   $OS"
echo -e "  PBX Platform:  $PBX"
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
echo -e "  Python:        $(python --version)"
echo ""
echo -e "${BLUE}COMMANDS:${NC}"
echo -e "  Run App:       ${YELLOW}./start.sh${NC}"
echo -e "  Config File:   ${YELLOW}cat $PROJECT_ROOT/backend/.env${NC}"
echo -e "==============================================================="
echo -e "Installation finished. You can now start the system using ${GREEN}./start.sh${NC}\n"