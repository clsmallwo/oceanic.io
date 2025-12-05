# Oceanic.io Deployment Guide

## Overview

Oceanic.io is a multiplayer ocean-themed strategy game that runs entirely in Docker containers. The application uses **unconventional ports** for security and uniqueness.

## Ports Configuration

- **Client (Web UI)**: Port **38080** (external) → Port 80 (internal nginx)
- **Server (WebSocket/API)**: Port **38081** (external) → Port 3001 (internal)

## Prerequisites

- Docker (version 20.10 or higher)
- Docker Compose (version 1.29 or higher)

## Quick Start

### 1. Build and Start the Application

```bash
docker-compose up -d --build
```

This command will:
- Build both the client and server Docker images
- Start the containers in detached mode
- Expose the services on the unconventional ports

### 2. Access the Application

Once the containers are running, access the game at:

```
http://your-server-ip:38080
```

Or on localhost:

```
http://localhost:38080
```

### 3. Check Container Status

```bash
docker-compose ps
```

### 4. View Logs

```bash
# View all logs
docker-compose logs -f

# View server logs only
docker-compose logs -f server

# View client logs only
docker-compose logs -f client
```

## Firewall Configuration

To ensure the application is accessible from external networks, you need to open the ports on your server's firewall.

### For UFW (Ubuntu/Debian)

```bash
sudo ufw allow 38080/tcp comment 'Oceanic.io Client'
sudo ufw allow 38081/tcp comment 'Oceanic.io Server'
sudo ufw reload
```

### For firewalld (CentOS/RHEL/Fedora)

```bash
sudo firewall-cmd --permanent --add-port=38080/tcp
sudo firewall-cmd --permanent --add-port=38081/tcp
sudo firewall-cmd --reload
```

### For iptables

```bash
sudo iptables -A INPUT -p tcp --dport 38080 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 38081 -j ACCEPT
sudo iptables-save > /etc/iptables/rules.v4
```

### For Cloud Providers (AWS, GCP, Azure, etc.)

Make sure to configure your security groups or firewall rules to allow:
- **Inbound TCP traffic on port 38080** (for the web interface)
- **Inbound TCP traffic on port 38081** (for the WebSocket server)

## Container Management

### Stop the Application

```bash
docker-compose down
```

### Restart the Application

```bash
docker-compose restart
```

### Update and Rebuild

```bash
docker-compose down
docker-compose up -d --build
```

### Remove All Data and Containers

```bash
docker-compose down -v
```

## Health Checks

Both services include health checks:

- **Server**: Checks HTTP connectivity on internal port 3001
- **Client**: Checks nginx availability on internal port 80

View health status:

```bash
docker-compose ps
```

Healthy containers will show "(healthy)" in the status column.

## Network Architecture

The application uses a custom Docker bridge network named `oceanic_network`. This allows:
- Secure container-to-container communication
- Isolation from other Docker networks
- DNS resolution between services

## Troubleshooting

### Port Already in Use

If you get an error about ports being in use, check what's using them:

```bash
sudo lsof -i :38080
sudo lsof -i :38081
```

### Client Can't Connect to Server

1. Check that both containers are running:
   ```bash
   docker-compose ps
   ```

2. Verify the server is listening:
   ```bash
   docker-compose exec server netstat -tulpn | grep 3001
   ```

3. Check firewall rules are allowing traffic on port 38081

### Container Keeps Restarting

Check the logs for errors:

```bash
docker-compose logs server
docker-compose logs client
```

## Production Considerations

1. **SSL/TLS**: Consider adding a reverse proxy (nginx/caddy) with SSL certificates
2. **Domain Name**: Point a domain to your server and use proper DNS
3. **Monitoring**: Set up monitoring for container health and resource usage
4. **Backups**: If you add persistent storage, ensure regular backups
5. **Updates**: Regularly update the base images and dependencies

## Security Notes

- The server accepts connections from any origin (`cors: { origin: "*" }`)
- Consider restricting CORS in production environments
- Use environment variables for sensitive configuration
- Regularly update Docker images and dependencies

## Changing Ports

To use different ports, edit `docker-compose.yml`:

```yaml
ports:
  - "YOUR_CLIENT_PORT:80"     # Change YOUR_CLIENT_PORT
  - "YOUR_SERVER_PORT:3001"   # Change YOUR_SERVER_PORT
```

Remember to update firewall rules accordingly.

## Support

For issues or questions, check the main README.md or open an issue on the project repository.

