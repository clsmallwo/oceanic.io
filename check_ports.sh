#!/bin/bash

# Oceanic.io Port Checker Script
# This script checks if the required ports are open and services are accessible

set -e

echo "============================================"
echo "  Oceanic.io Port Accessibility Checker"
echo "============================================"
echo ""

# Define ports
CLIENT_PORT=38080
SERVER_PORT=38081

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if port is listening
check_port_listening() {
    local port=$1
    local name=$2
    
    echo -n "Checking if $name is listening on port $port... "
    
    if lsof -i :$port > /dev/null 2>&1 || netstat -tuln 2>/dev/null | grep -q ":$port "; then
        echo -e "${GREEN}✓ LISTENING${NC}"
        return 0
    else
        echo -e "${RED}✗ NOT LISTENING${NC}"
        return 1
    fi
}

# Function to check HTTP connectivity
check_http_connectivity() {
    local port=$1
    local name=$2
    
    echo -n "Checking HTTP connectivity to $name on port $port... "
    
    if command -v curl > /dev/null 2>&1; then
        if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://localhost:$port > /dev/null 2>&1; then
            echo -e "${GREEN}✓ ACCESSIBLE${NC}"
            return 0
        else
            echo -e "${RED}✗ NOT ACCESSIBLE${NC}"
            return 1
        fi
    elif command -v wget > /dev/null 2>&1; then
        if wget -q -O /dev/null --timeout=5 http://localhost:$port 2>/dev/null; then
            echo -e "${GREEN}✓ ACCESSIBLE${NC}"
            return 0
        else
            echo -e "${RED}✗ NOT ACCESSIBLE${NC}"
            return 1
        fi
    else
        echo -e "${YELLOW}⚠ Cannot check (curl/wget not found)${NC}"
        return 0
    fi
}

# Function to check Docker containers
check_docker_containers() {
    echo ""
    echo "Docker Container Status:"
    echo "------------------------"
    
    if ! command -v docker > /dev/null 2>&1; then
        echo -e "${RED}✗ Docker not found${NC}"
        return 1
    fi
    
    if docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "oceanic_(client|server)"; then
        return 0
    else
        echo -e "${RED}✗ No Oceanic.io containers running${NC}"
        return 1
    fi
}

# Function to check firewall status
check_firewall() {
    echo ""
    echo "Firewall Status:"
    echo "----------------"
    
    # Check UFW
    if command -v ufw > /dev/null 2>&1; then
        echo "UFW Status:"
        if sudo ufw status | grep -E "${CLIENT_PORT}|${SERVER_PORT}"; then
            echo -e "${GREEN}✓ Ports configured in UFW${NC}"
        else
            echo -e "${YELLOW}⚠ Ports not found in UFW rules${NC}"
            echo "  Run: sudo ufw allow ${CLIENT_PORT}/tcp && sudo ufw allow ${SERVER_PORT}/tcp"
        fi
    fi
    
    # Check firewalld
    if command -v firewall-cmd > /dev/null 2>&1; then
        echo "Firewalld Status:"
        if sudo firewall-cmd --list-ports | grep -E "${CLIENT_PORT}|${SERVER_PORT}"; then
            echo -e "${GREEN}✓ Ports configured in firewalld${NC}"
        else
            echo -e "${YELLOW}⚠ Ports not found in firewalld rules${NC}"
            echo "  Run: sudo firewall-cmd --permanent --add-port=${CLIENT_PORT}/tcp --add-port=${SERVER_PORT}/tcp && sudo firewall-cmd --reload"
        fi
    fi
}

# Main checks
echo "1. Checking Docker Containers"
echo "=============================="
check_docker_containers
docker_status=$?

echo ""
echo "2. Checking Port Listening Status"
echo "=================================="
check_port_listening $CLIENT_PORT "Client (Web UI)"
client_listening=$?

check_port_listening $SERVER_PORT "Server (WebSocket)"
server_listening=$?

echo ""
echo "3. Checking HTTP Connectivity"
echo "=============================="
if [ $client_listening -eq 0 ]; then
    check_http_connectivity $CLIENT_PORT "Client"
    client_http=$?
else
    echo "Skipping client connectivity check (not listening)"
    client_http=1
fi

if [ $server_listening -eq 0 ]; then
    check_http_connectivity $SERVER_PORT "Server"
    server_http=$?
else
    echo "Skipping server connectivity check (not listening)"
    server_http=1
fi

echo ""
echo "4. Checking Firewall Configuration"
echo "==================================="
check_firewall

# Summary
echo ""
echo "============================================"
echo "  SUMMARY"
echo "============================================"

if [ $docker_status -eq 0 ] && [ $client_listening -eq 0 ] && [ $server_listening -eq 0 ]; then
    echo -e "${GREEN}✓ All services are running and accessible${NC}"
    echo ""
    echo "Access your game at: http://localhost:${CLIENT_PORT}"
    echo "Server WebSocket: http://localhost:${SERVER_PORT}"
    echo ""
    echo "For external access, use your server's IP address:"
    echo "  http://YOUR_SERVER_IP:${CLIENT_PORT}"
else
    echo -e "${RED}✗ Some services are not running properly${NC}"
    echo ""
    echo "Troubleshooting steps:"
    echo "1. Start Docker containers: docker-compose up -d"
    echo "2. Check container logs: docker-compose logs"
    echo "3. Verify firewall rules allow ports ${CLIENT_PORT} and ${SERVER_PORT}"
    echo "4. Ensure Docker is running: docker ps"
fi

echo ""
echo "============================================"

