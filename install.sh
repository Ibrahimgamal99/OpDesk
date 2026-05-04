#!/bin/bash

# =================================================================
# OpDesk System Unified Installation Script 
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

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# --- Detect mode: fresh install vs update ---
PROJECT_ROOT="/opt/OpDesk"
if [ -d "$PROJECT_ROOT/.git" ]; then
    IS_UPDATE=true
else
    IS_UPDATE=false
fi

echo -e "${BLUE}=================================================================${NC}"
echo -e "${BLUE}              OpDesk System Setup                               ${NC}"
echo -e "${BLUE}=================================================================${NC}"
if [ "$IS_UPDATE" == "true" ]; then
    echo -e "  Mode:    ${YELLOW}UPDATE${NC}  — existing installation found, pulling latest code"
else
    echo -e "  Mode:    ${GREEN}FRESH INSTALL${NC}  — no existing installation found"
fi
echo -e "  Target:  $PROJECT_ROOT"
echo -e "${BLUE}=================================================================${NC}"
echo ""

# --- Step 1: OS Detection ---
echo -e "\n${YELLOW}Step 1: Detecting Operating System...${NC}"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    OS="debian"
fi
echo -e "${GREEN}Detected OS: $OS${NC}"

# --- Step 2: Install Git & Required Tools ---
echo -e "\n${YELLOW}Step 2: Installing Git & Required Tools...${NC}"
if command_exists git && command_exists lsof && command_exists curl && command_exists openssl; then
    echo -e "${GREEN}All required tools already installed — skipping.${NC}"
else
    if [ "$OS" == "debian" ] || [ "$OS" == "ubuntu" ]; then
        sudo apt-get update && sudo apt-get install -y git lsof curl openssl
    elif [[ "$OS" =~ (centos|rhel|rocky|fedora) ]]; then
        sudo dnf install -y git lsof curl openssl || sudo yum install -y git lsof curl openssl
    fi
fi

# --- Step 3: Repository Setup ---
echo -e "\n${YELLOW}Step 3: Setting Up Repository...${NC}"
REPO_URL="https://github.com/Ibrahimgamal99/OpDesk.git"

if [ -d "$PROJECT_ROOT/.git" ]; then
    echo -e "${YELLOW}Pulling latest code from GitHub...${NC}"
    cd "$PROJECT_ROOT"
    git fetch origin
    BEFORE=$(git rev-parse HEAD)
    git pull origin "$(git rev-parse --abbrev-ref HEAD)" || { echo -e "${RED}git pull failed. Check connectivity or resolve conflicts manually.${NC}"; exit 1; }
    AFTER=$(git rev-parse HEAD)
    if [ "$BEFORE" != "$AFTER" ]; then
        echo -e "${GREEN}Code updated: $BEFORE -> $AFTER${NC}"
    else
        echo -e "${GREEN}Already up to date.${NC}"
    fi
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
    echo -e "${YELLOW}Installing NVM...${NC}"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
else
    echo -e "${GREEN}NVM already installed — skipping.${NC}"
fi
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
CURRENT_NODE=$(node --version 2>/dev/null | grep -oE '^v24\.' || true)
if [ -n "$CURRENT_NODE" ]; then
    echo -e "${GREEN}Node.js 24 already active ($(node --version)) — skipping install.${NC}"
    nvm use 24 2>/dev/null || true
else
    echo -e "${YELLOW}Installing Node.js 24...${NC}"
    nvm install 24 && nvm use 24 && nvm alias default 24
fi

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

# Install pip if not already available
echo -e "\n${YELLOW}Installing pip...${NC}"
if ! "$FINAL_PYTHON_PATH" -m pip --version >/dev/null 2>&1; then
    if [ "$OS" == "debian" ] || [ "$OS" == "ubuntu" ]; then
        # Extract Python version from path
        PYTHON_VER=$(basename "$FINAL_PYTHON_PATH" | grep -oE '[0-9]+\.[0-9]+' | head -1)
        if [ -n "$PYTHON_VER" ]; then
            sudo apt-get install -y python${PYTHON_VER}-pip python${PYTHON_VER}-distutils || \
            sudo apt-get install -y python3-pip || true
        else
            sudo apt-get install -y python3-pip || true
        fi
    elif [[ "$OS" =~ (centos|rhel|rocky|fedora) ]]; then
        # Extract Python version from path
        PYTHON_VER=$(basename "$FINAL_PYTHON_PATH" | grep -oE '[0-9]+\.[0-9]+' | head -1)
        if [ -n "$PYTHON_VER" ]; then
            if command_exists dnf; then
                sudo dnf install -y python${PYTHON_VER}-pip || sudo dnf install -y python3-pip || true
            else
                sudo yum install -y python${PYTHON_VER}-pip || sudo yum install -y python3-pip || true
            fi
        else
            if command_exists dnf; then
                sudo dnf install -y python3-pip || true
            else
                sudo yum install -y python3-pip || true
            fi
        fi
    fi
    
    # If package manager installation failed, try ensurepip
    if ! "$FINAL_PYTHON_PATH" -m pip --version >/dev/null 2>&1; then
        echo -e "${YELLOW}Attempting to install pip using ensurepip...${NC}"
        "$FINAL_PYTHON_PATH" -m ensurepip --upgrade --default-pip 2>/dev/null || true
    fi
    
    # Verify pip installation
    if "$FINAL_PYTHON_PATH" -m pip --version >/dev/null 2>&1; then
        echo -e "${GREEN}pip installation verified: $($FINAL_PYTHON_PATH -m pip --version 2>&1 | head -1)${NC}"
    else
        echo -e "${YELLOW}Warning: pip installation may have failed. You may need to install it manually.${NC}"
    fi
else
    echo -e "${GREEN}pip is already installed: $($FINAL_PYTHON_PATH -m pip --version 2>&1 | head -1)${NC}"
fi

echo -e "${GREEN}Python and pip installation completed successfully. Continuing with next steps...${NC}"

# --- Step 6: PBX & Database Config ---
echo -e "\n${YELLOW}Step 6: Detecting PBX Environment & Configuring Database...${NC}"
DB_HOST="localhost"
DB_PORT="3306"
DB_NAME="asterisk"
DB_USER="root"
DB_PASS=""
DB_EXISTING=""
PBX="Generic"

# Use existing database config from previous install if present
if [ -f "$PROJECT_ROOT/backend/.env" ]; then
    _db_host=$(grep -E '^DB_HOST=' "$PROJECT_ROOT/backend/.env" 2>/dev/null | cut -d= -f2- | sed "s/^['\"]*//;s/['\"]*$//")
    _db_port=$(grep -E '^DB_PORT=' "$PROJECT_ROOT/backend/.env" 2>/dev/null | cut -d= -f2- | sed "s/^['\"]*//;s/['\"]*$//")
    _db_name=$(grep -E '^DB_NAME=' "$PROJECT_ROOT/backend/.env" 2>/dev/null | cut -d= -f2- | sed "s/^['\"]*//;s/['\"]*$//")
    _db_user=$(grep -E '^DB_USER=' "$PROJECT_ROOT/backend/.env" 2>/dev/null | cut -d= -f2- | sed "s/^['\"]*//;s/['\"]*$//")
    _db_pass=$(grep -E '^DB_PASSWORD=' "$PROJECT_ROOT/backend/.env" 2>/dev/null | cut -d= -f2- | sed "s/^['\"]*//;s/['\"]*$//")
    _pbx=$(grep -E '^PBX=' "$PROJECT_ROOT/backend/.env" 2>/dev/null | cut -d= -f2- | sed "s/^['\"]*//;s/['\"]*$//")
    if [ -n "$_db_user" ]; then
        DB_HOST="${_db_host:-$DB_HOST}"; DB_PORT="${_db_port:-$DB_PORT}"; DB_NAME="${_db_name:-$DB_NAME}"; DB_USER="$_db_user"; DB_PASS="$_db_pass"
        [ -n "$_pbx" ] && PBX="$_pbx"
        DB_EXISTING=" (existing)"
        echo -e "${GREEN}Using existing database configuration from .env${NC}"
    fi
fi

# Detect PBX system (skip creating user if we already loaded from .env)
if [ -n "$DB_EXISTING" ]; then
    :
elif [ -d /usr/share/issabel ]; then
    PBX="Issabel"
    echo -e "${GREEN}Detected Issabel PBX${NC}"
    DB_USER="OpDesk"
    _root_pass=""
    if [ -f /etc/issabel.conf ]; then
        _root_pass=$(grep -E "^mysqlrootpwd\s*=" /etc/issabel.conf 2>/dev/null | cut -d'=' -f2 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || echo "")
        if [ -z "$_root_pass" ]; then
            _root_pass=$(grep "mysqlrootpwd" /etc/issabel.conf 2>/dev/null | cut -d'=' -f2 | xargs 2>/dev/null || echo "")
        fi
        if [ -n "$_root_pass" ]; then
            echo -e "${GREEN}Retrieved MySQL root password from Issabel config${NC}"
        else
            echo -e "${YELLOW}Could not retrieve MySQL password from Issabel config${NC}"
        fi
    fi
    # Check if OpDesk user already exists in MySQL (do not overwrite)
    _opdesk_exists=""
    if command_exists mysql; then
        if [ -n "$_root_pass" ]; then
            if mysql -u root -p"$_root_pass" -e "SELECT 1 FROM mysql.user WHERE User='OpDesk' AND Host='localhost';" 2>/dev/null | grep -q 1; then
                _opdesk_exists=1
            fi
        fi
        if [ -z "$_opdesk_exists" ] && sudo mysql -e "SELECT 1 FROM mysql.user WHERE User='OpDesk' AND Host='localhost';" 2>/dev/null | grep -q 1; then
            _opdesk_exists=1
        fi
    fi
    if [ -n "$_opdesk_exists" ]; then
        DB_EXISTING=" (existing)"
        echo -e "${GREEN}Using existing database user in MySQL: $DB_USER${NC}"
        if [ -f "$PROJECT_ROOT/backend/.env" ]; then
            _existing_pass=$(grep -E '^DB_PASSWORD=' "$PROJECT_ROOT/backend/.env" 2>/dev/null | cut -d= -f2- | sed "s/^['\"]*//;s/['\"]*$//")
            [ -n "$_existing_pass" ] && DB_PASS="$_existing_pass"
        fi
    else
        DB_PASS=$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c 16 2>/dev/null || echo "$(date +%s | sha256sum | base64 | head -c 16)")
    fi
    # Create database user only if it does not already exist
    if [ -z "$_opdesk_exists" ]; then
        if command_exists systemctl; then
            if systemctl is-active --quiet mysql || systemctl is-active --quiet mariadb; then
                echo -e "${GREEN}MySQL/MariaDB service is running${NC}"
            else
                echo -e "${YELLOW}MySQL/MariaDB service may not be running. Attempting to start...${NC}"
                sudo systemctl start mysql 2>/dev/null || sudo systemctl start mariadb 2>/dev/null || true
            fi
        fi
        echo -e "${YELLOW}Creating database user '$DB_USER'...${NC}"
        if command_exists mysql; then
            if [ -n "$_root_pass" ] && mysql -u root -p"$_root_pass" -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';" 2>/dev/null; then
                mysql -u root -p"$_root_pass" -e "GRANT SELECT ON asterisk.* TO '$DB_USER'@'localhost'; GRANT SELECT ON asteriskcdrdb.* TO '$DB_USER'@'localhost'; GRANT ALL PRIVILEGES ON OpDesk.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;" 2>/dev/null
                echo -e "${GREEN}Successfully created database user '$DB_USER'${NC}"
            elif sudo mysql -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';" 2>/dev/null; then
                sudo mysql -e "GRANT SELECT ON asterisk.* TO '$DB_USER'@'localhost'; GRANT SELECT ON asteriskcdrdb.* TO '$DB_USER'@'localhost'; GRANT ALL PRIVILEGES ON OpDesk.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;" 2>/dev/null
                echo -e "${GREEN}Successfully created database user '$DB_USER'${NC}"
            elif mysql -u root -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';" 2>/dev/null; then
                mysql -u root -e "GRANT SELECT ON asterisk.* TO '$DB_USER'@'localhost'; GRANT SELECT ON asteriskcdrdb.* TO '$DB_USER'@'localhost'; GRANT ALL PRIVILEGES ON OpDesk.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;" 2>/dev/null
                echo -e "${GREEN}Successfully created database user '$DB_USER'${NC}"
            else
                echo -e "${YELLOW}Could not create database user automatically. You may need to create it manually.${NC}"
                echo -e "${YELLOW}Run: mysql -u root -p -e \"CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS'; GRANT SELECT ON asterisk.* TO '$DB_USER'@'localhost'; GRANT SELECT ON asteriskcdrdb.* TO '$DB_USER'@'localhost'; GRANT ALL PRIVILEGES ON OpDesk.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;\"${NC}"
            fi
        else
            echo -e "${YELLOW}MySQL client not found. Please install mysql-client and create user manually.${NC}"
        fi
    fi
elif [ -f /etc/freepbx.conf ]; then
    PBX="FreePBX"
    echo -e "${GREEN}Detected FreePBX${NC}"
    DB_USER="OpDesk"
    # Check if OpDesk user already exists in MySQL (do not overwrite)
    _opdesk_exists=""
    if command_exists mysql; then
        if sudo mysql -e "SELECT 1 FROM mysql.user WHERE User='OpDesk' AND Host='localhost';" 2>/dev/null | grep -q 1; then
            _opdesk_exists=1
        elif mysql -u root -e "SELECT 1 FROM mysql.user WHERE User='OpDesk' AND Host='localhost';" 2>/dev/null | grep -q 1; then
            _opdesk_exists=1
        fi
    fi
    if [ -n "$_opdesk_exists" ]; then
        DB_EXISTING=" (existing)"
        echo -e "${GREEN}Using existing database user in MySQL: $DB_USER${NC}"
        # Use password from .env if present; otherwise leave empty (user must set in .env)
        if [ -f "$PROJECT_ROOT/backend/.env" ]; then
            _existing_pass=$(grep -E '^DB_PASSWORD=' "$PROJECT_ROOT/backend/.env" 2>/dev/null | cut -d= -f2- | sed "s/^['\"]*//;s/['\"]*$//")
            [ -n "$_existing_pass" ] && DB_PASS="$_existing_pass"
        fi
    else
        DB_PASS=$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c 16 2>/dev/null || echo "$(date +%s | sha256sum | base64 | head -c 16)")
    fi
    
    # Create database user only if it does not already exist
    if [ -z "$_opdesk_exists" ]; then
        if command_exists systemctl; then
            if systemctl is-active --quiet mysql || systemctl is-active --quiet mariadb; then
                echo -e "${GREEN}MySQL/MariaDB service is running${NC}"
            else
                echo -e "${YELLOW}MySQL/MariaDB service may not be running. Attempting to start...${NC}"
                sudo systemctl start mysql 2>/dev/null || sudo systemctl start mariadb 2>/dev/null || true
            fi
        fi
        echo -e "${YELLOW}Creating database user '$DB_USER'...${NC}"
        if command_exists mysql; then
            if sudo mysql -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';" 2>/dev/null; then
                sudo mysql -e "GRANT SELECT ON asterisk.* TO '$DB_USER'@'localhost'; GRANT SELECT ON asteriskcdrdb.* TO '$DB_USER'@'localhost'; GRANT ALL PRIVILEGES ON OpDesk.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;" 2>/dev/null
                echo -e "${GREEN}Successfully created database user '$DB_USER'${NC}"
            elif mysql -u root -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';" 2>/dev/null; then
                mysql -u root -e "GRANT SELECT ON asterisk.* TO '$DB_USER'@'localhost'; GRANT SELECT ON asteriskcdrdb.* TO '$DB_USER'@'localhost'; GRANT ALL PRIVILEGES ON OpDesk.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;" 2>/dev/null
                echo -e "${GREEN}Successfully created database user '$DB_USER'${NC}"
            else
                echo -e "${YELLOW}Could not create database user automatically. You may need to create it manually.${NC}"
                echo -e "${YELLOW}Run: mysql -u root -p -e \"CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS'; GRANT SELECT ON asterisk.* TO '$DB_USER'@'localhost'; GRANT SELECT ON asteriskcdrdb.* TO '$DB_USER'@'localhost'; GRANT ALL PRIVILEGES ON OpDesk.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;\"${NC}"
            fi
        else
            echo -e "${YELLOW}MySQL client not found. Please install mysql-client and create user manually.${NC}"
        fi
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
AMI_HOST="localhost"; AMI_PORT="5038"; AMI_USER="OpDesk"
AMI_USER_EXISTING=""
if [ -f /etc/asterisk/manager_custom.conf ] && grep -q "\[$AMI_USER\]" /etc/asterisk/manager_custom.conf; then
    # AMI user already exists in manager_custom.conf: do not rewrite; use existing secret
    AMI_SECRET=$(sed -n '/^\['"$AMI_USER"'\][[:space:]]*$/,/^\[/p' /etc/asterisk/manager_custom.conf | grep -E '^[[:space:]]*secret[[:space:]]*=' | head -1 | sed 's/^[^=]*=[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$AMI_SECRET" ] && AMI_SECRET=$(openssl rand -hex 4)
    AMI_USER_EXISTING=" (existing in manager_custom.conf)"
    echo -e "${GREEN}Using existing AMI user in manager: $AMI_USER${NC}"
else
    AMI_SECRET=$(openssl rand -hex 4)
    if [ -f /etc/asterisk/manager_custom.conf ]; then
        sudo tee -a /etc/asterisk/manager_custom.conf <<EOF

[$AMI_USER]
secret = $AMI_SECRET
read = all
write = all
permit = 127.0.0.1/255.255.255.255
EOF
        sudo asterisk -rx "manager reload" || true
    fi
fi

# --- Step 8: App Config & HTTPS Certificate ---
echo -e "\n${YELLOW}Step 8: Configuring Application, HTTPS & Installing Dependencies...${NC}"
cd "$PROJECT_ROOT/backend"

# Only use --break-system-packages on Debian/Ubuntu systems
if [ "$OS" == "debian" ] || [ "$OS" == "ubuntu" ]; then
    echo -e "${YELLOW}Installing Python dependencies (Debian/Ubuntu)...${NC}"
    python -m pip install --break-system-packages -r requirements.txt || true
else
    echo -e "${YELLOW}Installing Python dependencies (non-Debian system)...${NC}"
    python -m pip install -r requirements.txt || true
fi

# Generate or reuse OpDesk HTTPS certificate (for backend and optional Asterisk)
echo -e "\n${YELLOW}Generating HTTPS certificate for OpDesk (and Asterisk if present)...${NC}"
CERT_DIR="$PROJECT_ROOT/cert"
mkdir -p "$CERT_DIR"
HTTPS_CERT="$CERT_DIR/opdesk_cert.pem"
HTTPS_KEY="$CERT_DIR/opdesk_key.pem"
OPDESK_HTTPS_PORT="8443"

if [ -f "$HTTPS_CERT" ] && [ -f "$HTTPS_KEY" ]; then
    echo -e "${GREEN}Existing HTTPS certificate found at $HTTPS_CERT and key at $HTTPS_KEY; reusing.${NC}"
else
    # Detect primary local IP; fallback to localhost
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -z "$LOCAL_IP" ] && LOCAL_IP="localhost"
    CN="$LOCAL_IP"

    echo -e "${YELLOW}Creating new self-signed certificate with CN=$CN ...${NC}"
    openssl req -x509 -newkey rsa:4096 -keyout "$HTTPS_KEY" -out "$HTTPS_CERT" -days 365 -nodes \
      -subj "/CN=$CN"

    chmod 600 "$HTTPS_KEY"
    chmod 644 "$HTTPS_CERT"

    # Verify cert and key match (avoids Asterisk "Internal SSL error" from mismatch)
    CERT_MOD=$(openssl x509 -noout -modulus -in "$HTTPS_CERT" 2>/dev/null | openssl md5)
    KEY_MOD=$(openssl rsa -noout -modulus -in "$HTTPS_KEY" 2>/dev/null | openssl md5)
    if [[ "$CERT_MOD" != "$KEY_MOD" ]]; then
        echo -e "${RED}Error: Generated certificate and key modulus mismatch. Please re-run installation.${NC}"
        exit 1
    fi
    echo -e "${GREEN}Created HTTPS certificate and key (CN=$CN) at:${NC}"
    echo -e "  Cert: $HTTPS_CERT"
    echo -e "  Key:  $HTTPS_KEY"

    # If Asterisk is installed, install the same cert/key for it (wss://)
    if [ -d /etc/asterisk ]; then
        AST_DIR="/etc/asterisk/keys"
        AST_CERT="$AST_DIR/opdesk_cert.pem"
        AST_KEY="$AST_DIR/opdesk_key.pem"
        if [ "$EUID" -ne 0 ]; then
            echo -e "${YELLOW}To install certificate for Asterisk, re-run install as root or manually run:${NC}"
            echo -e "  sudo cp \"$HTTPS_CERT\" \"$AST_CERT\""
            echo -e "  sudo cp \"$HTTPS_KEY\" \"$AST_KEY\""
            echo -e "  sudo chown asterisk:asterisk \"$AST_CERT\" \"$AST_KEY\""
            echo -e "  sudo chmod 644 \"$AST_CERT\""
            echo -e "  sudo chmod 600 \"$AST_KEY\""
        else
            cp "$HTTPS_CERT" "$AST_CERT"
            cp "$HTTPS_KEY" "$AST_KEY"
            chown asterisk:asterisk "$AST_CERT" "$AST_KEY" || true
            chmod 644 "$AST_CERT"
            chmod 600 "$AST_KEY"
            echo -e "${GREEN}Installed same certificate for Asterisk at:${NC}"
            echo -e "  Cert: $AST_CERT"
            echo -e "  Key:  $AST_KEY"
        fi
    fi
fi

# --- Step 8b: Nginx + TLS orchestration ---
echo -e "\n${YELLOW}Step 8b: Configuring Nginx reverse proxy...${NC}"

# Read OPDESK_DOMAIN from env or existing .env so subsequent runs remember it
if [ -z "$OPDESK_DOMAIN" ] && [ -f "$PROJECT_ROOT/backend/.env" ]; then
    OPDESK_DOMAIN=$(grep -E '^OPDESK_DOMAIN=' "$PROJECT_ROOT/backend/.env" 2>/dev/null \
                    | cut -d= -f2- | sed "s/^['\"]*//;s/['\"]*$//")
fi

NGINX_SERVER_NAME="_"
NGINX_SSL_CERT="$HTTPS_CERT"
NGINX_SSL_KEY="$HTTPS_KEY"

# Return the PID of the process LISTENING on a port (empty if none / nginx)
_listening_pid() {
    local port="$1"
    local pid
    pid=$(ss -tlnp "sport = :$port" 2>/dev/null | awk 'NR>1{print $NF}' \
          | grep -oP 'pid=\K[0-9]+' | head -1)
    [ -z "$pid" ] && pid=$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)
    echo "$pid"
}

# Move Apache's listener from one port to another (Debian + CentOS/RHEL)
_move_apache_port() {
    local from="$1" to="$2" changed=0
    if [ -f /etc/apache2/ports.conf ]; then
        sudo sed -i "s/\bListen $from\b/Listen $to/g" /etc/apache2/ports.conf && changed=1
        sudo find /etc/apache2/sites-enabled -type f \
            -exec sudo sed -i "s/<VirtualHost \*:$from>/<VirtualHost *:$to>/g" {} \; 2>/dev/null || true
        sudo systemctl restart apache2 2>/dev/null || true
    fi
    if [ -f /etc/httpd/conf/httpd.conf ]; then
        sudo sed -i "s/^Listen $from\b/Listen $to/" /etc/httpd/conf/httpd.conf && changed=1
    fi
    for f in /etc/httpd/conf.d/*.conf; do
        [ -f "$f" ] || continue
        if grep -qE "^Listen $from\b|<VirtualHost [^>]*:$from>" "$f" 2>/dev/null; then
            sudo sed -i \
                "s/^Listen $from\b/Listen $to/;s/<VirtualHost \*:$from>/<VirtualHost *:$to>/g" \
                "$f" && changed=1
        fi
    done
    if [ "$changed" -eq 1 ] && systemctl is-active httpd &>/dev/null; then
        sudo systemctl restart httpd 2>/dev/null || true
    fi
}

# Read a valid port number from stdin
_read_port() {
    local prompt="$1" default="$2" val
    while true; do
        read -rp "$prompt" val
        val="${val:-$default}"
        if [[ "$val" =~ ^[0-9]+$ ]] && [ "$val" -ge 1 ] && [ "$val" -le 65535 ]; then
            echo "$val"; return
        fi
        echo -e "${RED}  Invalid port. Enter a number between 1 and 65535.${NC}" >&2
    done
}

# Resolve a port conflict interactively.
# Sets NGINX_HTTPS_PORT or NGINX_HTTP_PORT as a side-effect via caller's variable.
# Usage: _resolve_port_conflict <port> <varname> <pbx_fallback_port>
#   port            — the contested port (443 or 80)
#   varname         — shell variable to update with the chosen Nginx port
#   pbx_fallback    — port Apache/httpd will be moved to if user picks option 2
_resolve_port_conflict() {
    local port="$1" varname="$2" pbx_fallback="$3"
    local pid proc
    pid=$(_listening_pid "$port")
    [ -z "$pid" ] && return          # port is free
    proc=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    [ -z "$proc" ] && return         # process gone
    [ "$proc" = "nginx" ] && return  # already ours

    echo -e "${RED}Port $port is in use by '$proc' (PID $pid).${NC}"
    echo -e "${YELLOW}How would you like to resolve this?${NC}"
    echo -e "  ${GREEN}1)${NC} Change Nginx to listen on a different port"
    echo -e "  ${GREEN}2)${NC} Move '$proc' away from port $port (to $pbx_fallback)"
    echo -ne "Enter choice [1/2]: "
    local choice
    read -r choice
    case "$choice" in
        2)
            if [[ "$proc" =~ ^(apache2|httpd)$ ]]; then
                echo -e "${YELLOW}Moving $proc from port $port to $pbx_fallback...${NC}"
                _move_apache_port "$port" "$pbx_fallback"
                sleep 2
                local new_pid new_proc
                new_pid=$(_listening_pid "$port")
                new_proc=""
                [ -n "$new_pid" ] && new_proc=$(ps -p "$new_pid" -o comm= 2>/dev/null || true)
                if [ -z "$new_proc" ] || [ "$new_proc" = "nginx" ]; then
                    echo -e "${GREEN}Done — $proc is now on $pbx_fallback. Nginx will use port $port.${NC}"
                else
                    echo -e "${RED}Could not free port $port. Falling back to option 1.${NC}"
                    choice=1
                fi
            else
                echo -e "${RED}'$proc' is not Apache/httpd — cannot auto-move. Falling back to option 1.${NC}"
                choice=1
            fi
            ;;
    esac
    if [ "$choice" = "1" ]; then
        local new_port
        new_port=$(_read_port "  Enter new port for Nginx (currently $port): " "$port")
        printf -v "$varname" '%s' "$new_port"
        echo -e "${GREEN}Nginx will use port $new_port instead of $port.${NC}"
    fi
}

# Ports Nginx will listen on — may be changed interactively below
NGINX_HTTPS_PORT=443
NGINX_HTTP_PORT=80

_resolve_port_conflict 443 NGINX_HTTPS_PORT 4443
_resolve_port_conflict 80  NGINX_HTTP_PORT  8080

# Install Nginx if not present
if ! command_exists nginx; then
    echo -e "${YELLOW}Installing Nginx...${NC}"
    if [ "$OS" == "debian" ] || [ "$OS" == "ubuntu" ]; then
        sudo apt-get update -qq && sudo apt-get install -y nginx
    elif [[ "$OS" =~ (centos|rhel|rocky|fedora) ]]; then
        sudo dnf install -y nginx || sudo yum install -y nginx
    fi
fi
sudo systemctl enable nginx 2>/dev/null || true

# Public-domain mode: obtain or reuse Let's Encrypt cert
if [ -n "$OPDESK_DOMAIN" ]; then
    NGINX_SERVER_NAME="$OPDESK_DOMAIN"
    LE_CERT="/etc/letsencrypt/live/$OPDESK_DOMAIN/fullchain.pem"
    LE_KEY="/etc/letsencrypt/live/$OPDESK_DOMAIN/privkey.pem"
    if [ ! -f "$LE_CERT" ]; then
        echo -e "${YELLOW}Obtaining Let's Encrypt certificate for $OPDESK_DOMAIN...${NC}"
        if ! command_exists certbot; then
            if [ "$OS" == "debian" ] || [ "$OS" == "ubuntu" ]; then
                sudo apt-get install -y certbot python3-certbot-nginx
            elif [[ "$OS" =~ (centos|rhel|rocky|fedora) ]]; then
                sudo dnf install -y certbot python3-certbot-nginx \
                || sudo yum install -y certbot python3-certbot-nginx || true
            fi
        fi
        LE_EMAIL="${OPDESK_LE_EMAIL:-admin@$OPDESK_DOMAIN}"
        sudo certbot certonly --nginx \
            -d "$OPDESK_DOMAIN" \
            --non-interactive --agree-tos -m "$LE_EMAIL" || true
    fi
    if [ -f "$LE_CERT" ]; then
        NGINX_SSL_CERT="$LE_CERT"
        NGINX_SSL_KEY="$LE_KEY"
        echo -e "${GREEN}Using Let's Encrypt certificate for $OPDESK_DOMAIN${NC}"
    else
        echo -e "${YELLOW}Could not obtain Let's Encrypt cert; falling back to self-signed${NC}"
    fi
fi

# Write Nginx vhost config — stored in project folder, symlinked into Nginx
mkdir -p "$PROJECT_ROOT/nginx"
sudo mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
tee "$PROJECT_ROOT/nginx/opdesk.conf" > /dev/null <<NGINXEOF
upstream opdesk_app  { server 127.0.0.1:8765; keepalive 32; }
upstream asterisk_ws { server 127.0.0.1:8088; keepalive 16; }

map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen $NGINX_HTTPS_PORT ssl http2;
    listen [::]:$NGINX_HTTPS_PORT ssl http2;
    server_name $NGINX_SERVER_NAME;

    ssl_certificate     $NGINX_SSL_CERT;
    ssl_certificate_key $NGINX_SSL_KEY;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    location = /ws {
        proxy_pass         http://opdesk_app;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        \$connection_upgrade;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   X-Forwarded-Host  \$host;
        proxy_read_timeout 3600s;
    }

    location = /sip-ws {
        proxy_pass         http://asterisk_ws/ws;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        \$connection_upgrade;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass         http://opdesk_app;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   X-Forwarded-Host  \$host;
        client_max_body_size 25m;
    }
}

server {
    listen $NGINX_HTTP_PORT;
    listen [::]:$NGINX_HTTP_PORT;
    server_name $NGINX_SERVER_NAME;
    return 301 https://\$host\$request_uri;
}
NGINXEOF

sudo ln -sf "$PROJECT_ROOT/nginx/opdesk.conf" /etc/nginx/sites-available/opdesk
sudo ln -sf /etc/nginx/sites-available/opdesk /etc/nginx/sites-enabled/opdesk
sudo rm -f /etc/nginx/sites-enabled/default
if sudo nginx -t 2>/dev/null; then
    sudo systemctl reload nginx 2>/dev/null || sudo systemctl start nginx 2>/dev/null || true
    echo -e "${GREEN}Nginx configured and running (config: $PROJECT_ROOT/nginx/opdesk.conf)${NC}"
else
    echo -e "${RED}Nginx config test failed — check $PROJECT_ROOT/nginx/opdesk.conf${NC}"
fi

# --- Admin Password Setup (fresh install only) ---
ADMIN_INIT_PASSWORD_HASH=""
if [ "$IS_UPDATE" != "true" ]; then
    echo -e "\n${YELLOW}Admin Panel Setup:${NC}"
    echo -e "  ${BLUE}Press Enter to keep the default password.${NC}"
    read -s -p "  Enter the password for Admin Panel: " ADMIN_PASSWORD
    echo ""
    if [ -z "$ADMIN_PASSWORD" ]; then
        echo -e "${GREEN}  Using default admin password (from schema.sql).${NC}"
    else
        while true; do
            read -s -p "  Confirm password: " ADMIN_PASSWORD_CONFIRM
            echo ""
            if [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]; then
                echo -e "${YELLOW}  Passwords do not match. Please re-enter.${NC}"
                read -s -p "  Admin password: " ADMIN_PASSWORD
                echo ""
                if [ -z "$ADMIN_PASSWORD" ]; then
                    break
                fi
            else
                break
            fi
        done
        if [ -n "$ADMIN_PASSWORD" ]; then
            ADMIN_INIT_PASSWORD_HASH=$(python3 -c "
import sys, bcrypt
pw = sys.argv[1].encode()
print(bcrypt.hashpw(pw, bcrypt.gensalt()).decode())
" "$ADMIN_PASSWORD" 2>/dev/null || python -c "
import sys, bcrypt
pw = sys.argv[1].encode()
print(bcrypt.hashpw(pw, bcrypt.gensalt()).decode())
" "$ADMIN_PASSWORD" 2>/dev/null || echo "")
            if [ -z "$ADMIN_INIT_PASSWORD_HASH" ]; then
                echo -e "${YELLOW}  Warning: Could not generate password hash (bcrypt missing?). Default password will be used.${NC}"
            else
                python3 -c "
import sys, re
# Match any bcrypt hash pattern (\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}) in the admin INSERT line
with open(sys.argv[1]) as f:
    content = f.read()
new_content = re.sub(
    r\"(INSERT\s+IGNORE\s+INTO\s+users\s+\(username,\s*password_hash,\s*name,\s*role\)\s+VALUES\s*\(\s*'admin'\s*,\s*')\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}('\s*,\s*'Admin'\s*,\s*'admin'\s*\))\",
    r'\1' + sys.argv[2] + r'\2',
    content
)
if new_content == content:
    # Fallback: replace any bcrypt hash in the file
    new_content = re.sub(r'\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}', sys.argv[2], content)
with open(sys.argv[1], 'w') as f:
    f.write(new_content)
" "$PROJECT_ROOT/backend/schema.sql" "$ADMIN_INIT_PASSWORD_HASH" 2>/dev/null || true
                echo -e "${GREEN}  Admin password configured successfully.${NC}"
            fi
        fi
    fi
fi

LOCAL_IP_ADDR=$(hostname -I | awk '{print $1}')
if [ -n "$OPDESK_DOMAIN" ]; then
    CORS_ORIGINS="https://$OPDESK_DOMAIN,https://$LOCAL_IP_ADDR"
else
    CORS_ORIGINS="https://$LOCAL_IP_ADDR"
fi

# Always re-read AMI_SECRET from manager_custom.conf (authoritative source)
if [ -f /etc/asterisk/manager_custom.conf ] && grep -q "\[OpDesk\]" /etc/asterisk/manager_custom.conf; then
    _ami=$(sed -n '/^\[OpDesk\][[:space:]]*$/,/^\[/p' /etc/asterisk/manager_custom.conf \
          | grep -E '^[[:space:]]*secret[[:space:]]*=' | head -1 \
          | sed 's/^[^=]*=[[:space:]]*//;s/[[:space:]]*$//')
    [ -n "$_ami" ] && AMI_SECRET="$_ami"
fi
# Fallback: preserve from existing .env
if [ -z "$AMI_SECRET" ] && [ -f "$PROJECT_ROOT/backend/.env" ]; then
    _ami=$(grep -E '^AMI_SECRET=' "$PROJECT_ROOT/backend/.env" | cut -d= -f2-)
    [ -n "$_ami" ] && AMI_SECRET="$_ami"
fi

# Preserve JWT_SECRET across updates — only generate on fresh install
if [ -f "$PROJECT_ROOT/backend/.env" ]; then
    _jwt=$(grep -E '^JWT_SECRET=' "$PROJECT_ROOT/backend/.env" | cut -d= -f2-)
else
    _jwt=""
fi
JWT_SECRET="${_jwt:-$(openssl rand -hex 32)}"

cat > .env <<EOF
OS=$OS
PBX=$PBX
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
DB_NAME=$DB_NAME
DB_CDR=asteriskcdrdb
ASTERISK_RECORDING_ROOT_DIR=/var/spool/asterisk/monitor/
AMI_HOST=$AMI_HOST
AMI_PORT=$AMI_PORT
AMI_USERNAME=$AMI_USER
AMI_SECRET=$AMI_SECRET
DB_OpDesk=OpDesk
JWT_SECRET=$JWT_SECRET
HTTPS_CERT=
HTTPS_KEY=
OPDESK_BIND_HOST=127.0.0.1
OPDESK_DOMAIN=$OPDESK_DOMAIN
CORS_ALLOWED_ORIGINS=$CORS_ORIGINS
EOF
cd "$PROJECT_ROOT/frontend" && npm install || true

# --- Step 9: systemd Service ---
echo -e "\n${YELLOW}Step 9: Configuring OpDesk systemd service...${NC}"

SERVICE_USER="${SUDO_USER:-$USER}"
SERVICE_HOME=$(eval echo ~"$SERVICE_USER" 2>/dev/null || echo "$HOME")

if [ ! -f /etc/systemd/system/opdesk.service ]; then
    echo -e "${YELLOW}Creating systemd service...${NC}"
    sudo tee /etc/systemd/system/opdesk.service > /dev/null <<EOF
[Unit]
Description=OpDesk - IP PBX Management System
Documentation=https://github.com/Ibrahimgamal99/OpDesk
After=network.target mysqld.service mariadb.service
Wants=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_ROOT
Environment=HOME=$SERVICE_HOME
ExecStart=/bin/bash $PROJECT_ROOT/start.sh
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=opdesk

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable opdesk.service
    echo -e "${GREEN}OpDesk service installed and enabled to start on boot.${NC}"
else
    echo -e "${GREEN}systemd service already exists — skipping creation.${NC}"
    if ! systemctl is-enabled --quiet opdesk.service 2>/dev/null; then
        sudo systemctl enable opdesk.service
        echo -e "${GREEN}OpDesk service re-enabled.${NC}"
    fi
    if [ "$IS_UPDATE" == "true" ] && systemctl is-active --quiet opdesk.service 2>/dev/null; then
        echo -e "${YELLOW}Restarting OpDesk service to apply update...${NC}"
        sudo systemctl restart opdesk.service
        echo -e "${GREEN}OpDesk service restarted.${NC}"
    fi
fi

# ===============================================================
# FINAL SUMMARY REPORT
# ===============================================================
echo -e "\n${YELLOW}Step 10: Generating Installation Report...${NC}"

echo -e "${GREEN}==============================================================="
echo "                  OpDesk INSTALLATION REPORT"
echo -e "===============================================================${NC}"
echo -e "${BLUE}PROJECT DETAILS:${NC}"
echo -e "  Location:      $PROJECT_ROOT"
echo -e "  OS Detected:   $OS"
echo -e "  PBX Platform:  $PBX"
echo ""
echo -e "${BLUE}DATABASE DETAILS:${NC}"
echo -e "  Status:        $(([ -n "$DB_PASS" ] && mysqladmin -u$DB_USER -p"$DB_PASS" ping 2>/dev/null || mysqladmin -u$DB_USER ping 2>/dev/null) | grep -q "alive" && echo -e "${GREEN}Connected${NC}" || echo -e "${RED}Failed${NC}")"
echo -e "  Host/Port:     $DB_HOST:$DB_PORT"
echo -e "  Username:      $DB_USER$DB_EXISTING"
echo -e "  Password:      (saved to $PROJECT_ROOT/backend/.env)"
echo -e "  Database:      $DB_NAME"
echo ""
echo -e "${BLUE}ASTERISK AMI DETAILS:${NC}"
AMI_STATUS=$(lsof -i :$AMI_PORT > /dev/null && echo -e "${GREEN}Active${NC}" || echo -e "${RED}Inactive (Check Asterisk)${NC}")
echo -e "  Status:        $AMI_STATUS"
echo -e "  Host/Port:     $AMI_HOST:$AMI_PORT"
echo -e "  Username:      $AMI_USER$AMI_USER_EXISTING"
echo -e "  Secret:        (saved to $PROJECT_ROOT/backend/.env)"
echo ""
echo -e "${BLUE}RUNTIME VERSIONS:${NC}"
echo -e "  Node.js:       $(node -v)"
echo -e "  Python:        $(python --version)"
echo ""
echo -e "${BLUE}SYSTEMD SERVICE:${NC}"
echo -e "  Auto-start:    ${GREEN}Enabled${NC}"
echo -e "  Start:         ${YELLOW}sudo systemctl start opdesk${NC}"
echo -e "  Stop:          ${YELLOW}sudo systemctl stop opdesk${NC}"
echo -e "  Restart:       ${YELLOW}sudo systemctl restart opdesk${NC}"
echo -e "  Logs:          ${YELLOW}sudo journalctl -u opdesk -f${NC}"
echo ""
echo -e "${BLUE}ADMIN CREDENTIALS:${NC}"
echo -e "  Username:      admin"
if [ "$IS_UPDATE" != "true" ] && [ -n "$ADMIN_INIT_PASSWORD_HASH" ]; then
    echo -e "  Password:      (as entered during installation)"
else
    echo -e "  Password:      (unchanged)"
fi
echo ""
echo -e "${BLUE}COMMANDS:${NC}"
echo -e "  Run App:       ${YELLOW}./start.sh${NC}"
echo -e "  Config File:   ${YELLOW}cat $PROJECT_ROOT/backend/.env${NC}"
echo -e "==============================================================="
if [ "$IS_UPDATE" == "true" ]; then
    echo -e "Update finished. OpDesk has been restarted if it was already running."
    echo -e "Start / restart: ${GREEN}sudo systemctl restart opdesk${NC}\n"
else
    echo -e "Installation finished. OpDesk will start automatically on boot."
    echo -e "Start it now with: ${GREEN}sudo systemctl start opdesk${NC}\n"
fi
