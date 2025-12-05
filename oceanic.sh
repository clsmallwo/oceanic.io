#!/bin/bash

# Oceanic.io Management Script
# Simplified commands to manage the Oceanic.io application

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to display help
show_help() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║     Oceanic.io Management Script      ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
    echo ""
    echo "Usage: ./oceanic.sh [command]"
    echo ""
    echo "Commands:"
    echo "  start       - Build and start all services"
    echo "  stop        - Stop all services"
    echo "  restart     - Restart all services"
    echo "  logs        - View logs from all services"
    echo "  logs-client - View client logs only"
    echo "  logs-server - View server logs only"
    echo "  status      - Show container status"
    echo "  rebuild     - Rebuild and restart all services"
    echo "  clean       - Stop and remove all containers and volumes"
    echo "  check       - Check if ports are accessible"
    echo "  help        - Show this help message"
    echo ""
    echo "Ports:"
    echo "  Client (Web UI): http://localhost:38080"
    echo "  Server (API):    http://localhost:38081"
    echo ""
}

# Function to check if Docker is running
check_docker() {
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}Error: Docker is not installed${NC}"
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        echo -e "${RED}Error: Docker daemon is not running${NC}"
        exit 1
    fi
}

# Main script
COMMAND=${1:-help}

case $COMMAND in
    start)
        echo -e "${GREEN}Starting Oceanic.io...${NC}"
        check_docker
        docker-compose up -d --build
        echo ""
        echo -e "${GREEN}✓ Services started successfully!${NC}"
        echo ""
        echo "Access the game at: http://localhost:38080"
        echo ""
        echo "Run './oceanic.sh logs' to view logs"
        echo "Run './oceanic.sh status' to check container status"
        ;;
    
    stop)
        echo -e "${YELLOW}Stopping Oceanic.io...${NC}"
        check_docker
        docker-compose down
        echo -e "${GREEN}✓ Services stopped${NC}"
        ;;
    
    restart)
        echo -e "${YELLOW}Restarting Oceanic.io...${NC}"
        check_docker
        docker-compose restart
        echo -e "${GREEN}✓ Services restarted${NC}"
        ;;
    
    logs)
        check_docker
        docker-compose logs -f
        ;;
    
    logs-client)
        check_docker
        docker-compose logs -f client
        ;;
    
    logs-server)
        check_docker
        docker-compose logs -f server
        ;;
    
    status)
        check_docker
        echo -e "${BLUE}Container Status:${NC}"
        docker-compose ps
        echo ""
        echo -e "${BLUE}Resource Usage:${NC}"
        docker stats --no-stream oceanic_client oceanic_server 2>/dev/null || echo "Containers not running"
        ;;
    
    rebuild)
        echo -e "${YELLOW}Rebuilding Oceanic.io...${NC}"
        check_docker
        docker-compose down
        docker-compose build --no-cache
        docker-compose up -d
        echo -e "${GREEN}✓ Services rebuilt and started${NC}"
        echo ""
        echo "Access the game at: http://localhost:38080"
        ;;
    
    clean)
        echo -e "${RED}WARNING: This will remove all containers and volumes${NC}"
        read -p "Are you sure? (yes/no): " confirm
        if [ "$confirm" == "yes" ]; then
            check_docker
            docker-compose down -v
            docker system prune -f
            echo -e "${GREEN}✓ Cleanup complete${NC}"
        else
            echo "Cancelled"
        fi
        ;;
    
    check)
        if [ -f "./check_ports.sh" ]; then
            ./check_ports.sh
        else
            echo -e "${RED}Error: check_ports.sh not found${NC}"
            exit 1
        fi
        ;;
    
    help|--help|-h)
        show_help
        ;;
    
    *)
        echo -e "${RED}Error: Unknown command '$COMMAND'${NC}"
        show_help
        exit 1
        ;;
esac

