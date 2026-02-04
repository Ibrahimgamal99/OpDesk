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
    elif [ "$OS" == "centos" ] || [ "$OS" == "rhel" ] || [ "$OS" == "rocky" ] || [ "$OS" == "fedora" ]; then
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

# Install Python
echo ""
echo "Step 5: Installing Python..."
PYTHON_NEEDS_UPGRADE=false
PYTHON313_PATH=""

if command_exists python3; then
    PYTHON_VERSION_STR=$(python3 --version 2>&1)
    echo "Python is already installed: $PYTHON_VERSION_STR"
    
    # Extract version number (e.g., "Python 3.10.5" -> "3.10")
    PYTHON_VERSION=$(echo "$PYTHON_VERSION_STR" | grep -oE '[0-9]+\.[0-9]+' | head -1)
    
    # Compare version to 3.11 (minimum required version)
    if [ -n "$PYTHON_VERSION" ]; then
        # Properly compare version numbers by splitting major.minor
        PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
        PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)
        REQUIRED_MAJOR=3
        REQUIRED_MINOR=11
        
        # Compare major version first, then minor
        if [ "$PYTHON_MAJOR" -lt "$REQUIRED_MAJOR" ] || ([ "$PYTHON_MAJOR" -eq "$REQUIRED_MAJOR" ] && [ "$PYTHON_MINOR" -lt "$REQUIRED_MINOR" ]); then
            echo "Python version $PYTHON_VERSION is less than 3.11. Will install Python 3.11 or newer..."
            PYTHON_NEEDS_UPGRADE=true
        else
            echo "Python version $PYTHON_VERSION is >= 3.11. No upgrade needed."
        fi
    else
        echo "Warning: Could not parse Python version. Will attempt to install a newer Python version..."
        PYTHON_NEEDS_UPGRADE=true
    fi
else
    echo "Python3 not found. Will install Python..."
    PYTHON_NEEDS_UPGRADE=true
fi

# Install newer Python version if needed
if [ "$PYTHON_NEEDS_UPGRADE" == "true" ]; then
    PYTHON_INSTALLED=false
    PYTHON_NEW_PATH=""
    
    if [ "$OS" == "debian" ] || [ "$OS" == "ubuntu" ]; then
        # For Debian/Ubuntu, use deadsnakes PPA
        echo "Adding deadsnakes PPA for Python..."
        sudo apt-get update
        sudo apt-get install -y software-properties-common
        sudo add-apt-repository -y ppa:deadsnakes/ppa
        sudo apt-get update
        
        # Try Python versions in order: 3.13, 3.12, 3.11 (minimum required: 3.11)
        for PYTHON_VER in "3.13" "3.12" "3.11"; do
            echo "Attempting to install Python $PYTHON_VER..."
            if sudo apt-get install -y python${PYTHON_VER} python${PYTHON_VER}-venv python${PYTHON_VER}-dev 2>/dev/null; then
                PYTHON_NEW_PATH=$(which python${PYTHON_VER} 2>/dev/null || command -v python${PYTHON_VER})
                if [ -n "$PYTHON_NEW_PATH" ]; then
                    PYTHON_INSTALLED=true
                    PYTHON313_PATH="$PYTHON_NEW_PATH"
                    echo "Python $PYTHON_VER installed successfully at: $PYTHON_NEW_PATH"
                    # Install pip
                    sudo apt-get install -y python${PYTHON_VER}-pip 2>/dev/null || python${PYTHON_VER} -m ensurepip --upgrade 2>/dev/null || true
                    break
                fi
            fi
        done
        
    elif [ "$OS" == "centos" ] || [ "$OS" == "rhel" ] || [ "$OS" == "rocky" ] || [ "$OS" == "fedora" ]; then
        # For Fedora/RHEL/CentOS/Rocky Linux
        if command_exists dnf; then
            # Enable EPEL for additional packages (especially for RHEL/Rocky Linux)
            if [ "$OS" == "centos" ] || [ "$OS" == "rhel" ] || [ "$OS" == "rocky" ]; then
                echo "Enabling EPEL repository..."
                sudo dnf install -y epel-release 2>/dev/null || true
            fi
            
            # Try Python versions in order: 3.13, 3.12, 3.11 (minimum required: 3.11)
            # Note: RHEL 8/Rocky 8 may need EPEL or additional repositories for Python 3.11+
            for PYTHON_VER in "3.13" "3.12" "3.11"; do
                echo "Attempting to install Python $PYTHON_VER..."
                if sudo dnf install -y python${PYTHON_VER} python${PYTHON_VER}-pip python${PYTHON_VER}-devel 2>/dev/null; then
                    PYTHON_NEW_PATH=$(which python${PYTHON_VER} 2>/dev/null || command -v python${PYTHON_VER})
                    if [ -n "$PYTHON_NEW_PATH" ]; then
                        PYTHON_INSTALLED=true
                        PYTHON313_PATH="$PYTHON_NEW_PATH"
                        echo "Python $PYTHON_VER installed successfully at: $PYTHON_NEW_PATH"
                        break
                    fi
                fi
            done
            
            # If still not installed, try enabling Python 3.11 module stream (for RHEL 8/Rocky 8)
            if [ "$PYTHON_INSTALLED" == "false" ] && ([ "$OS" == "centos" ] || [ "$OS" == "rhel" ] || [ "$OS" == "rocky" ]); then
                echo "Trying to enable Python 3.11 module stream (if available on RHEL 8/Rocky 8)..."
                if sudo dnf module reset -y python36 2>/dev/null && sudo dnf module enable -y python311 2>/dev/null && sudo dnf install -y python3.11 python3.11-pip python3.11-devel 2>/dev/null; then
                    PYTHON_NEW_PATH=$(which python3.11 2>/dev/null || command -v python3.11)
                    if [ -n "$PYTHON_NEW_PATH" ]; then
                        PYTHON_INSTALLED=true
                        PYTHON313_PATH="$PYTHON_NEW_PATH"
                        echo "Python 3.11 installed successfully at: $PYTHON_NEW_PATH"
                    fi
                fi
            fi
        else
            # For older CentOS/RHEL with yum
            echo "Installing build dependencies..."
            sudo yum groupinstall -y "Development Tools" 2>/dev/null || true
            sudo yum install -y openssl-devel bzip2-devel libffi-devel zlib-devel readline-devel sqlite-devel 2>/dev/null || true
            
            # Try Python 3.11+ versions (minimum required: 3.11)
            for PYTHON_VER in "3.13" "3.12" "3.11"; do
                echo "Attempting to install Python $PYTHON_VER..."
                if sudo yum install -y python${PYTHON_VER} python${PYTHON_VER}-pip python${PYTHON_VER}-devel 2>/dev/null; then
                    PYTHON_NEW_PATH=$(which python${PYTHON_VER} 2>/dev/null || command -v python${PYTHON_VER})
                    if [ -n "$PYTHON_NEW_PATH" ]; then
                        PYTHON_INSTALLED=true
                        PYTHON313_PATH="$PYTHON_NEW_PATH"
                        echo "Python $PYTHON_VER installed successfully at: $PYTHON_NEW_PATH"
                        break
                    fi
                fi
            done
        fi
        
    elif [ "$OS" == "arch" ]; then
        # For Arch Linux, try versions in order (minimum required: 3.11)
        for PYTHON_VER in "313" "312" "311"; do
            echo "Attempting to install Python $PYTHON_VER..."
            if sudo pacman -S --noconfirm python${PYTHON_VER} 2>/dev/null; then
                PYTHON_NEW_PATH=$(which python${PYTHON_VER} 2>/dev/null || command -v python${PYTHON_VER})
                if [ -n "$PYTHON_NEW_PATH" ]; then
                    PYTHON_INSTALLED=true
                    PYTHON313_PATH="$PYTHON_NEW_PATH"
                    echo "Python $PYTHON_VER installed successfully at: $PYTHON_NEW_PATH"
                    break
                fi
            fi
        done
    else
        echo "Warning: Unknown OS. Please install Python 3.11+ manually."
        exit 1
    fi
    
    if [ "$PYTHON_INSTALLED" == "false" ]; then
        echo "Error: Could not install a compatible Python version (3.11+)."
        echo "Please install Python 3.11 or newer manually."
        exit 1
    fi
fi

# Determine which Python to use for symlink
if [ -n "$PYTHON313_PATH" ]; then
    FINAL_PYTHON_PATH="$PYTHON313_PATH"
    FINAL_PYTHON_VERSION=$(basename "$PYTHON313_PATH" | grep -oE '[0-9]+\.[0-9]+' | head -1 || echo "3.x")
elif command_exists python3.13; then
    FINAL_PYTHON_PATH=$(which python3.13 2>/dev/null || command -v python3.13)
    FINAL_PYTHON_VERSION="3.13"
elif command_exists python3.12; then
    FINAL_PYTHON_PATH=$(which python3.12 2>/dev/null || command -v python3.12)
    FINAL_PYTHON_VERSION="3.12"
elif command_exists python3.11; then
    FINAL_PYTHON_PATH=$(which python3.11 2>/dev/null || command -v python3.11)
    FINAL_PYTHON_VERSION="3.11"
elif command_exists python3; then
    FINAL_PYTHON_PATH=$(which python3 2>/dev/null || command -v python3)
    FINAL_PYTHON_VERSION=$(python3 --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
    # Verify version is >= 3.11 (proper numeric comparison)
    PYTHON_MAJOR=$(echo "$FINAL_PYTHON_VERSION" | cut -d. -f1)
    PYTHON_MINOR=$(echo "$FINAL_PYTHON_VERSION" | cut -d. -f2)
    REQUIRED_MAJOR=3
    REQUIRED_MINOR=11
    if [ "$PYTHON_MAJOR" -lt "$REQUIRED_MAJOR" ] || ([ "$PYTHON_MAJOR" -eq "$REQUIRED_MAJOR" ] && [ "$PYTHON_MINOR" -lt "$REQUIRED_MINOR" ]); then
        echo "Error: Python $FINAL_PYTHON_VERSION is installed but version 3.11+ is required."
        exit 1
    fi
else
    echo "Error: No Python installation found."
    exit 1
fi

# Create system-wide symlink for 'python' command (not 'python3')
echo "Creating system-wide symlink: /usr/local/bin/python -> $FINAL_PYTHON_PATH"
sudo ln -sf "$FINAL_PYTHON_PATH" /usr/local/bin/python
echo "✓ 'python' command now available (points to $FINAL_PYTHON_VERSION)"

# Verify pip is available and create symlink
PIP_COMMAND=""
# Try to find pip for the selected Python version
if [ -n "$PYTHON313_PATH" ]; then
    PYTHON_BASE=$(basename "$PYTHON313_PATH")
    if $PYTHON313_PATH -m pip --version >/dev/null 2>&1; then
        PIP_COMMAND="$PYTHON313_PATH -m pip"
        PIP_PATH="$FINAL_PYTHON_PATH -m pip"
    elif command_exists pip${PYTHON_BASE#python}; then
        PIP_PATH=$(which pip${PYTHON_BASE#python} 2>/dev/null || command -v pip${PYTHON_BASE#python})
    fi
fi

# Fallback: try common pip versions (matching Python 3.11+ requirement)
if [ -z "$PIP_PATH" ]; then
    for PIP_VER in "pip3.13" "pip3.12" "pip3.11" "pip3"; do
        if command_exists $PIP_VER; then
            PIP_PATH=$(which $PIP_VER 2>/dev/null || command -v $PIP_VER)
            break
        fi
    done
fi

if [ -n "$PIP_PATH" ]; then
    # Extract just the pip executable path if it's a full command
    if [[ "$PIP_PATH" == *"-m pip"* ]]; then
        # For python3.13 -m pip, we'll create a wrapper or use the python symlink
        echo "Creating system-wide symlink: /usr/local/bin/pip -> $FINAL_PYTHON_PATH (using -m pip)"
        # Create a wrapper script for pip
        sudo tee /usr/local/bin/pip > /dev/null << 'PIP_WRAPPER'
#!/bin/bash
exec python -m pip "$@"
PIP_WRAPPER
        sudo chmod +x /usr/local/bin/pip
        echo "✓ 'pip' command now available (wrapper for python -m pip)"
    else
        echo "Creating system-wide symlink: /usr/local/bin/pip -> $PIP_PATH"
        sudo ln -sf "$PIP_PATH" /usr/local/bin/pip
        echo "✓ 'pip' command now available (points to pip3.13 or pip3)"
    fi
else
    echo "Note: pip command not available. Will use 'python -m pip' instead."
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

