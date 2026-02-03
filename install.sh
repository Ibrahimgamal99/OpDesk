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

# Install git and wget based on OS
if command_exists git && command_exists wget; then
    echo "git and wget are already installed."
else
    if [ "$OS" == "debian" ] || [ "$OS" == "ubuntu" ]; then
        echo "Installing git and wget using apt-get..."
        sudo apt-get update
        sudo apt-get install -y git wget curl
    elif [ "$OS" == "centos" ] || [ "$OS" == "rhel" ] || [ "$OS" == "fedora" ]; then
        echo "Installing git and wget using yum/dnf..."
        if command_exists dnf; then
            sudo dnf install -y git wget curl
        else
            sudo yum install -y git wget curl
        fi
    elif [ "$OS" == "arch" ]; then
        echo "Installing git and wget using pacman..."
        sudo pacman -S --noconfirm git wget curl
    else
        echo "Warning: Unknown OS. Please install git and wget manually."
        exit 1
    fi
fi

# Clone repository if not already in AOP directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="https://github.com/Ibrahimgamal99/AOP.git"

if [ -d "$SCRIPT_DIR/.git" ]; then
    echo "Already in AOP repository directory: $SCRIPT_DIR"
    cd "$SCRIPT_DIR"
    PROJECT_ROOT="$SCRIPT_DIR"
else
    echo ""
    echo "Step 2: Cloning AOP repository..."
    CLONE_DIR="$HOME/AOP"
    if [ -d "$CLONE_DIR" ]; then
        echo "Directory $CLONE_DIR already exists. Updating repository..."
        cd "$CLONE_DIR"
        git pull || echo "Warning: Could not update repository. Continuing with existing code..."
    else
        echo "Cloning repository to $CLONE_DIR..."
        git clone "$REPO_URL" "$CLONE_DIR"
        cd "$CLONE_DIR"
    fi
    PROJECT_ROOT="$CLONE_DIR"
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

# Prompt for database configuration
echo ""
echo "Step 8: Database Configuration"
echo "Please enter database details:"
read -p "DB_HOST [default: localhost]: " DB_HOST
DB_HOST=${DB_HOST:-localhost}

read -p "DB_PORT [default: 3306]: " DB_PORT
DB_PORT=${DB_PORT:-3306}

read -p "DB_USER: " DB_USER
read -s -p "DB_PASSWORD: " DB_PASSWORD
echo ""
read -p "DB_NAME: " DB_NAME

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
    pip3 install --break-system-packages -r requirements.txt
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

