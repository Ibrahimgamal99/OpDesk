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

# Download and install Node.js 24
echo ""
echo "Step 4: Installing Node.js 24..."
nvm install 24
nvm use 24
nvm alias default 24

# Install Python
echo ""
echo "Step 5: Installing Python..."
if command_exists python3; then
    PYTHON_VERSION=$(python3 --version)
    echo "Python is already installed: $PYTHON_VERSION"
else
    if command_exists apt-get; then
        sudo apt-get update
        sudo apt-get install -y python3 python3-pip
    elif command_exists yum; then
        sudo yum install -y python3 python3-pip
    else
        echo "Warning: Could not detect package manager. Please install Python3 manually."
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

# Check for Issabel or FreePBX
echo ""
echo "Step 6: Detecting Issabel/FreePBX installation..."
if [ -d /usr/share/issabel ]; then
    SYSTEM_TYPE="Issabel"
    CONFIG_FILE="/etc/issabel.conf"
elif [ -f /etc/freepbx.conf ]; then
    SYSTEM_TYPE="FreePBX"
    CONFIG_FILE="/etc/freepbx.conf"
else
    SYSTEM_TYPE="Unknown"
    CONFIG_FILE=""
fi

echo "Detected system: $SYSTEM_TYPE"

if [ "$SYSTEM_TYPE" == "Unknown" ]; then
    echo "Warning: Neither Issabel nor FreePBX detected. Skipping configuration."
    exit 0
fi

# Read existing config file
echo ""
echo "Step 7: Reading configuration from $CONFIG_FILE..."
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Configuration file $CONFIG_FILE not found!"
    exit 1
fi

cat "$CONFIG_FILE"

# Extract database configuration from config file
echo ""
echo "Step 8: Extracting database configuration from $CONFIG_FILE..."

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
    # Extract value from simple format: key=value
    grep "^${key}=" "$config_file" 2>/dev/null | cut -d'=' -f2- | head -1
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
    # Try to extract MySQL root password from issabel.conf
    MYSQL_ROOT_PWD=$(extract_simple_config "mysqlrootpwd" "$CONFIG_FILE")
    
    # Get database credentials from /etc/amportal.conf (uses simple key=value format)
    AMPORTAL_CONF="/etc/amportal.conf"
    if [ -f "$AMPORTAL_CONF" ]; then
        # Extract from amportal.conf which uses simple key=value format
        DB_USER=$(extract_simple_config "AMPDBUSER" "$AMPORTAL_CONF")
        DB_PASSWORD=$(extract_simple_config "AMPDBPASS" "$AMPORTAL_CONF")
        DB_HOST=$(extract_simple_config "AMPDBHOST" "$AMPORTAL_CONF")
        DB_PORT=$(extract_simple_config "AMPDBPORT" "$AMPORTAL_CONF")
        DB_NAME=$(extract_simple_config "AMPDBNAME" "$AMPORTAL_CONF")
    fi
    
    # Set defaults if extraction failed
    DB_HOST=${DB_HOST:-localhost}
    DB_PORT=${DB_PORT:-3306}
    DB_USER=${DB_USER:-root}
    DB_NAME=${DB_NAME:-asterisk}
    
    # If password not found, use mysqlrootpwd from issabel.conf
    if [ -z "$DB_PASSWORD" ] && [ -n "$MYSQL_ROOT_PWD" ]; then
        DB_PASSWORD="$MYSQL_ROOT_PWD"
        DB_USER="root"
    fi
    
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

# Add database configuration to config file
echo ""
echo "Step 10: Adding database configuration to $CONFIG_FILE..."

# Create backup of config file
sudo cp "$CONFIG_FILE" "${CONFIG_FILE}.backup.$(date +%Y%m%d_%H%M%S)"

# Function to update or add config variable
update_config_var() {
    local var_name=$1
    local var_value=$2
    local config_file=$3
    
    if sudo grep -q "^${var_name}=" "$config_file"; then
        # Update existing variable
        sudo sed -i "s|^${var_name}=.*|${var_name}=${var_value}|" "$config_file"
    else
        # Add new variable at the end
        echo "${var_name}=${var_value}" | sudo tee -a "$config_file" > /dev/null
    fi
}

# Update or add DB configuration variables
update_config_var "DB_HOST" "$DB_HOST" "$CONFIG_FILE"
update_config_var "DB_PORT" "$DB_PORT" "$CONFIG_FILE"
update_config_var "DB_USER" "$DB_USER" "$CONFIG_FILE"
update_config_var "DB_PASSWORD" "$DB_PASSWORD" "$CONFIG_FILE"
update_config_var "DB_NAME" "$DB_NAME" "$CONFIG_FILE"

# Update or add AMI configuration variables
update_config_var "AMI_HOST" "$AMI_HOST" "$CONFIG_FILE"
update_config_var "AMI_PORT" "$AMI_PORT" "$CONFIG_FILE"
update_config_var "AMI_USERNAME" "$AMI_USERNAME" "$CONFIG_FILE"
update_config_var "AMI_SECRET" "$AMI_SECRET" "$CONFIG_FILE"

echo "Database and AMI configuration added to $CONFIG_FILE"

# Add configuration to manager.conf
MANAGER_CONF="/etc/asterisk/manager.conf"
if [ ! -f "$MANAGER_CONF" ]; then
    echo ""
    echo "Warning: $MANAGER_CONF not found. Creating it..."
    sudo touch "$MANAGER_CONF"
fi

echo ""
echo "Step 11: Adding AMI configuration to $MANAGER_CONF..."

# Create backup
sudo cp "$MANAGER_CONF" "${MANAGER_CONF}.backup.$(date +%Y%m%d_%H%M%S)"

# Add configuration section if it doesn't exist
if ! sudo grep -q "^\[$AMI_USERNAME\]" "$MANAGER_CONF"; then
    echo "" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "[$AMI_USERNAME]" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "secret = $AMI_SECRET" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "deny = 0.0.0.0/0.0.0.0" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "permit = 127.0.0.1/255.255.255.255" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "read = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "write = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan" | sudo tee -a "$MANAGER_CONF" > /dev/null
    echo "AMI configuration added to $MANAGER_CONF"
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
echo "Step 12: Creating environment file at $ENV_FILE..."
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
echo "Step 13: Installing Python dependencies..."
cd "$BACKEND_DIR"
if [ -f "requirements.txt" ]; then
    # Use pip3 if available, otherwise use python3 -m pip
    if command_exists pip3; then
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
echo "Step 14: Installing Node.js dependencies..."
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
echo ""
echo "To start the application, run:"
echo "  ./start.sh"
echo ""
echo "Or manually:"
echo "  cd backend && python3 server.py"
echo "  cd frontend && npm run dev"

