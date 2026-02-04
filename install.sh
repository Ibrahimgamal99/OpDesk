#!/bin/bash

set -euo pipefail  # Exit on error, undefined variables, and pipe failures

# Color codes for better output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Create log file
LOG_FILE="/tmp/aop_install_$(date +%Y%m%d_%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== AOP Installation Script ==="
echo "Log file: $LOG_FILE"
echo ""

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check if running as root
check_root() {
    if [ "$EUID" -eq 0 ]; then
        log_error "This script should NOT be run as root. Please run as a regular user with sudo privileges."
        exit 1
    fi
}

# Function to verify sudo access
verify_sudo() {
    if ! sudo -n true 2>/dev/null; then
        log_info "This script requires sudo privileges. You may be prompted for your password."
        sudo -v || {
            log_error "Failed to obtain sudo privileges. Exiting."
            exit 1
        }
    fi
}

# ============================================================================
# STEP 1: Detect OS and Install Prerequisites
# ============================================================================
detect_os_and_install_prerequisites() {
    log_info "Step 1: Detecting OS and installing prerequisites..."
    
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
        OS_VERSION=$VERSION_ID
        log_info "Detected OS: $OS $OS_VERSION"
    else
        log_warning "Could not detect OS. Assuming Debian/Ubuntu."
        OS="debian"
    fi

    # Install git, wget, curl, and build essentials
    local packages="git wget curl"
    
    if command_exists git && command_exists wget && command_exists curl; then
        log_success "git, wget, and curl are already installed."
    else
        log_info "Installing prerequisites: $packages"
        
        case "$OS" in
            debian|ubuntu|linuxmint|pop)
                sudo apt-get update -qq
                sudo apt-get install -y $packages build-essential libssl-dev libffi-dev
                ;;
            centos|rhel|rocky|almalinux)
                if command_exists dnf; then
                    sudo dnf install -y $packages gcc openssl-devel libffi-devel
                else
                    sudo yum install -y $packages gcc openssl-devel libffi-devel
                fi
                ;;
            fedora)
                sudo dnf install -y $packages gcc openssl-devel libffi-devel
                ;;
            arch|manjaro)
                sudo pacman -S --noconfirm $packages base-devel
                ;;
            *)
                log_error "Unsupported OS: $OS. Please install $packages manually."
                exit 1
                ;;
        esac
        
        log_success "Prerequisites installed successfully."
    fi
}

# ============================================================================
# STEP 2: Clone Repository
# ============================================================================
clone_repository() {
    log_info "Step 2: Cloning/Updating AOP repository..."
    
    PROJECT_ROOT="/opt/AOP"
    REPO_URL="https://github.com/Ibrahimgamal99/AOP.git"

    if [ -d "$PROJECT_ROOT/.git" ]; then
        log_info "Repository already exists at $PROJECT_ROOT. Updating..."
        cd "$PROJECT_ROOT"
        sudo chown -R "$USER:$USER" "$PROJECT_ROOT" 2>/dev/null || true
        git fetch origin
        git pull || log_warning "Could not update repository. Continuing with existing code..."
        log_success "Repository updated."
    else
        if [ -d "$PROJECT_ROOT" ]; then
            log_warning "Directory $PROJECT_ROOT exists but is not a git repository."
            log_info "Backing up existing directory..."
            sudo mv "$PROJECT_ROOT" "${PROJECT_ROOT}.backup.$(date +%Y%m%d_%H%M%S)"
        fi
        
        log_info "Cloning repository to $PROJECT_ROOT..."
        sudo mkdir -p "$(dirname "$PROJECT_ROOT")"
        sudo git clone "$REPO_URL" "$PROJECT_ROOT"
        sudo chown -R "$USER:$USER" "$PROJECT_ROOT"
        log_success "Repository cloned successfully."
    fi
    
    cd "$PROJECT_ROOT"
}

# ============================================================================
# STEP 3: Install Node.js with nvm
# ============================================================================
install_nodejs() {
    log_info "Step 3: Installing Node.js 24 via nvm..."
    
    export NVM_DIR="$HOME/.nvm"
    
    # Install nvm if not present
    if [ ! -d "$NVM_DIR" ]; then
        log_info "Installing nvm..."
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
        log_success "nvm installed."
    else
        log_success "nvm is already installed."
    fi
    
    # Source nvm in current shell
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    
    # Add nvm initialization to shell profile if not present
    local shell_profile=""
    for profile in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.profile"; do
        if [ -f "$profile" ]; then
            shell_profile="$profile"
            break
        fi
    done
    
    if [ -n "$shell_profile" ] && ! grep -q "NVM_DIR" "$shell_profile"; then
        log_info "Adding nvm initialization to $shell_profile..."
        cat >> "$shell_profile" << 'NVM_INIT'

# NVM Configuration
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
NVM_INIT
        log_success "nvm initialization added to $shell_profile"
    fi
    
    # Install and use Node.js 24
    log_info "Installing Node.js 24..."
    nvm install 24
    nvm use 24
    nvm alias default 24
    
    local node_version=$(node --version)
    local npm_version=$(npm --version)
    log_success "Node.js $node_version and npm $npm_version installed successfully."
}

# ============================================================================
# STEP 4: Advanced Python Installation and Configuration
# ============================================================================
install_python() {
    log_info "Step 4: Installing and configuring Python..."
    
    local python_version=""
    local required_python_major=3
    local required_python_minor=8
    
    # Check if Python 3 is installed
    if command_exists python3; then
        python_version=$(python3 --version 2>&1 | awk '{print $2}')
        local python_major=$(echo "$python_version" | cut -d. -f1)
        local python_minor=$(echo "$python_version" | cut -d. -f2)
        
        if [ "$python_major" -ge $required_python_major ] && [ "$python_minor" -ge $required_python_minor ]; then
            log_success "Python $python_version is already installed and meets requirements (>= $required_python_major.$required_python_minor)."
        else
            log_warning "Python $python_version is installed but below required version $required_python_major.$required_python_minor."
        fi
    else
        log_info "Python 3 not found. Installing..."
        
        case "$OS" in
            debian|ubuntu|linuxmint|pop)
                sudo apt-get update -qq
                sudo apt-get install -y python3 python3-pip python3-venv python3-dev
                ;;
            centos|rhel|rocky|almalinux)
                if command_exists dnf; then
                    sudo dnf install -y python3 python3-pip python3-devel
                else
                    sudo yum install -y python3 python3-pip python3-devel
                fi
                ;;
            fedora)
                sudo dnf install -y python3 python3-pip python3-devel
                ;;
            arch|manjaro)
                sudo pacman -S --noconfirm python python-pip
                ;;
            *)
                log_error "Unsupported OS: $OS. Please install Python 3 manually."
                exit 1
                ;;
        esac
        
        python_version=$(python3 --version 2>&1 | awk '{print $2}')
        log_success "Python $python_version installed successfully."
    fi
    
    # Upgrade pip for Python 3
    log_info "Upgrading pip..."
    python3 -m pip install --upgrade pip --break-system-packages 2>/dev/null || \
    python3 -m pip install --upgrade pip --user 2>/dev/null || \
    log_warning "Could not upgrade pip. Continuing with existing version."
    
    # Install essential Python packages globally
    log_info "Installing essential Python packages (setuptools, wheel)..."
    python3 -m pip install --upgrade setuptools wheel --break-system-packages 2>/dev/null || \
    python3 -m pip install --upgrade setuptools wheel --user 2>/dev/null || \
    log_warning "Could not install essential packages. May cause issues later."
    
    # Create system-wide symlinks
    create_python_symlinks
    
    # Verify pip installation
    verify_pip_installation
}

# Create system-wide Python and pip symlinks
create_python_symlinks() {
    log_info "Creating system-wide Python symlinks..."
    
    local python3_path=$(command -v python3)
    
    if [ -z "$python3_path" ]; then
        log_error "python3 command not found after installation!"
        return 1
    fi
    
    # Create 'python' symlink
    if [ ! -f /usr/local/bin/python ]; then
        log_info "Creating symlink: /usr/local/bin/python -> $python3_path"
        sudo ln -sf "$python3_path" /usr/local/bin/python
        log_success "'python' command now available (points to python3)"
    else
        local link_target=$(readlink -f /usr/local/bin/python 2>/dev/null || echo "")
        if [ "$link_target" != "$python3_path" ] && [ -n "$link_target" ]; then
            log_info "Updating symlink: /usr/local/bin/python -> $python3_path"
            sudo ln -sf "$python3_path" /usr/local/bin/python
            log_success "'python' command updated to point to python3"
        else
            log_success "'python' symlink already exists and is correct"
        fi
    fi
    
    # Try to find pip3
    local pip3_path=""
    if command_exists pip3; then
        pip3_path=$(command -v pip3)
    elif command_exists python3; then
        # Check if pip3 is available via python3 -m pip
        if python3 -m pip --version >/dev/null 2>&1; then
            log_info "pip3 available via 'python3 -m pip'"
            # Create a wrapper script for pip if needed
            if [ ! -f /usr/local/bin/pip ]; then
                log_info "Creating wrapper script for pip"
                sudo tee /usr/local/bin/pip > /dev/null << 'EOF'
#!/bin/bash
exec python3 -m pip "$@"
EOF
                sudo chmod +x /usr/local/bin/pip
                log_success "'pip' command now available (wrapper for python3 -m pip)"
            fi
            return 0
        fi
    fi
    
    # Create 'pip' symlink if pip3 exists
    if [ -n "$pip3_path" ]; then
        if [ ! -f /usr/local/bin/pip ]; then
            log_info "Creating symlink: /usr/local/bin/pip -> $pip3_path"
            sudo ln -sf "$pip3_path" /usr/local/bin/pip
            log_success "'pip' command now available (points to pip3)"
        else
            local link_target=$(readlink -f /usr/local/bin/pip 2>/dev/null || echo "")
            if [ "$link_target" != "$pip3_path" ] && [ -n "$link_target" ]; then
                log_info "Updating symlink: /usr/local/bin/pip -> $pip3_path"
                sudo ln -sf "$pip3_path" /usr/local/bin/pip
                log_success "'pip' command updated to point to pip3"
            else
                log_success "'pip' symlink already exists and is correct"
            fi
        fi
    fi
}

# Verify pip installation and functionality
verify_pip_installation() {
    log_info "Verifying pip installation..."
    
    local pip_command=""
    
    # Determine which pip command to use
    if command_exists pip; then
        pip_command="pip"
    elif command_exists pip3; then
        pip_command="pip3"
    elif python3 -m pip --version >/dev/null 2>&1; then
        pip_command="python3 -m pip"
    else
        log_error "No working pip installation found!"
        log_info "Attempting to install pip..."
        
        # Try to install pip using get-pip.py
        local temp_dir=$(mktemp -d)
        cd "$temp_dir"
        
        if wget -q https://bootstrap.pypa.io/get-pip.py; then
            python3 get-pip.py --break-system-packages 2>/dev/null || \
            python3 get-pip.py --user || \
            log_error "Failed to install pip using get-pip.py"
        fi
        
        cd - > /dev/null
        rm -rf "$temp_dir"
        
        # Verify again
        if python3 -m pip --version >/dev/null 2>&1; then
            pip_command="python3 -m pip"
            log_success "pip installed successfully"
        else
            log_error "Failed to install pip. Please install manually."
            return 1
        fi
    fi
    
    local pip_version=$($pip_command --version 2>&1 | head -1)
    log_success "pip is working: $pip_version"
    
    # Export pip command for later use
    export AOP_PIP_COMMAND="$pip_command"
}

# ============================================================================
# STEP 5: Detect Issabel/FreePBX
# ============================================================================
detect_pbx_system() {
    log_info "Step 5: Detecting Issabel/FreePBX installation..."
    
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

    log_info "Detected system: $SYSTEM_TYPE"

    if [ "$SYSTEM_TYPE" == "Unknown" ]; then
        log_warning "Neither Issabel nor FreePBX detected."
        log_warning "You can continue with manual configuration or exit."
        read -p "Continue anyway? (y/N): " continue_anyway
        if [[ ! "$continue_anyway" =~ ^[Yy]$ ]]; then
            log_info "Installation cancelled by user."
            exit 0
        fi
        return 0
    fi
    
    log_success "PBX system detected: $SYSTEM_TYPE"
}

# ============================================================================
# STEP 6: Extract Database Configuration
# ============================================================================
extract_database_config() {
    log_info "Step 6: Extracting database configuration..."
    
    if [ "$SYSTEM_TYPE" == "Unknown" ]; then
        log_info "Manual database configuration required."
        prompt_manual_db_config
        return 0
    fi
    
    # Verify config file exists
    if [ ! -f "$CONFIG_FILE" ]; then
        if [ -n "$BACKUP_CONFIG_FILE" ] && [ -f "$BACKUP_CONFIG_FILE" ]; then
            log_info "Primary config file not found. Using backup: $BACKUP_CONFIG_FILE"
            CONFIG_FILE="$BACKUP_CONFIG_FILE"
            BACKUP_CONFIG_FILE=""
        else
            log_error "Configuration file $CONFIG_FILE not found!"
            prompt_manual_db_config
            return 0
        fi
    fi
    
    # Extract configuration based on system type
    if [ "$SYSTEM_TYPE" == "FreePBX" ]; then
        extract_freepbx_config
    elif [ "$SYSTEM_TYPE" == "Issabel" ]; then
        extract_issabel_config
    fi
    
    # Validate extracted configuration
    validate_db_config
}

# Extract PHP config value (for FreePBX)
extract_php_config() {
    local key=$1
    local config_file=$2
    local result=""
    
    # Try double quotes
    result=$(grep "\$amp_conf\[\"${key}\"\]" "$config_file" 2>/dev/null | \
             sed -n "s/.*= *\"\([^\"]*\)\".*/\1/p" | head -1)
    
    # Try single quotes if not found
    if [ -z "$result" ]; then
        result=$(grep "\$amp_conf\['${key}'\]" "$config_file" 2>/dev/null | \
                 sed -n "s/.*= *'\([^']*\)'.*/\1/p" | head -1)
    fi
    
    echo "$result"
}

# Extract simple key=value config (for Issabel)
extract_simple_config() {
    local key=$1
    local config_file=$2
    grep "^[[:space:]]*${key}[[:space:]]*=" "$config_file" 2>/dev/null | \
        sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)/\1/p" | \
        head -1 | sed 's/[[:space:]]*$//'
}

# Extract FreePBX configuration
extract_freepbx_config() {
    DB_USER=$(extract_php_config "AMPDBUSER" "$CONFIG_FILE")
    DB_PASSWORD=$(extract_php_config "AMPDBPASS" "$CONFIG_FILE")
    DB_HOST=$(extract_php_config "AMPDBHOST" "$CONFIG_FILE")
    DB_PORT=$(extract_php_config "AMPDBPORT" "$CONFIG_FILE")
    DB_NAME=$(extract_php_config "AMPDBNAME" "$CONFIG_FILE")
    
    # Set defaults
    DB_HOST=${DB_HOST:-localhost}
    DB_PORT=${DB_PORT:-3306}
}

# Extract Issabel configuration
extract_issabel_config() {
    local backup_config="/etc/issabel.conf"
    
    # Try primary config first
    DB_USER=$(extract_simple_config "AMPDBUSER" "$CONFIG_FILE")
    DB_PASSWORD=$(extract_simple_config "AMPDBPASS" "$CONFIG_FILE")
    DB_HOST=$(extract_simple_config "AMPDBHOST" "$CONFIG_FILE")
    DB_PORT=$(extract_simple_config "AMPDBPORT" "$CONFIG_FILE")
    DB_NAME=$(extract_simple_config "AMPDBNAME" "$CONFIG_FILE")
    
    # Try backup config if values missing
    if [ -f "$backup_config" ]; then
        [ -z "$DB_USER" ] && DB_USER=$(extract_simple_config "AMPDBUSER" "$backup_config")
        [ -z "$DB_PASSWORD" ] && DB_PASSWORD=$(extract_simple_config "AMPDBPASS" "$backup_config")
        [ -z "$DB_HOST" ] && DB_HOST=$(extract_simple_config "AMPDBHOST" "$backup_config")
        [ -z "$DB_PORT" ] && DB_PORT=$(extract_simple_config "AMPDBPORT" "$backup_config")
        [ -z "$DB_NAME" ] && DB_NAME=$(extract_simple_config "AMPDBNAME" "$backup_config")
        
        # Try MySQL root password as fallback
        if [ -z "$DB_PASSWORD" ]; then
            local mysql_root_pwd=$(extract_simple_config "mysqlrootpwd" "$backup_config")
            if [ -n "$mysql_root_pwd" ]; then
                DB_PASSWORD="$mysql_root_pwd"
                DB_USER="root"
            fi
        fi
    fi
    
    # Set defaults
    DB_HOST=${DB_HOST:-localhost}
    DB_PORT=${DB_PORT:-3306}
    DB_USER=${DB_USER:-root}
    DB_NAME=${DB_NAME:-asterisk}
}

# Validate database configuration
validate_db_config() {
    log_info "Validating database configuration..."
    
    echo "  DB_HOST: ${DB_HOST:-<not set>}"
    echo "  DB_PORT: ${DB_PORT:-<not set>}"
    echo "  DB_USER: ${DB_USER:-<not set>}"
    echo "  DB_PASSWORD: ${DB_PASSWORD:+***set***}"
    echo "  DB_NAME: ${DB_NAME:-<not set>}"
    
    if [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
        log_warning "Some database credentials are missing."
        prompt_manual_db_config
    else
        # Test database connection
        if command_exists mysql; then
            log_info "Testing database connection..."
            if mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASSWORD" -e "USE $DB_NAME;" 2>/dev/null; then
                log_success "Database connection successful!"
            else
                log_warning "Database connection failed. Please verify credentials."
                read -p "Re-enter database credentials? (y/N): " re_enter
                if [[ "$re_enter" =~ ^[Yy]$ ]]; then
                    prompt_manual_db_config
                fi
            fi
        else
            log_warning "MySQL client not found. Cannot test database connection."
        fi
    fi
}

# Prompt for manual database configuration
prompt_manual_db_config() {
    log_info "Please enter database credentials manually:"
    
    read -p "DB_HOST [${DB_HOST:-localhost}]: " input_host
    DB_HOST=${input_host:-${DB_HOST:-localhost}}
    
    read -p "DB_PORT [${DB_PORT:-3306}]: " input_port
    DB_PORT=${input_port:-${DB_PORT:-3306}}
    
    read -p "DB_USER [${DB_USER:-root}]: " input_user
    DB_USER=${input_user:-${DB_USER:-root}}
    
    read -sp "DB_PASSWORD: " input_password
    echo ""
    DB_PASSWORD=${input_password:-$DB_PASSWORD}
    
    read -p "DB_NAME [${DB_NAME:-asterisk}]: " input_name
    DB_NAME=${input_name:-${DB_NAME:-asterisk}}
}

# ============================================================================
# STEP 7: Configure AMI
# ============================================================================
configure_ami() {
    log_info "Step 7: Configuring Asterisk Manager Interface (AMI)..."
    
    read -p "AMI_HOST [localhost]: " AMI_HOST
    AMI_HOST=${AMI_HOST:-localhost}
    
    read -p "AMI_PORT [5038]: " AMI_PORT
    AMI_PORT=${AMI_PORT:-5038}
    
    read -sp "AMI_SECRET: " AMI_SECRET
    echo ""
    
    while [ -z "$AMI_SECRET" ]; do
        log_warning "AMI_SECRET cannot be empty."
        read -sp "AMI_SECRET: " AMI_SECRET
        echo ""
    done
    
    AMI_USERNAME="AOP"
    
    # Configure manager.conf
    local manager_conf="/etc/asterisk/manager.conf"
    
    if [ ! -f "$manager_conf" ]; then
        log_warning "$manager_conf not found."
        read -p "Create it? (y/N): " create_conf
        if [[ "$create_conf" =~ ^[Yy]$ ]]; then
            sudo touch "$manager_conf"
            log_success "Created $manager_conf"
        else
            log_warning "Skipping AMI configuration in manager.conf"
            return 0
        fi
    fi
    
    # Create backup
    sudo cp "$manager_conf" "${manager_conf}.backup.$(date +%Y%m%d_%H%M%S)"
    log_success "Backup created: ${manager_conf}.backup.$(date +%Y%m%d_%H%M%S)"
    
    # Add configuration if not exists
    if ! sudo grep -q "^\[$AMI_USERNAME\]" "$manager_conf"; then
        log_info "Adding AMI user configuration..."
        
        sudo tee -a "$manager_conf" > /dev/null << AMI_CONFIG

[$AMI_USERNAME]
secret = $AMI_SECRET
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = all
write = all
AMI_CONFIG
        
        log_success "AMI configuration added to $manager_conf"
        
        # Reload Asterisk manager
        reload_asterisk_manager
    else
        log_success "AMI user $AMI_USERNAME already exists in $manager_conf"
    fi
}

# Reload Asterisk manager module
reload_asterisk_manager() {
    log_info "Reloading Asterisk manager module..."
    
    local asterisk_cmd=""
    
    if command_exists asterisk; then
        asterisk_cmd="asterisk"
    elif [ -f /usr/sbin/asterisk ]; then
        asterisk_cmd="/usr/sbin/asterisk"
    else
        log_warning "Asterisk command not found. Please reload manually: asterisk -rx 'manager reload'"
        return 1
    fi
    
    if sudo "$asterisk_cmd" -rx "manager reload" >/dev/null 2>&1; then
        log_success "Asterisk manager module reloaded successfully"
    else
        log_warning "Could not reload Asterisk manager module. Please reload manually."
    fi
}

# ============================================================================
# STEP 8: Create Environment File
# ============================================================================
create_env_file() {
    log_info "Step 8: Creating environment configuration file..."
    
    local backend_dir="$PROJECT_ROOT/backend"
    local env_file="$backend_dir/.env"
    
    # Ensure backend directory exists
    if [ ! -d "$backend_dir" ]; then
        log_info "Creating backend directory..."
        mkdir -p "$backend_dir"
    fi
    
    # Create .env file
    cat > "$env_file" << ENV_CONFIG
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

# Application Configuration
NODE_ENV=production
LOG_LEVEL=info
ENV_CONFIG
    
    # Secure the env file
    chmod 600 "$env_file"
    
    log_success "Configuration saved to $env_file"
    log_info "File permissions set to 600 (owner read/write only)"
}

# ============================================================================
# STEP 9: Install Python Dependencies
# ============================================================================
install_python_dependencies() {
    log_info "Step 9: Installing Python dependencies..."
    
    local backend_dir="$PROJECT_ROOT/backend"
    cd "$backend_dir"
    
    if [ ! -f "requirements.txt" ]; then
        log_error "requirements.txt not found in $backend_dir"
        return 1
    fi
    
    # Determine pip command
    local pip_cmd="${AOP_PIP_COMMAND:-python3 -m pip}"
    
    log_info "Using pip command: $pip_cmd"
    log_info "Installing packages from requirements.txt..."
    
    # Try different installation methods
    if $pip_cmd install --break-system-packages -r requirements.txt 2>/dev/null; then
        log_success "Python dependencies installed successfully (--break-system-packages)"
    elif $pip_cmd install --user -r requirements.txt 2>/dev/null; then
        log_success "Python dependencies installed successfully (--user)"
    elif python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt; then
        log_success "Python dependencies installed successfully (virtual environment)"
        log_info "Note: Virtual environment created at $backend_dir/venv"
        log_warning "Remember to activate it: source $backend_dir/venv/bin/activate"
    else
        log_error "Failed to install Python dependencies."
        log_info "Please try manually: cd $backend_dir && pip install -r requirements.txt"
        return 1
    fi
    
    # Verify critical packages
    verify_python_packages
}

# Verify Python packages are installed
verify_python_packages() {
    log_info "Verifying Python package installation..."
    
    local critical_packages=("flask" "mysql-connector-python" "python-dotenv")
    local missing_packages=()
    
    for package in "${critical_packages[@]}"; do
        if ! python3 -c "import ${package//-/_}" 2>/dev/null; then
            missing_packages+=("$package")
        fi
    done
    
    if [ ${#missing_packages[@]} -eq 0 ]; then
        log_success "All critical Python packages are installed"
    else
        log_warning "Some critical packages may be missing: ${missing_packages[*]}"
        log_info "You may need to install them manually"
    fi
}

# ============================================================================
# STEP 10: Install Node.js Dependencies
# ============================================================================
install_nodejs_dependencies() {
    log_info "Step 10: Installing Node.js dependencies..."
    
    local frontend_dir="$PROJECT_ROOT/frontend"
    
    if [ ! -d "$frontend_dir" ]; then
        log_error "Frontend directory not found: $frontend_dir"
        return 1
    fi
    
    cd "$frontend_dir"
    
    if [ ! -f "package.json" ]; then
        log_error "package.json not found in $frontend_dir"
        return 1
    fi
    
    log_info "Running npm install..."
    if npm install; then
        log_success "Node.js dependencies installed successfully"
    else
        log_error "Failed to install Node.js dependencies"
        log_info "Please try manually: cd $frontend_dir && npm install"
        return 1
    fi
}


# ============================================================================
# MAIN EXECUTION
# ============================================================================
main() {
    # Pre-flight checks
    check_root
    verify_sudo
    
    # Installation steps
    detect_os_and_install_prerequisites
    clone_repository
    install_nodejs
    install_python
    detect_pbx_system
    extract_database_config
    configure_ami
    create_env_file
    install_python_dependencies
    install_nodejs_dependencies
    
    # Summary
    echo ""
    echo "================================================================"
    log_success "Installation Complete!"
    echo "================================================================"
    echo ""
    echo "Configuration Summary:"
    echo "  - Project Root: $PROJECT_ROOT"
    echo "  - Environment File: $PROJECT_ROOT/backend/.env"
    echo "  - Python: $(python3 --version)"
    echo "  - Node.js: $(node --version)"
    echo "  - npm: $(npm --version)"
    
    if [ -f /usr/local/bin/python ]; then
        echo ""
        echo "  ✓ 'python' command available (symlinked to python3)"
    fi
    
    if [ -f /usr/local/bin/pip ] || command_exists pip; then
        echo "  ✓ 'pip' command available"
    fi
    
    echo ""
    echo "To start the application:"
    echo "  cd $PROJECT_ROOT"
    echo "  ./start.sh"
    echo ""
    echo "Or manually:"
    echo "  Backend:  cd $PROJECT_ROOT/backend && python server.py"
    echo "  Frontend: cd $PROJECT_ROOT/frontend && npm run dev"
    echo ""
    echo "Installation log saved to: $LOG_FILE"
    echo "================================================================"
}

# Run main function
main "$@"