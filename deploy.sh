#!/bin/bash

# Configuration
SERVER_USER="ubuntu"
SERVER_IP="130.61.10.165"
REMOTE_DIR="~/oceanic.io"
ARCHIVE_NAME="oceanic_deploy.tar.gz"

echo "🚀 Starting deployment to $SERVER_USER@$SERVER_IP..."

# 1. Create Archive (excluding node_modules, .git, etc.)
echo "📦 Creating archive..."
tar --exclude='node_modules' --exclude='.git' --exclude='.DS_Store' --exclude='dist' -czf $ARCHIVE_NAME .

# 2. Transfer Archive
echo "📤 Uploading archive..."
scp $ARCHIVE_NAME $SERVER_USER@$SERVER_IP:~/

# 3. Execute Remote Commands
echo "🔧 Executing remote commands..."
ssh $SERVER_USER@$SERVER_IP << EOF
    # Create directory if it doesn't exist
    mkdir -p $REMOTE_DIR
    
    # Move archive to directory
    mv ~/$ARCHIVE_NAME $REMOTE_DIR/
    
    # Go to directory
    cd $REMOTE_DIR
    
    # Extract archive
    echo "📂 Extracting..."
    tar -xzf $ARCHIVE_NAME
    
    # Remove archive
    rm $ARCHIVE_NAME
    
    # Docker Compose Deployment
    echo "� Deploying with Docker Compose..."
    
    # Check if docker-compose exists, otherwise try 'docker compose'
    if command -v docker-compose &> /dev/null; then
        COMPOSE_CMD="docker-compose"
    else
        COMPOSE_CMD="docker compose"
    fi
    
    # Stop existing containers
    echo "� Stopping existing containers..."
    \$COMPOSE_CMD down || true
    
    # Build and Start
    echo "🏗️ Building and Starting containers..."
    \$COMPOSE_CMD up -d --build
    
    # Prune unused images to save space
    echo "🧹 Pruning unused images..."
    docker image prune -f
    
    echo "✅ Deployment complete!"
    echo "   Server running on port 38081"
    echo "   Client running on port 38080"
EOF

# 4. Cleanup Local Archive
echo "🧹 Cleaning up..."
rm $ARCHIVE_NAME

echo "🎉 Done!"
