#!/bin/bash

set -e  # Exit on error

echo "=== Installation Script ==="
echo ""

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Detect OS and package manager
echo "Step 1: Detecting OS and installing prerequisites..."
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    echo "Detected OS: $OS"
else
    echo "Warning: Could not detect OS. Assuming Debian/Ubuntu."
    OS="debian"
fi

# Install git, wget and curl based on OS
if command_exists git && command_exists wget && command_exists curl; then
    echo "git, wget and curl are already installed."
else
    if [ "$OS" == "debian" ] || [ "$OS" == "ubuntu" ]; then
        echo "Installing git, wget and curl using apt-get..."
        sudo apt-get update
        sudo apt-get install -y git wget curl
    elif [ "$OS" == "centos" ] || [ "$OS" == "rhel" ] || [ "$OS" == "fedora" ]; then
        echo "Installing git, wget and curl using yum/dnf..."
        if command_exists dnf; then
            sudo dnf install -y git wget curl
        else
            sudo yum install -y git wget curl
        fi
    elif [ "$OS" == "arch" ]; then
        echo "Installing git, wget and curl using pacman..."
        sudo pacman -S --noconfirm git wget curl
    else
        echo "Warning: Unknown OS. Please install git, wget and curl manually."
        exit 1
    fi
fi

# Clone repository to /opt/AOP
echo ""
echo "Step 2: Cloning AOP repository..."
PROJECT_ROOT="/opt/AOP"
REPO_URL="https://github.com/Ibrahimgamal99/AOP.git"

if [ -d "$PROJECT_ROOT/.git" ]; then
    echo "Repository already exists at $PROJECT_ROOT. Updating..."
    cd "$PROJECT_ROOT"
    git pull || echo "Warning: Could not update repository. Continuing with existing code..."
else
    if [ -d "$PROJECT_ROOT" ]; then
        echo "Directory $PROJECT_ROOT exists but is not a git repository."
        echo "Removing existing directory..."
        sudo rm -rf "$PROJECT_ROOT"
    fi
    echo "Cloning repository to $PROJECT_ROOT..."
    sudo mkdir -p "$(dirname "$PROJECT_ROOT")"
    sudo git clone "$REPO_URL" "$PROJECT_ROOT"
    sudo chown -R "$USER:$USER" "$PROJECT_ROOT"
    cd "$PROJECT_ROOT"
fi

# Download and install nvm
echo ""
echo "Step 3: Installing nvm..."
if [ -d "$HOME/.nvm" ]; then
    echo "nvm is already installed, skipping..."
else
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi

# Source nvm in current shell
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Add nvm initialization to shell profile if not already present
SHELL_PROFILE=""
if [ -f "$HOME/.bashrc" ]; then
    SHELL_PROFILE="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
    SHELL_PROFILE="$HOME/.bash_profile"
elif [ -f "$HOME/.profile" ]; then
    SHELL_PROFILE="$HOME/.profile"
fi

if [ -n "$SHELL_PROFILE" ]; then
    if ! grep -q "NVM_DIR" "$SHELL_PROFILE"; then
        echo ""
        echo "Adding nvm initialization to $SHELL_PROFILE..."
        cat >> "$SHELL_PROFILE" << 'NVM_INIT'
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
NVM_INIT
        echo "nvm initialization added to $SHELL_PROFILE"
        echo "Note: You may need to run 'source $SHELL_PROFILE' or open a new terminal for npm to be available."
    else
        echo "nvm initialization already present in $SHELL_PROFILE"
    fi
fi

# Download and install Node.js 24
echo ""
echo "Step 4: Installing Node.js 24..."
nvm install 24
nvm use 24
nvm alias default 24

# Function to compare version numbers
version_lt() {
    # Compare two version strings (e.g., "3.10.5" < "3.11.0")
    local version1=$1
    local version2=$2
    local IFS=.
    local i ver1=($version1) ver2=($version2)
    for ((i=0; i<${#ver1[@]}; i++)); do
        if [[ -z ${ver2[i]} ]]; then
            ver2[i]=0
        fi
        if ((10#${ver1[i]} < 10#${ver2[i]})); then
            return 0
        fi
        if ((10#${ver1[i]} > 10#${ver2[i]})); then
            return 1
        fi
    done
    return 1
}

# Install Python
echo ""
echo "Step 5: Installing Python..."
PYTHON_NEEDS_UPGRADE=false
PYTHON_VERSION_STR=""
PYTHON_VERSION_NUM=""

if command_exists python3; then
    PYTHON_VERSION_STR=$(python3 --version 2>&1)
    # Extract version number (e.g., "3.10.5" from "Python 3.10.5")
    PYTHON_VERSION_NUM=$(echo "$PYTHON_VERSION_STR" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)
    echo "Python is already installed: $PYTHON_VERSION_STR"
    
    # Check if version is less than 3.11
    if version_lt "$PYTHON_VERSION_NUM" "3.11"; then
        echo "Python version $PYTHON_VERSION_NUM is less than 3.11. Installing latest Python version..."
        PYTHON_NEEDS_UPGRADE=true
    else
        echo "Python version $PYTHON_VERSION_NUM meets requirement (>= 3.11)"
    fi
else
    echo "Python3 not found. Installing latest Python version..."
    PYTHON_NEEDS_UPGRADE=true
fi

# Install or upgrade Python if needed
if [ "$PYTHON_NEEDS_UPGRADE" = true ]; then
    if command_exists apt-get; then
        # For Debian/Ubuntu, try to install latest Python from deadsnakes PPA
        echo "Installing latest Python from deadsnakes PPA..."
        sudo apt-get update
        sudo apt-get install -y software-properties-common
        sudo add-apt-repository -y ppa:deadsnakes/ppa 2>/dev/null || echo "PPA may already be added or unavailable"
        sudo apt-get update
        # Install latest available Python 3.x
        sudo apt-get install -y python3 python3-pip python3-venv python3-dev || {
            echo "Warning: Could not install from PPA. Trying default repository..."
            sudo apt-get install -y python3 python3-pip
        }
    elif command_exists dnf; then
        # For Fedora/RHEL 8+, use dnf
        echo "Installing latest Python using dnf..."
        sudo dnf install -y python3 python3-pip python3-devel
    elif command_exists yum; then
        # For CentOS/RHEL 7, use yum
        echo "Installing latest Python using yum..."
        sudo yum install -y python3 python3-pip python3-devel
    elif command_exists pacman; then
        # For Arch Linux
        echo "Installing latest Python using pacman..."
        sudo pacman -S --noconfirm python python-pip
    else
        echo "Warning: Could not detect package manager. Please install Python3 >= 3.11 manually."
        exit 1
    fi
    
    # Verify new installation
    if command_exists python3; then
        PYTHON_VERSION_STR=$(python3 --version 2>&1)
        PYTHON_VERSION_NUM=$(echo "$PYTHON_VERSION_STR" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)
        echo "Installed Python: $PYTHON_VERSION_STR"
    else
        echo "Error: Python3 installation failed!"
        exit 1
    fi
fi

# Verify pip3 is available, if not try to install it or use python3 -m pip
if ! command_exists pip3; then
    echo "pip3 command not found. Attempting to install pip3..."
    if command_exists apt-get; then
        sudo apt-get update
        sudo apt-get install -y python3-pip
    elif command_exists yum; then
        sudo yum install -y python3-pip
    elif command_exists dnf; then
        sudo dnf install -y python3-pip
    fi
    
    # If still not found, we'll use python3 -m pip as fallback
    if ! command_exists pip3; then
        echo "Note: pip3 command not available. Will use 'python3 -m pip' instead."
    fi
fi

# Create system-wide symlinks for 'python' and 'pip' commands
if command_exists python3; then
    PYTHON3_PATH=$(which python3 2>/dev/null || command -v python3)
    
    # Always update/create 'python' symlink to point to the latest python3
    if [ -n "$PYTHON3_PATH" ]; then
        echo "Creating/updating system-wide symlink: /usr/local/bin/python -> $PYTHON3_PATH"
        sudo ln -sf "$PYTHON3_PATH" /usr/local/bin/python
        echo "✓ 'python' command now available (symlinked to $PYTHON3_PATH)"
    else
        echo "Warning: Could not find python3 binary path"
    fi
    
    # Create 'pip' symlink if pip3 exists
    if command_exists pip3; then
        PIP3_PATH=$(which pip3 2>/dev/null || command -v pip3)
        if [ -n "$PIP3_PATH" ]; then
            echo "Creating/updating system-wide symlink: /usr/local/bin/pip -> $PIP3_PATH"
            sudo ln -sf "$PIP3_PATH" /usr/local/bin/pip
            echo "✓ 'pip' command now available (symlinked to $PIP3_PATH)"
        fi
    fi
fi

# Check for Issabel or FreePBX
echo ""
echo "Step 6: Detecting Issabel/FreePBX installation..."
if [ -d /usr/share/issabel ]; then
    SYSTEM_TYPE="Issabel"
    CONFIG_FILE="/etc/amportal.conf"
    BACKUP_CONFIG_FILE="/etc/issabel.conf"
elif [ -f /etc/freepbx.conf ]; then
    SYSTEM_TYPE="FreePBX"
    CONFIG_FILE="/etc/freepbx.conf"
    BACKUP_CONFIG_FILE=""
else
    SYSTEM_TYPE="Unknown"
    CONFIG_FILE=""
    BACKUP_CONFIG_FILE=""
fi

echo "Detected system: $SYSTEM_TYPE"

if [ "$SYSTEM_TYPE" == "Unknown" ]; then
    echo "Warning: Neither Issabel nor FreePBX detected. Skipping configuration."
    exit 0
fi

# Read existing config file (read-only, no modifications)
if [ "$SYSTEM_TYPE" != "Issabel" ]; then
    echo ""
    echo "Step 7: Reading configuration from $CONFIG_FILE (read-only)..."
fi
if [ ! -f "$CONFIG_FILE" ]; then
    if [ -n "$BACKUP_CONFIG_FILE" ] && [ -f "$BACKUP_CONFIG_FILE" ]; then
        if [ "$SYSTEM_TYPE" != "Issabel" ]; then
            echo "Primary config file $CONFIG_FILE not found. Using backup: $BACKUP_CONFIG_FILE"
        fi
        CONFIG_FILE="$BACKUP_CONFIG_FILE"
        BACKUP_CONFIG_FILE=""
    else
        echo "Error: Configuration file $CONFIG_FILE not found!"
        if [ -n "$BACKUP_CONFIG_FILE" ]; then
            echo "Backup file $BACKUP_CONFIG_FILE also not found!"
        fi
        exit 1
    fi
fi

# Skip printing config file - only read database configuration silently

# Extract database configuration from config file (read-only)
if [ "$SYSTEM_TYPE" != "Issabel" ]; then
    echo ""
    echo "Step 8: Extracting database configuration from $CONFIG_FILE (read-only)..."
fi

# Function to extract PHP config value (for FreePBX)
extract_php_config() {
    local key=$1
    local config_file=$2
    # Extract value from PHP array format: $amp_conf["KEY"] = "value"; or $amp_conf['KEY'] = 'value';
    # First find the line, then extract the value between quotes (handles both single and double quotes)
    local result=""
    # Try double quotes first
    result=$(grep "\$amp_conf\[\"${key}\"\]" "$config_file" 2>/dev/null | sed -n "s/.*= *\"\([^\"]*\)\".*/\1/p" | head -1)
    # If not found, try single quotes
    if [ -z "$result" ]; then
        result=$(grep "\$amp_conf\['${key}'\]" "$config_file" 2>/dev/null | sed -n "s/.*= *'\([^']*\)'.*/\1/p" | head -1)
    fi
    echo "$result"
}

# Function to extract simple key=value config (for Issabel)
extract_simple_config() {
    local key=$1
    local config_file=$2
    # Extract value from simple format: key=value (handles whitespace around =)
    # Matches: key=value, key = value, key= value, key =value
    grep "^[[:space:]]*${key}[[:space:]]*=" "$config_file" 2>/dev/null | sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)/\1/p" | head -1 | sed 's/[[:space:]]*$//'
}

if [ "$SYSTEM_TYPE" == "FreePBX" ]; then
    # Extract from FreePBX config format: $amp_conf["AMPDBUSER"] = "value";
    DB_USER=$(extract_php_config "AMPDBUSER" "$CONFIG_FILE")
    DB_PASSWORD=$(extract_php_config "AMPDBPASS" "$CONFIG_FILE")
    DB_HOST=$(extract_php_config "AMPDBHOST" "$CONFIG_FILE")
    DB_PORT=$(extract_php_config "AMPDBPORT" "$CONFIG_FILE")
    DB_NAME=$(extract_php_config "AMPDBNAME" "$CONFIG_FILE")
    
    # Set defaults if extraction failed
    DB_HOST=${DB_HOST:-localhost}
    DB_PORT=${DB_PORT:-3306}
    
    echo "Extracted database configuration:"
    echo "  DB_HOST: $DB_HOST"
    echo "  DB_PORT: $DB_PORT"
    echo "  DB_USER: $DB_USER"
    echo "  DB_PASSWORD: $DB_PASSWORD"
    echo "  DB_NAME: $DB_NAME"
    
    if [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
        echo "Warning: Could not extract all database credentials. Please enter manually:"
        [ -z "$DB_USER" ] && read -p "DB_USER: " DB_USER
        [ -z "$DB_PASSWORD" ] && read -s -p "DB_PASSWORD: " DB_PASSWORD && echo ""
        [ -z "$DB_NAME" ] && read -p "DB_NAME: " DB_NAME
    fi
elif [ "$SYSTEM_TYPE" == "Issabel" ]; then
    # Extract from Issabel config format: key=value (simple format)
    # Primary config is /etc/amportal.conf, backup is /etc/issabel.conf
    BACKUP_CONFIG="/etc/issabel.conf"
    
    # Extract database credentials from primary config file
    DB_USER=$(extract_simple_config "AMPDBUSER" "$CONFIG_FILE")
    DB_PASSWORD=$(extract_simple_config "AMPDBPASS" "$CONFIG_FILE")
    DB_HOST=$(extract_simple_config "AMPDBHOST" "$CONFIG_FILE")
    DB_PORT=$(extract_simple_config "AMPDBPORT" "$CONFIG_FILE")
    DB_NAME=$(extract_simple_config "AMPDBNAME" "$CONFIG_FILE")
    
    # If values are missing and backup config exists, try extracting from backup
    if [ -f "$BACKUP_CONFIG" ]; then
        if [ -z "$DB_USER" ]; then
            DB_USER=$(extract_simple_config "AMPDBUSER" "$BACKUP_CONFIG")
        fi
        if [ -z "$DB_PASSWORD" ]; then
            DB_PASSWORD=$(extract_simple_config "AMPDBPASS" "$BACKUP_CONFIG")
        fi
        if [ -z "$DB_HOST" ]; then
            DB_HOST=$(extract_simple_config "AMPDBHOST" "$BACKUP_CONFIG")
        fi
        if [ -z "$DB_PORT" ]; then
            DB_PORT=$(extract_simple_config "AMPDBPORT" "$BACKUP_CONFIG")
        fi
        if [ -z "$DB_NAME" ]; then
            DB_NAME=$(extract_simple_config "AMPDBNAME" "$BACKUP_CONFIG")
        fi
        
        # Try to extract MySQL root password from backup config if password still not found
        if [ -z "$DB_PASSWORD" ]; then
            MYSQL_ROOT_PWD=$(extract_simple_config "mysqlrootpwd" "$BACKUP_CONFIG")
            if [ -n "$MYSQL_ROOT_PWD" ]; then
                DB_PASSWORD="$MYSQL_ROOT_PWD"
                DB_USER="root"
            fi
        fi
    fi
    
    # Set defaults if extraction failed
    DB_HOST=${DB_HOST:-localhost}
    DB_PORT=${DB_PORT:-3306}
    DB_USER=${DB_USER:-root}
    DB_NAME=${DB_NAME:-asterisk}
    
    echo "Extracted database configuration:"
    echo "  DB_HOST: $DB_HOST"
    echo "  DB_PORT: $DB_PORT"
    echo "  DB_USER: $DB_USER"
    echo "  DB_PASSWORD: $DB_PASSWORD"
    echo "  DB_NAME: $DB_NAME"
    
    if [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
        echo "Warning: Could not extract all database credentials. Please enter manually:"
        [ -z "$DB_USER" ] && read -p "DB_USER [default: root]: " DB_USER
        DB_USER=${DB_USER:-root}
        [ -z "$DB_PASSWORD" ] && read -s -p "DB_PASSWORD: " DB_PASSWORD && echo ""
        [ -z "$DB_NAME" ] && read -p "DB_NAME [default: asterisk]: " DB_NAME
        DB_NAME=${DB_NAME:-asterisk}
    fi
fi

# Prompt for AMI configuration
echo ""
echo "Step 9: AMI Configuration"
read -p "AMI_HOST [default: localhost]: " AMI_HOST
AMI_HOST=${AMI_HOST:-localhost}

read -p "AMI_PORT [default: 5038]: " AMI_PORT
AMI_PORT=${AMI_PORT:-5038}

read -p "AMI_SECRET: " AMI_SECRET

AMI_USERNAME="AOP"

# Add configuration to manager.conf
MANAGER_CONF="/etc/asterisk/manager.conf"
if [ ! -f "$MANAGER_CONF" ]; then
    echo ""
    echo "Warning: $MANAGER_CONF not found. Creating it..."
    sudo touch "$MANAGER_CONF"
fi

echo ""
echo "Step 10: Adding AMI configuration to $MANAGER_CONF (writing)..."

# Create backup
sudo cp "$MANAGER_CONF" "${MANAGER_CONF}.backup.$(date +%Y%m%d_%H%M%S)"

# Add configuration section if it doesn't exist
if ! sudo grep -q "^\[$AMI_USERNAME\]" "$MANAGER_CONF"; then
    echo "" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "[$AMI_USERNAME]" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "secret = $AMI_SECRET" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "deny = 0.0.0.0/0.0.0.0" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "permit = 127.0.0.1/255.255.255.255" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "read = all" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "write = all" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "AMI configuration added to $MANAGER_CONF"
    
    # Reload Asterisk manager module to apply changes
    echo "Reloading Asterisk manager module..."
    if command_exists asterisk; then
        sudo asterisk -rx "manager reload" 2>/dev/null || echo "Warning: Could not reload Asterisk manager module. Please reload manually."
    else
        # Try common paths
        if [ -f /usr/sbin/asterisk ]; then
            sudo /usr/sbin/asterisk -rx "manager reload" 2>/dev/null || echo "Warning: Could not reload Asterisk manager module. Please reload manually."
        else
            echo "Warning: Asterisk command not found. Please reload Asterisk manually: asterisk -rx 'manager reload'"
        fi
    fi
else
    echo "AMI user $AMI_USERNAME already exists in $MANAGER_CONF"
fi

# Create environment file in Backend folder
BACKEND_DIR="$PROJECT_ROOT/backend"
ENV_FILE="$BACKEND_DIR/.env"

# Ensure backend directory exists
if [ ! -d "$BACKEND_DIR" ]; then
    echo "Creating backend directory..."
    mkdir -p "$BACKEND_DIR"
fi

echo ""
echo "Step 11: Creating environment file at $ENV_FILE..."
cat > "$ENV_FILE" << EOF
# Database Configuration
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME

# AMI Configuration
AMI_HOST=$AMI_HOST
AMI_PORT=$AMI_PORT
AMI_USERNAME=$AMI_USERNAME
AMI_SECRET=$AMI_SECRET
EOF

echo "Configuration saved to $ENV_FILE"

# Install Python dependencies
echo ""
echo "Step 12: Installing Python dependencies..."
cd "$BACKEND_DIR"
if [ -f "requirements.txt" ]; then
    # Use pip if available (symlink), otherwise pip3, otherwise python3 -m pip
    if command_exists pip; then
        pip install --break-system-packages -r requirements.txt
    elif command_exists pip3; then
        pip3 install --break-system-packages -r requirements.txt
    else
        python3 -m pip install --break-system-packages -r requirements.txt
    fi
    echo "Python dependencies installed successfully"
else
    echo "Warning: requirements.txt not found in backend directory"
fi

# Install Node.js dependencies
echo ""
echo "Step 13: Installing Node.js dependencies..."
FRONTEND_DIR="$PROJECT_ROOT/frontend"
if [ -d "$FRONTEND_DIR" ]; then
    cd "$FRONTEND_DIR"
    if [ -f "package.json" ]; then
        npm install
        echo "Node.js dependencies installed successfully"
    else
        echo "Warning: package.json not found in frontend directory"
    fi
else
    echo "Warning: frontend directory not found"
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Environment variables are configured in: $ENV_FILE"
if [ -f /usr/local/bin/python ]; then
    echo ""
    echo "✓ 'python' command is now available (symlinked to python3)"
    if [ -f /usr/local/bin/pip ]; then
        echo "✓ 'pip' command is now available (symlinked to pip3)"
    fi
fi
echo ""
echo "To start the application, run:"
echo "  ./start.sh"
echo ""
echo "Or manually:"
if [ -f /usr/local/bin/python ]; then
    echo "  cd backend && python server.py"
else
    echo "  cd backend && python3 server.py"
fi
echo "  cd frontend && npm run dev"

