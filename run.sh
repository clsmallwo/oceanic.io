#!/bin/bash

# Oceanic.io Local Setup Script
# This script manages the client and server without Docker

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
CLIENT_DIR="$PROJECT_ROOT/client"
SERVER_DIR="$PROJECT_ROOT/server"
PID_DIR="$PROJECT_ROOT/.pids"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Create PID directory if it doesn't exist
mkdir -p "$PID_DIR"

# Function to print colored messages
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Node.js is installed
check_node() {
    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed!"
        print_info "Please install Node.js from https://nodejs.org/"
        exit 1
    fi
    print_success "Node.js $(node --version) detected"
}

# Check if npm is installed
check_npm() {
    if ! command -v npm &> /dev/null; then
        print_error "npm is not installed!"
        exit 1
    fi
    print_success "npm $(npm --version) detected"
}

# Get local network IP address
get_local_ip() {
    # Try to get the local IP address (macOS)
    LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -n 1)
    
    if [ -z "$LOCAL_IP" ]; then
        # Fallback method
        LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
    fi
    
    echo "$LOCAL_IP"
}

# Install dependencies
install_deps() {
    print_info "Installing dependencies..."
    
    # Install server dependencies
    print_info "Installing server dependencies..."
    cd "$SERVER_DIR"
    npm install
    
    # Install client dependencies
    print_info "Installing client dependencies..."
    cd "$CLIENT_DIR"
    npm install
    
    print_success "All dependencies installed!"
    cd "$PROJECT_ROOT"
}

# Start the server
start_server() {
    if [ -f "$PID_DIR/server.pid" ] && kill -0 $(cat "$PID_DIR/server.pid") 2>/dev/null; then
        print_warning "Server is already running (PID: $(cat $PID_DIR/server.pid))"
        return
    fi
    
    print_info "Starting server on port 3001..."
    cd "$SERVER_DIR"
    nohup node index.js > "$PROJECT_ROOT/server.log" 2>&1 &
    echo $! > "$PID_DIR/server.pid"
    sleep 2
    
    if kill -0 $(cat "$PID_DIR/server.pid") 2>/dev/null; then
        print_success "Server started successfully (PID: $(cat $PID_DIR/server.pid))"
    else
        print_error "Server failed to start. Check server.log for details."
        rm -f "$PID_DIR/server.pid"
        exit 1
    fi
    cd "$PROJECT_ROOT"
}

# Start the client
start_client() {
    if [ -f "$PID_DIR/client.pid" ] && kill -0 $(cat "$PID_DIR/client.pid") 2>/dev/null; then
        print_warning "Client is already running (PID: $(cat $PID_DIR/client.pid))"
        return
    fi
    
    print_info "Starting client on port 5173..."
    cd "$CLIENT_DIR"
    nohup npm run dev > "$PROJECT_ROOT/client.log" 2>&1 &
    echo $! > "$PID_DIR/client.pid"
    sleep 3
    
    if kill -0 $(cat "$PID_DIR/client.pid") 2>/dev/null; then
        print_success "Client started successfully (PID: $(cat $PID_DIR/client.pid))"
    else
        print_error "Client failed to start. Check client.log for details."
        rm -f "$PID_DIR/client.pid"
        exit 1
    fi
    cd "$PROJECT_ROOT"
}

# Stop the server
stop_server() {
    if [ -f "$PID_DIR/server.pid" ]; then
        PID=$(cat "$PID_DIR/server.pid")
        if kill -0 $PID 2>/dev/null; then
            print_info "Stopping server (PID: $PID)..."
            kill $PID
            sleep 1
            if kill -0 $PID 2>/dev/null; then
                print_warning "Server didn't stop gracefully, forcing..."
                kill -9 $PID
            fi
            print_success "Server stopped"
        else
            print_warning "Server PID file exists but process is not running"
        fi
        rm -f "$PID_DIR/server.pid"
    else
        print_warning "Server is not running"
    fi
}

# Stop the client
stop_client() {
    if [ -f "$PID_DIR/client.pid" ]; then
        PID=$(cat "$PID_DIR/client.pid")
        if kill -0 $PID 2>/dev/null; then
            print_info "Stopping client (PID: $PID)..."
            # Kill the entire process group (Vite spawns child processes)
            pkill -P $PID 2>/dev/null || true
            kill $PID 2>/dev/null || true
            sleep 1
            if kill -0 $PID 2>/dev/null; then
                print_warning "Client didn't stop gracefully, forcing..."
                kill -9 $PID 2>/dev/null || true
            fi
            print_success "Client stopped"
        else
            print_warning "Client PID file exists but process is not running"
        fi
        rm -f "$PID_DIR/client.pid"
    else
        print_warning "Client is not running"
    fi
}

# Check status
check_status() {
    print_info "Checking application status..."
    echo ""
    
    # Get local network IP
    LOCAL_IP=$(get_local_ip)
    
    # Check server
    if [ -f "$PID_DIR/server.pid" ] && kill -0 $(cat "$PID_DIR/server.pid") 2>/dev/null; then
        print_success "Server is running (PID: $(cat $PID_DIR/server.pid))"
        echo "  Local:   http://localhost:3001"
        if [ -n "$LOCAL_IP" ]; then
            echo "  Network: http://${LOCAL_IP}:3001"
        fi
    else
        print_error "Server is not running"
    fi
    
    echo ""
    
    # Check client
    if [ -f "$PID_DIR/client.pid" ] && kill -0 $(cat "$PID_DIR/client.pid") 2>/dev/null; then
        print_success "Client is running (PID: $(cat $PID_DIR/client.pid))"
        echo "  Local:   http://localhost:5173"
        if [ -n "$LOCAL_IP" ]; then
            echo "  Network: http://${LOCAL_IP}:5173"
        fi
    else
        print_error "Client is not running"
    fi
    
    echo ""
}

# Show logs
show_logs() {
    print_info "Showing logs (Ctrl+C to exit)..."
    echo ""
    
    if [ "$1" == "server" ]; then
        tail -f "$PROJECT_ROOT/server.log"
    elif [ "$1" == "client" ]; then
        tail -f "$PROJECT_ROOT/client.log"
    else
        # Show both logs
        tail -f "$PROJECT_ROOT/server.log" "$PROJECT_ROOT/client.log"
    fi
}

# Clean up function
cleanup() {
    print_info "Cleaning up PID files..."
    rm -rf "$PID_DIR"
    print_success "Cleanup complete"
}

# Main script logic
case "$1" in
    start)
        check_node
        check_npm
        
        # Check if dependencies are installed
        if [ ! -d "$SERVER_DIR/node_modules" ] || [ ! -d "$CLIENT_DIR/node_modules" ]; then
            print_warning "Dependencies not found. Installing..."
            install_deps
        fi
        
        start_server
        start_client
        
        # Get local network IP
        LOCAL_IP=$(get_local_ip)
        
        echo ""
        print_success "Oceanic.io is running!"
        echo ""
        echo "  🌊 Client (Local):   http://localhost:5173"
        if [ -n "$LOCAL_IP" ]; then
            echo "  🌊 Client (Network): http://${LOCAL_IP}:5173"
        fi
        echo ""
        echo "  🐠 Server (Local):   http://localhost:3001"
        if [ -n "$LOCAL_IP" ]; then
            echo "  🐠 Server (Network): http://${LOCAL_IP}:3001"
        fi
        echo ""
        if [ -n "$LOCAL_IP" ]; then
            print_info "Share the Network URL to play with others on the same WiFi!"
        else
            print_warning "Could not detect local network IP"
        fi
        echo ""
        print_info "Use './run.sh stop' to stop the application"
        print_info "Use './run.sh status' to check status"
        print_info "Use './run.sh logs' to view logs"
        ;;
    
    stop)
        stop_client
        stop_server
        print_success "Oceanic.io has been stopped"
        ;;
    
    restart)
        print_info "Restarting Oceanic.io..."
        stop_client
        stop_server
        sleep 2
        start_server
        start_client
        print_success "Oceanic.io restarted!"
        ;;
    
    status)
        check_status
        ;;
    
    logs)
        show_logs "$2"
        ;;
    
    install)
        check_node
        check_npm
        install_deps
        ;;
    
    clean)
        stop_client
        stop_server
        cleanup
        ;;
    
    *)
        echo "Oceanic.io - Local Setup Script"
        echo ""
        echo "Usage: $0 {start|stop|restart|status|logs|install|clean}"
        echo ""
        echo "Commands:"
        echo "  start    - Install dependencies (if needed) and start the application"
        echo "  stop     - Stop the application"
        echo "  restart  - Restart the application"
        echo "  status   - Check if services are running"
        echo "  logs     - Show application logs (optionally: 'server' or 'client')"
        echo "  install  - Install/update dependencies"
        echo "  clean    - Stop services and clean up PID files"
        echo ""
        exit 1
        ;;
esac

exit 0

