const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all for dev
        methods: ["GET", "POST"]
    }
});

const PORT = 3001;

// AI / ML files
const STATS_FILE = path.join(__dirname, 'ai_stats.json');
const ML_MODEL_FILE = path.join(__dirname, 'ml_model.json');

// Rate limiting: Track events per socket
const rateLimits = new Map(); // socketId -> { eventCount, resetTime }
const RATE_LIMIT_WINDOW = 1000; // 1 second
const RATE_LIMIT_MAX = 20; // Max events per window

// Input validation utilities
function validateUsername(username) {
    if (!username || typeof username !== 'string') return false;
    const trimmed = username.trim();
    if (trimmed.length === 0 || trimmed.length > 20) return false;
    // Allow alphanumeric, spaces, and common special chars
    return /^[a-zA-Z0-9\s\-_]+$/.test(trimmed);
}

function sanitizeUsername(username) {
    if (!username || typeof username !== 'string') return `Player${Math.random().toString(36).substr(2, 4)}`;
    return username.trim().substr(0, 20).replace(/[^a-zA-Z0-9\s\-_]/g, '') || `Player${Math.random().toString(36).substr(2, 4)}`;
}

function validateGameId(gameId) {
    return gameId && typeof gameId === 'string' && gameId.length > 0 && gameId.length <= 50 && /^[a-zA-Z0-9_\-]+$/.test(gameId);
}

function validateCardId(cardId) {
    return cardId && typeof cardId === 'string' && CARDS.some(c => c.id === cardId);
}

function validateCoordinates(x, y) {
    return typeof x === 'number' && typeof y === 'number' &&
        !isNaN(x) && !isNaN(y) &&
        x >= 0 && x < GRID_SIZE &&
        y >= 0 && y < GRID_SIZE &&
        Number.isInteger(x) && Number.isInteger(y);
}

function validateTroopId(troopId) {
    return troopId && typeof troopId === 'string' && troopId.length > 0;
}

// Rate limiting check
function checkRateLimit(socketId) {
    const now = Date.now();
    const limit = rateLimits.get(socketId);

    if (!limit || now > limit.resetTime) {
        rateLimits.set(socketId, { eventCount: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return true;
    }

    if (limit.eventCount >= RATE_LIMIT_MAX) {
        return false;
    }

    limit.eventCount++;
    return true;
}

// Game state validation
function validateGameState(game) {
    if (!game || typeof game !== 'object') return false;
    if (!game.players || typeof game.players !== 'object') return false;
    if (!Array.isArray(game.troops)) return false;
    if (!game.terrain || !game.terrain.trench || !Array.isArray(game.terrain.trench)) return false;

    // Validate players
    for (const [playerId, player] of Object.entries(game.players)) {
        if (!player || typeof player !== 'object') return false;
        if (typeof player.baseHp !== 'number' || player.baseHp < 0 || player.baseHp > 10000) return false;
        if (typeof player.elixir !== 'number' || player.elixir < 0 || player.elixir > 20) return false;
        if (!validateCoordinates(player.gridX, player.gridY)) return false;
    }

    return true;
}

// Safe number operations
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function safeParseInt(value, defaultValue = 0) {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
}

function safeParseFloat(value, defaultValue = 0) {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
}

// Load AI statistics from file with validation and recovery
function loadAIStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = fs.readFileSync(STATS_FILE, 'utf8');
            const stats = JSON.parse(data);

            // Validate and repair stats structure
            if (!stats || typeof stats !== 'object') {
                throw new Error('Invalid stats structure');
            }

            // Ensure all required fields exist with defaults
            const defaultStats = {
                totalGames: 0,
                wins: 0,
                losses: 0,
                cardUsage: {},
                strategyStats: {
                    defensivePlays: { count: 0, winRate: 0 },
                    offensivePlays: { count: 0, winRate: 0 },
                    earlyGame: { count: 0, winRate: 0 },
                    lateGame: { count: 0, winRate: 0 }
                },
                gameHistory: []
            };

            // Merge with defaults to ensure all fields exist
            const repairedStats = {
                totalGames: safeParseInt(stats.totalGames, 0),
                wins: safeParseInt(stats.wins, 0),
                losses: safeParseInt(stats.losses, 0),
                cardUsage: stats.cardUsage && typeof stats.cardUsage === 'object' ? stats.cardUsage : {},
                strategyStats: {
                    defensivePlays: stats.strategyStats?.defensivePlays || defaultStats.strategyStats.defensivePlays,
                    offensivePlays: stats.strategyStats?.offensivePlays || defaultStats.strategyStats.offensivePlays,
                    earlyGame: stats.strategyStats?.earlyGame || defaultStats.strategyStats.earlyGame,
                    lateGame: stats.strategyStats?.lateGame || defaultStats.strategyStats.lateGame
                },
                gameHistory: Array.isArray(stats.gameHistory) ? stats.gameHistory : []
            };

            // Validate win rates are between 0 and 1
            ['defensivePlays', 'offensivePlays', 'earlyGame', 'lateGame'].forEach(key => {
                const stat = repairedStats.strategyStats[key];
                if (stat.winRate < 0 || stat.winRate > 1 || isNaN(stat.winRate)) {
                    stat.winRate = 0;
                }
                if (stat.count < 0 || isNaN(stat.count)) {
                    stat.count = 0;
                }
            });

            // Validate card usage stats
            for (const cardId in repairedStats.cardUsage) {
                const cardStat = repairedStats.cardUsage[cardId];
                if (!cardStat || typeof cardStat !== 'object') {
                    delete repairedStats.cardUsage[cardId];
                    continue;
                }
                cardStat.played = safeParseInt(cardStat.played, 0);
                cardStat.wins = safeParseInt(cardStat.wins, 0);
                cardStat.losses = safeParseInt(cardStat.losses, 0);
                cardStat.avgDamage = safeParseFloat(cardStat.avgDamage, 0);
            }

            // Ensure totalGames matches wins + losses (approximately)
            if (repairedStats.totalGames < repairedStats.wins + repairedStats.losses) {
                repairedStats.totalGames = repairedStats.wins + repairedStats.losses;
            }

            return repairedStats;
        }
    } catch (error) {
        console.error('Error loading AI stats:', error);
        // Backup corrupted file
        try {
            if (fs.existsSync(STATS_FILE)) {
                const backupPath = `${STATS_FILE}.backup.${Date.now()}`;
                fs.copyFileSync(STATS_FILE, backupPath);
                console.log(`Backed up corrupted stats file to ${backupPath}`);
            }
        } catch (backupError) {
            console.error('Failed to backup corrupted stats file:', backupError);
        }
    }

    // Default statistics structure
    return {
        totalGames: 0,
        wins: 0,
        losses: 0,
        cardUsage: {},
        strategyStats: {
            defensivePlays: { count: 0, winRate: 0 },
            offensivePlays: { count: 0, winRate: 0 },
            earlyGame: { count: 0, winRate: 0 },
            lateGame: { count: 0, winRate: 0 }
        },
        gameHistory: []
    };
}

// Save AI statistics to file with atomic write and error handling
function saveAIStats(stats) {
    try {
        if (!stats || typeof stats !== 'object') {
            console.error('Invalid stats object provided to saveAIStats');
            return;
        }

        // Keep only last 100 games in history
        if (Array.isArray(stats.gameHistory) && stats.gameHistory.length > 100) {
            stats.gameHistory = stats.gameHistory.slice(-100);
        }

        // Validate stats before saving
        const statsToSave = {
            totalGames: Math.max(0, safeParseInt(stats.totalGames, 0)),
            wins: Math.max(0, safeParseInt(stats.wins, 0)),
            losses: Math.max(0, safeParseInt(stats.losses, 0)),
            cardUsage: stats.cardUsage && typeof stats.cardUsage === 'object' ? stats.cardUsage : {},
            strategyStats: {
                defensivePlays: {
                    count: Math.max(0, safeParseInt(stats.strategyStats?.defensivePlays?.count, 0)),
                    winRate: clamp(safeParseFloat(stats.strategyStats?.defensivePlays?.winRate, 0), 0, 1)
                },
                offensivePlays: {
                    count: Math.max(0, safeParseInt(stats.strategyStats?.offensivePlays?.count, 0)),
                    winRate: clamp(safeParseFloat(stats.strategyStats?.offensivePlays?.winRate, 0), 0, 1)
                },
                earlyGame: {
                    count: Math.max(0, safeParseInt(stats.strategyStats?.earlyGame?.count, 0)),
                    winRate: clamp(safeParseFloat(stats.strategyStats?.earlyGame?.winRate, 0), 0, 1)
                },
                lateGame: {
                    count: Math.max(0, safeParseInt(stats.strategyStats?.lateGame?.count, 0)),
                    winRate: clamp(safeParseFloat(stats.strategyStats?.lateGame?.winRate, 0), 0, 1)
                }
            },
            gameHistory: Array.isArray(stats.gameHistory) ? stats.gameHistory : []
        };

        // Atomic write: write to temp file first, then rename
        const tempFile = `${STATS_FILE}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(statsToSave, null, 2), 'utf8');
        fs.renameSync(tempFile, STATS_FILE);
    } catch (error) {
        console.error('Error saving AI stats:', error);
        // Try to clean up temp file if it exists
        try {
            const tempFile = `${STATS_FILE}.tmp`;
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        } catch (cleanupError) {
            console.error('Error cleaning up temp stats file:', cleanupError);
        }
    }
}

// Initialize AI statistics
let aiStats = loadAIStats();
console.log(`Loaded AI statistics: ${aiStats.totalGames} games, ${aiStats.wins} wins, ${aiStats.losses} losses`);

// ============================================================================
// TensorFlow ML Model Loading and Inference
// ============================================================================

let mlModel = null;

// Load TensorFlow model from ml_model.json
async function loadMLModel() {
    try {
        if (!fs.existsSync(ML_MODEL_FILE)) {
            console.log('⚠️ ML model file not found. Model will be initialized on first training.');
            return null;
        }

        const modelData = JSON.parse(fs.readFileSync(ML_MODEL_FILE, 'utf8'));
        
        if (!modelData.weights || modelData.weights.length === 0) {
            console.log('⚠️ No weights in ML model file.');
            return null;
        }

        // Build the model architecture based on weight shapes
        const model = tf.sequential();
        
        // Input layer -> Hidden layer 1 (17 -> 32)
        model.add(tf.layers.dense({
            units: 32,
            activation: 'relu',
            inputShape: [17]
        }));
        
        // Hidden layer 1 -> Hidden layer 2 (32 -> 16)
        model.add(tf.layers.dense({
            units: 16,
            activation: 'relu'
        }));
        
        // Output layer (16 -> 1)
        model.add(tf.layers.dense({
            units: 1,
            activation: 'sigmoid'
        }));

        // Load weights from the JSON file
        const weightTensors = [];
        for (const weightData of modelData.weights) {
            const tensor = tf.tensor(weightData.values, weightData.shape);
            weightTensors.push(tensor);
        }
        
        model.setWeights(weightTensors);
        
        console.log('✅ TensorFlow model loaded successfully');
        return model;
    } catch (error) {
        console.error('❌ Error loading ML model:', error);
        return null;
    }
}

// Extract 17 features from game state for ML prediction
function extractGameFeatures(game, aiPlayer, card, targetBase = null) {
    const enemies = Object.values(game.players).filter(p => p.id !== aiPlayer.id && !p.eliminated);
    const myTroops = game.troops.filter(t => t.ownerId === aiPlayer.id);
    const enemyTroops = game.troops.filter(t => t.ownerId !== aiPlayer.id);
    
    // Normalize values to 0-1 range
    const features = [
        aiPlayer.baseHp / 1000,                                      // 0: My base HP (0-1)
        aiPlayer.elixir / 15,                                        // 1: My elixir (0-1)
        card.cost / 15,                                               // 2: Card cost (0-1)
        card.hp / 2000,                                               // 3: Card HP (normalized)
        card.damage / 500,                                            // 4: Card damage (normalized)
        card.speed / 10,                                              // 5: Card speed (normalized)
        card.range / 9,                                               // 6: Card range (normalized)
        card.type === 'offense' ? 1 : 0,                             // 7: Is offensive
        myTroops.length / 30,                                         // 8: My troop count (normalized)
        myTroops.filter(t => t.type === 'offense').length / 20,     // 9: My offensive troops
        myTroops.filter(t => t.type === 'defense').length / 10,     // 10: My defensive troops
        enemyTroops.length / 30,                                      // 11: Enemy troop count
        enemies.length > 0 ? (enemies[0].baseHp / 1000) : 0,        // 12: Primary enemy HP
        targetBase ? (targetBase.baseHp / 1000) : 0,                 // 13: Target base HP
        game.turnNumber / 200,                                        // 14: Game phase (normalized)
        (Date.now() - game.gameStartTime) / 600000,                  // 15: Game duration (0-10min)
        enemyTroops.filter(t => {                                     // 16: Nearby threats
            const dist = Math.abs(t.gridX - aiPlayer.gridX) + Math.abs(t.gridY - aiPlayer.gridY);
            return dist < 8;
        }).length / 10
    ];
    
    return features;
}

// Use ML model to predict card score
async function predictCardScore(game, aiPlayer, card, targetBase = null) {
    if (!mlModel) {
        // Fallback to stats-based scoring if model not loaded
        const stats = aiStats.cardUsage ? aiStats.cardUsage[card.id] : null;
        if (stats && stats.played >= 3) {
            return stats.wins / (stats.wins + stats.losses);
        }
        return 0.5;
    }

    try {
        const features = extractGameFeatures(game, aiPlayer, card, targetBase);
        const inputTensor = tf.tensor2d([features], [1, 17]);
        const prediction = mlModel.predict(inputTensor);
        const score = (await prediction.data())[0];
        
        // Cleanup tensors
        inputTensor.dispose();
        prediction.dispose();
        
        return score;
    } catch (error) {
        console.error('Error predicting card score:', error);
        return 0.5;
    }
}

// Save TensorFlow model weights to ml_model.json
async function saveMLModel() {
    try {
        if (!mlModel) {
            console.log('⚠️ No model to save');
            return;
        }

        const weights = mlModel.getWeights();
        const weightsData = [];
        
        for (const weight of weights) {
            const values = await weight.data();
            weightsData.push({
                shape: weight.shape,
                values: Array.from(values)
            });
        }

        // Load existing metadata
        let modelData = {};
        if (fs.existsSync(ML_MODEL_FILE)) {
            modelData = JSON.parse(fs.readFileSync(ML_MODEL_FILE, 'utf8'));
        }

        // Update with new weights
        modelData.weights = weightsData;
        modelData.lastUpdated = Date.now();

        fs.writeFileSync(ML_MODEL_FILE, JSON.stringify(modelData, null, 2), 'utf8');
        console.log('✅ Model weights saved to ml_model.json');
    } catch (error) {
        console.error('❌ Error saving ML model:', error);
    }
}

// Train the TensorFlow model with collected game data
async function trainMLModelWithData(trainingData) {
    try {
        if (!mlModel) {
            console.log('⚠️ Creating new model for training...');
            // Create new model if not loaded
            mlModel = tf.sequential();
            mlModel.add(tf.layers.dense({ units: 32, activation: 'relu', inputShape: [17] }));
            mlModel.add(tf.layers.dense({ units: 16, activation: 'relu' }));
            mlModel.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
        }

        // Compile model
        mlModel.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'binaryCrossentropy',
            metrics: ['accuracy']
        });

        // Convert training data to tensors
        const features = trainingData.map(d => d.features);
        const labels = trainingData.map(d => d.label);

        const xs = tf.tensor2d(features);
        const ys = tf.tensor2d(labels, [labels.length, 1]);

        // Train the model
        console.log(`🧠 Training model with ${trainingData.length} samples...`);
        const history = await mlModel.fit(xs, ys, {
            epochs: 10,
            batchSize: 32,
            verbose: 0,
            validationSplit: 0.2
        });

        const finalLoss = history.history.loss[history.history.loss.length - 1];
        const finalAcc = history.history.acc ? history.history.acc[history.history.acc.length - 1] : 0;
        
        console.log(`✅ Training complete - Loss: ${finalLoss.toFixed(4)}, Accuracy: ${(finalAcc * 100).toFixed(1)}%`);

        // Cleanup tensors
        xs.dispose();
        ys.dispose();

        // Save updated weights
        await saveMLModel();

        return { loss: finalLoss, accuracy: finalAcc };
    } catch (error) {
        console.error('❌ Error training model:', error);
        return { loss: 0, accuracy: 0 };
    }
}

// Initialize ML model on startup
loadMLModel().then(model => {
    mlModel = model;
}).catch(err => {
    console.error('Failed to initialize ML model:', err);
});

// Record game outcome and update statistics
function recordGameOutcome(gameId, winner) {
    const game = games[gameId];
    if (!game) return;

    const gameDuration = game.gameStartTime ? (Date.now() - game.gameStartTime) / 1000 : 0;
    const isEarlyGame = gameDuration < 120; // Less than 2 minutes
    const isLateGame = gameDuration > 300; // More than 5 minutes

    // Process each AI player's performance
    Object.values(game.players).forEach(player => {
        if (!player.isAI) return;

        const isWinner = winner && winner.id === player.id;
        const cardUsage = game.cardUsage[player.id] || {};

        // Update overall stats
        aiStats.totalGames++;
        if (isWinner) {
            aiStats.wins++;
        } else {
            aiStats.losses++;
        }

        // Update card usage statistics
        Object.keys(cardUsage).forEach(cardId => {
            if (!aiStats.cardUsage[cardId]) {
                aiStats.cardUsage[cardId] = { played: 0, wins: 0, losses: 0, avgDamage: 0 };
            }

            const count = cardUsage[cardId];
            aiStats.cardUsage[cardId].played += count;

            if (isWinner) {
                aiStats.cardUsage[cardId].wins += count;
            } else {
                aiStats.cardUsage[cardId].losses += count;
            }
        });

        // Update strategy statistics
        const defensiveCount = Object.keys(cardUsage).reduce((sum, cardId) => {
            const card = CARDS.find(c => c.id === cardId);
            return sum + (card && card.type === 'defense' ? cardUsage[cardId] : 0);
        }, 0);

        const offensiveCount = Object.keys(cardUsage).reduce((sum, cardId) => {
            const card = CARDS.find(c => c.id === cardId);
            return sum + (card && card.type === 'offense' ? cardUsage[cardId] : 0);
        }, 0);

        if (defensiveCount > offensiveCount) {
            aiStats.strategyStats.defensivePlays.count++;
            if (isWinner) {
                aiStats.strategyStats.defensivePlays.winRate =
                    (aiStats.strategyStats.defensivePlays.winRate * (aiStats.strategyStats.defensivePlays.count - 1) + 1) /
                    aiStats.strategyStats.defensivePlays.count;
            } else {
                aiStats.strategyStats.defensivePlays.winRate =
                    (aiStats.strategyStats.defensivePlays.winRate * (aiStats.strategyStats.defensivePlays.count - 1)) /
                    aiStats.strategyStats.defensivePlays.count;
            }
        } else if (offensiveCount > defensiveCount) {
            aiStats.strategyStats.offensivePlays.count++;
            if (isWinner) {
                aiStats.strategyStats.offensivePlays.winRate =
                    (aiStats.strategyStats.offensivePlays.winRate * (aiStats.strategyStats.offensivePlays.count - 1) + 1) /
                    aiStats.strategyStats.offensivePlays.count;
            } else {
                aiStats.strategyStats.offensivePlays.winRate =
                    (aiStats.strategyStats.offensivePlays.winRate * (aiStats.strategyStats.offensivePlays.count - 1)) /
                    aiStats.strategyStats.offensivePlays.count;
            }
        }

        if (isEarlyGame) {
            aiStats.strategyStats.earlyGame.count++;
            if (isWinner) aiStats.strategyStats.earlyGame.winRate =
                (aiStats.strategyStats.earlyGame.winRate * (aiStats.strategyStats.earlyGame.count - 1) + 1) /
                aiStats.strategyStats.earlyGame.count;
            else aiStats.strategyStats.earlyGame.winRate =
                (aiStats.strategyStats.earlyGame.winRate * (aiStats.strategyStats.earlyGame.count - 1)) /
                aiStats.strategyStats.earlyGame.count;
        }

        if (isLateGame) {
            aiStats.strategyStats.lateGame.count++;
            if (isWinner) aiStats.strategyStats.lateGame.winRate =
                (aiStats.strategyStats.lateGame.winRate * (aiStats.strategyStats.lateGame.count - 1) + 1) /
                aiStats.strategyStats.lateGame.count;
            else aiStats.strategyStats.lateGame.winRate =
                (aiStats.strategyStats.lateGame.winRate * (aiStats.strategyStats.lateGame.count - 1)) /
                aiStats.strategyStats.lateGame.count;
        }
    });

    // Record game history
    aiStats.gameHistory.push({
        gameId,
        timestamp: Date.now(),
        duration: gameDuration,
        winner: winner ? winner.id : null,
        players: Object.keys(game.players).length,
        cardUsage: game.cardUsage
    });

    // Save statistics
        saveAIStats(aiStats);
    console.log(`📊 Updated AI statistics: ${aiStats.wins}/${aiStats.totalGames} wins (${((aiStats.wins / aiStats.totalGames) * 100).toFixed(1)}% win rate)`);

}

// Game State
const games = {};

// Grid configuration
const GRID_SIZE = 40; // 40x40 grid
const CELL_SIZE = 50; // 50px per cell = 1000x1000 map
const TURN_DURATION = 30; // 30 seconds per turn

// Calculate win probability for AI players based on statistics and game state
function calculateWinProbability(game, playerId) {
    // Validate inputs
    if (!game || !playerId || !game.players) return null;

    const player = game.players[playerId];
    if (!player || !player.isAI) return null;

    // Validate player stats
    if (typeof player.baseHp !== 'number' || isNaN(player.baseHp) || player.baseHp < 0) {
        player.baseHp = clamp(player.baseHp || 0, 0, 10000);
    }

    if (!Array.isArray(player.hand)) {
        player.hand = [];
    }

    let winProb = 0.5; // Base 50% chance
    let factors = [];

    // Factor 1: Overall win rate
    if (aiStats && aiStats.totalGames > 0) {
        const overallWinRate = clamp(aiStats.wins / aiStats.totalGames, 0, 1);
        winProb = overallWinRate;
        factors.push({ name: 'Overall Win Rate', value: (overallWinRate * 100).toFixed(1) + '%' });
    }

    // Factor 2: Current HP status
    const maxHp = 1000;
    const hpPercent = clamp(player.baseHp / maxHp, 0, 1);
    const hpFactor = hpPercent * 0.3; // 30% weight
    winProb = winProb * 0.7 + hpFactor;
    factors.push({ name: 'Base HP', value: Math.ceil(clamp(player.baseHp, 0, maxHp)) + '/' + maxHp });

    // Factor 3: Troop count advantage
    if (Array.isArray(game.troops)) {
        const myTroops = game.troops.filter(t => t && t.ownerId === playerId).length;
        const enemyTroops = game.troops.filter(t =>
            t && t.ownerId &&
            t.ownerId !== playerId &&
            game.players[t.ownerId] &&
            !game.players[t.ownerId].eliminated
        ).length;
        const totalTroops = myTroops + enemyTroops;
        if (totalTroops > 0) {
            const troopAdvantage = clamp(myTroops / totalTroops, 0, 1);
            winProb = winProb * 0.8 + troopAdvantage * 0.2;
            factors.push({ name: 'Troop Count', value: `${myTroops} vs ${enemyTroops}` });
        }
    }

    // Factor 4: Card win rates in hand
    if (player.hand && player.hand.length > 0 && aiStats && aiStats.cardUsage) {
        const handWinRates = player.hand
            .filter(card => card && card.id)
            .map(card => {
                const stats = aiStats.cardUsage[card.id];
                if (stats && stats.played >= 3 && (stats.wins + stats.losses) > 0) {
                    return clamp(stats.wins / (stats.wins + stats.losses), 0, 1);
                }
                return 0.5;
            });

        if (handWinRates.length > 0) {
            const avgHandWinRate = clamp(
                handWinRates.reduce((a, b) => a + b, 0) / handWinRates.length,
                0, 1
            );
            winProb = winProb * 0.85 + avgHandWinRate * 0.15;
            factors.push({ name: 'Hand Quality', value: (avgHandWinRate * 100).toFixed(1) + '%' });
        }
    }

    // Factor 5: Strategy win rate (defensive vs offensive)
    if (Array.isArray(game.troops) && aiStats && aiStats.strategyStats) {
        const myDefensiveTroops = game.troops.filter(t => t && t.ownerId === playerId && t.type === 'defense').length;
        const myOffensiveTroops = game.troops.filter(t => t && t.ownerId === playerId && t.type === 'offense').length;

        if (myDefensiveTroops > myOffensiveTroops) {
            const defensiveWinRate = aiStats.strategyStats.defensivePlays && aiStats.strategyStats.defensivePlays.count > 0
                ? clamp(aiStats.strategyStats.defensivePlays.winRate || 0.5, 0, 1)
                : 0.5;
            winProb = winProb * 0.9 + defensiveWinRate * 0.1;
            factors.push({ name: 'Strategy', value: 'Defensive (' + (defensiveWinRate * 100).toFixed(1) + '%)' });
        } else {
            const offensiveWinRate = aiStats.strategyStats.offensivePlays && aiStats.strategyStats.offensivePlays.count > 0
                ? clamp(aiStats.strategyStats.offensivePlays.winRate || 0.5, 0, 1)
                : 0.5;
            winProb = winProb * 0.9 + offensiveWinRate * 0.1;
            factors.push({ name: 'Strategy', value: 'Offensive (' + (offensiveWinRate * 100).toFixed(1) + '%)' });
        }
    }

    // Factor 6: Game phase
    if (aiStats && aiStats.strategyStats) {
        const gameDuration = game.gameStartTime ? Math.max(0, (Date.now() - game.gameStartTime) / 1000) : 0;
        if (gameDuration < 120) {
            const earlyWinRate = aiStats.strategyStats.earlyGame && aiStats.strategyStats.earlyGame.count > 0
                ? clamp(aiStats.strategyStats.earlyGame.winRate || 0.5, 0, 1)
                : 0.5;
            winProb = winProb * 0.95 + earlyWinRate * 0.05;
            factors.push({ name: 'Game Phase', value: 'Early Game' });
        } else if (gameDuration > 300) {
            const lateWinRate = aiStats.strategyStats.lateGame && aiStats.strategyStats.lateGame.count > 0
                ? clamp(aiStats.strategyStats.lateGame.winRate || 0.5, 0, 1)
                : 0.5;
            winProb = winProb * 0.95 + lateWinRate * 0.05;
            factors.push({ name: 'Game Phase', value: 'Late Game' });
        }
    }

    // Clamp between 0 and 1
    winProb = clamp(winProb, 0, 1);

    return {
        probability: winProb,
        percentage: (winProb * 100).toFixed(1),
        factors: factors
    };
}

// Helper function to serialize game state (convert Sets to arrays)
function serializeGameState(game) {
    const serialized = {
        ...game,
        movedTroops: Array.from(game.movedTroops || []),
        aiWinProbabilities: {}
    };

    // Calculate win probabilities for all AI players
    if (game.status === 'playing') {
        Object.keys(game.players).forEach(playerId => {
            const player = game.players[playerId];
            if (player && player.isAI) {
                serialized.aiWinProbabilities[playerId] = calculateWinProbability(game, playerId);
            }
        });
    }

    return serialized;
}

// AI Player Logic - Makes AI play intelligently
// AI Player Logic - Makes AI play intelligently
async function makeAIMoves(gameId, aiPlayerId) {
    const game = games[gameId];
    if (!game || game.status !== 'playing') return 0;

    const aiPlayer = game.players[aiPlayerId];
    if (!aiPlayer || aiPlayer.eliminated || !aiPlayer.isAI) return 0;

    // When ML mode is enabled, we make the bot more decisive and strategic:
    // - rely more on statistics (less randomness)
    // - allow a bit more actions per turn
    // - be more willing to spend elixir when it has a good play
    const mlMode = !!(game.useMLAI || aiPlayer.useMLAI);

    // Analyze Game State
    const enemies = Object.values(game.players).filter(p => p.id !== aiPlayerId && !p.eliminated);
    if (enemies.length === 0) return 0;

    // 1. Threat Assessment - Only consider close threats (within 6 cells)
    const incomingThreats = game.troops.filter(t =>
        t.ownerId !== aiPlayerId &&
        !game.players[t.ownerId].eliminated &&
        (Math.abs(t.gridX - aiPlayer.gridX) + Math.abs(t.gridY - aiPlayer.gridY)) < 6 // Within 6 cells (reduced from 10)
    );

    // Sort threats by proximity
    incomingThreats.sort((a, b) => {
        const distA = Math.abs(a.gridX - aiPlayer.gridX) + Math.abs(a.gridY - aiPlayer.gridY);
        const distB = Math.abs(b.gridX - aiPlayer.gridX) + Math.abs(b.gridY - aiPlayer.gridY);
        return distA - distB;
    });

    const primaryThreat = incomingThreats.length > 0 ? incomingThreats[0] : null;
    const isUnderAttack = incomingThreats.length > 0;

    // 2. Elixir Management - ML is much more aggressive
    // ML bot: very aggressive, spends quickly
    // Baseline: more conservative, waits for resources
    const safeElixirThreshold = mlMode ? 3 : 6;
    if (!isUnderAttack && aiPlayer.elixir < safeElixirThreshold) {
        return 0;
    }

    let movesThisTurn = 0;
    const maxMovesPerTurn = mlMode ? 10 : 4;

    while (aiPlayer.elixir >= 2 && movesThisTurn < maxMovesPerTurn) {
        // Re-evaluate threats each loop iteration
        const affordableCards = aiPlayer.hand.filter(c => c.cost <= aiPlayer.elixir);
        if (affordableCards.length === 0) break;

        let selectedCard = null;
        let spawnGridX = aiPlayer.gridX;
        let spawnGridY = aiPlayer.gridY;
        let targetBaseId = null;
        let moveType = 'offense';

        // Count current hand composition for balance
        const offensiveCards = affordableCards.filter(c => c.type === 'offense');
        const defensiveCards = affordableCards.filter(c => c.type === 'defense');

        // Count deployed troops for balance
        const myOffensiveTroops = game.troops.filter(t => t.ownerId === aiPlayerId && t.type === 'offense').length;
        const myDefensiveTroops = game.troops.filter(t => t.ownerId === aiPlayerId && t.type === 'defense').length;

        // Strategic decision using statistics
        // ML mode: 95% strategy / 5% exploration (highly decisive)
        // Normal mode: 60% strategy / 40% exploration (more random)
        const useStrategy = Math.random() < (mlMode ? 0.95 : 0.6);

        // Use statistics to determine if defensive or offensive strategy is better
        const defensiveWinRate = aiStats.strategyStats.defensivePlays.count > 0
            ? aiStats.strategyStats.defensivePlays.winRate
            : 0.5;
        const offensiveWinRate = aiStats.strategyStats.offensivePlays.count > 0
            ? aiStats.strategyStats.offensivePlays.winRate
            : 0.5;

        // Consider game phase
        const gameDuration = game.gameStartTime ? (Date.now() - game.gameStartTime) / 1000 : 0;
        const isEarlyGame = gameDuration < 120;
        const earlyGameWinRate = aiStats.strategyStats.earlyGame.count > 0
            ? aiStats.strategyStats.earlyGame.winRate
            : 0.5;

        const needsDefense = isUnderAttack && (
            myDefensiveTroops < myOffensiveTroops ||
            myDefensiveTroops < 2 ||
            (useStrategy && defensiveWinRate > offensiveWinRate + 0.1) // Stats favor defense
        );
        const needsOffense = !isUnderAttack || (
            myOffensiveTroops < myDefensiveTroops ||
            (useStrategy && offensiveWinRate > defensiveWinRate + 0.1) // Stats favor offense
        );

        if (moveType === 'defense') {
            const defensiveCount = game.troops.filter(t => t.ownerId === aiPlayerId && t.type === 'defense').length;
            if (defensiveCount >= 10) {
                // If cap reached, force offensive move instead
                moveType = 'offense';
                const target = selectStrategicTarget(game, aiPlayer, enemies);
                targetBaseId = target.id;

                // Re-select card for offense
                const offensiveCards = affordableCards.filter(c => c.type === 'offense');
                if (offensiveCards.length > 0) {
                    selectedCard = await selectCardByStats(game, aiPlayer, offensiveCards, 'offense', mlMode, game.players[targetBaseId]);
                } else {
                    // No offensive cards affordable, skip turn
                    return movesThisTurn;
                }
            }
        }

        if (moveType === 'defense') {
            // DEFENSIVE MODE - Use statistics to select best defensive card
            selectedCard = await selectCounterCard(game, aiPlayer, primaryThreat, defensiveCards, mlMode);
            // Also consider stats
            const statsCard = await selectCardByStats(game, aiPlayer, defensiveCards, 'defense', mlMode);
            if (statsCard && Math.random() < 0.6) {
                selectedCard = statsCard; // 60% chance to use stats-based selection
            }
            moveType = 'defense';

            // Defensive positioning
            const defensePos = getSmartDefensePosition(game, aiPlayer, primaryThreat);
            spawnGridX = defensePos.gridX;
            spawnGridY = defensePos.gridY;
        } else if (useStrategy && needsOffense && offensiveCards.length > 0) {
            // OFFENSIVE MODE - Use statistics to select best card
            // If only 2 players remain, always target the enemy base
            const activePlayers = Object.values(game.players).filter(p => p && !p.eliminated);
            if (activePlayers.length === 2 && enemies.length === 1) {
                targetBaseId = enemies[0].id; // Auto-target when only 2 players
            } else {
                const target = selectStrategicTarget(game, aiPlayer, enemies);
                targetBaseId = target.id;
            }

            // Use statistics to select best performing offensive card
            selectedCard = await selectCardByStats(game, aiPlayer, offensiveCards, 'offense', mlMode, game.players[targetBaseId]);
            moveType = 'offense';
        } else {
            // RANDOM MODE (30% of the time) - but still use stats for weighting
            selectedCard = await selectCardByStats(game, aiPlayer, affordableCards, null, mlMode);
            moveType = selectedCard.type === 'defense' ? 'defense' : 'offense';

            if (moveType === 'offense') {
                // If only 2 players remain, always target the enemy base
                const activePlayers = Object.values(game.players).filter(p => p && !p.eliminated);
                if (activePlayers.length === 2 && enemies.length === 1) {
                    targetBaseId = enemies[0].id; // Auto-target when only 2 players
                } else {
                    const target = selectStrategicTarget(game, aiPlayer, enemies);
                    targetBaseId = target.id;
                }
            } else {
                const defensePos = getSmartDefensePosition(game, aiPlayer, primaryThreat);
                spawnGridX = defensePos.gridX;
                spawnGridY = defensePos.gridY;
            }
        }

        if (!selectedCard) break;

        // Update ML "thought" for this AI player so the client can display it
        if (game.useMLAI) {
            if (!game.mlAIInsights) {
                game.mlAIInsights = {};
            }

            let score = 0.5;
            const stats = aiStats && aiStats.cardUsage ? aiStats.cardUsage[selectedCard.id] : null;
            if (stats && (stats.wins + stats.losses) > 0) {
                score = clamp(stats.wins / (stats.wins + stats.losses), 0, 1);
            }

            let reason;
            if (moveType === 'defense') {
                reason = primaryThreat
                    ? `Defending against ${primaryThreat.name || primaryThreat.type || 'threat'}`
                    : 'Strengthening defenses';
            } else if (moveType === 'offense') {
                const targetPlayer = targetBaseId ? game.players[targetBaseId] : null;
                reason = targetPlayer
                    ? `Attacking ${targetPlayer.username || 'enemy base'}`
                    : 'Pushing on offense';
            } else {
                reason = 'Adjusting position';
            }

            game.mlAIInsights[aiPlayerId] = {
                cardId: selectedCard.id,
                cardName: selectedCard.name,
                score,
                moveType,
                targetBaseId,
                reason
            };
        }

        // Execute Move
        aiPlayer.elixir -= selectedCard.cost;

        const troop = {
            id: `troop_${Date.now()}_${Math.random()}`,
            ownerId: aiPlayerId,
            cardId: selectedCard.id,
            name: selectedCard.name,
            type: selectedCard.type, // Keep original type for stats, but behavior might vary
            color: aiPlayer.color,
            gridX: spawnGridX,
            gridY: spawnGridY,
            x: spawnGridX * CELL_SIZE + CELL_SIZE / 2,
            y: spawnGridY * CELL_SIZE + CELL_SIZE / 2,
            hp: selectedCard.hp,
            maxHp: selectedCard.hp,
            damage: selectedCard.damage,
            speed: selectedCard.speed,
            range: selectedCard.range,
            targetBaseId: targetBaseId,
            state: moveType === 'defense' ? 'defending' : 'moving_to_bridge',
            path: null,
            isWall: selectedCard.isWall || false,
            isTurret: selectedCard.isTurret || false
        };

        game.troops.push(troop);

        // Track card usage for statistics
        if (!game.cardUsage[aiPlayerId]) {
            game.cardUsage[aiPlayerId] = {};
        }
        if (!game.cardUsage[aiPlayerId][selectedCard.id]) {
            game.cardUsage[aiPlayerId][selectedCard.id] = 0;
        }
        game.cardUsage[aiPlayerId][selectedCard.id]++;

        // Cycle card
        const cardIndex = aiPlayer.hand.findIndex(c => c.id === selectedCard.id);
        if (cardIndex !== -1) {
            aiPlayer.hand.splice(cardIndex, 1);
        }
        if (aiPlayer.nextCard) {
            aiPlayer.hand.push(aiPlayer.nextCard);
            const defensiveCount = game.troops.filter(t => t.ownerId === aiPlayerId && t.type === 'defense').length;
            aiPlayer.nextCard = getBalancedCard(aiPlayer.hand, defensiveCount);
        }

        movesThisTurn++;

        // If we just spent elixir, we might drop below threshold to continue
        if (aiPlayer.elixir < 2) break;
    }

    return movesThisTurn;
}

// Select card based on historical statistics or ML model
// If mlMode is true, use TensorFlow predictions when available
async function selectCardByStats(game, aiPlayer, availableCards, preferredType, mlMode = false, targetBase = null) {
    if (availableCards.length === 0) return null;

    // Filter by type if specified
    const filteredCards = preferredType
        ? availableCards.filter(c => c.type === preferredType)
        : availableCards;

    if (filteredCards.length === 0) return availableCards[0];

    // Calculate scores for each card
    let cardScores;
    
    if (mlMode && mlModel) {
        // ML MODE: Use TensorFlow model predictions
        cardScores = await Promise.all(filteredCards.map(async (card) => {
            const score = await predictCardScore(game, aiPlayer, card, targetBase);
            
            // Record training data if this is a training game
            if (game.isTrainingGame && game.trainingData) {
                const features = extractGameFeatures(game, aiPlayer, card, targetBase);
                game.trainingData.push({
                    playerId: aiPlayer.id,
                    features: features,
                    cardId: card.id
                });
            }
            
            return { card, score };
        }));
    } else {
        // BASELINE: Use historical statistics
        cardScores = filteredCards.map(card => {
            const stats = aiStats.cardUsage ? aiStats.cardUsage[card.id] : null;
            if (!stats || stats.played < 3) {
                // Not enough data, use base stats
                return { card, score: 0.5 + Math.random() * 0.2 }; // Slight random preference
            }

            const winRate = stats.wins / (stats.wins + stats.losses);
            const confidence = Math.min(stats.played / 20, 1); // More confidence with more data

            // Score based on win rate, weighted by confidence
            const score = winRate * confidence + 0.5 * (1 - confidence);

            return { card, score };
        });
    }

    // Sort by score
    cardScores.sort((a, b) => b.score - a.score);

    if (mlMode) {
        // In ML mode, be extremely decisive:
        // - 95% use best card, 5% use second best (minimal exploration)
        const topCards = cardScores.slice(0, 2);
        const rand = Math.random();

        if (rand < 0.95 && topCards[0]) {
            return topCards[0].card;
        } else if (topCards[1]) {
            return topCards[1].card;
        }

        return topCards[0]?.card || filteredCards[0];
    } else {
        // Baseline: more random selection (50% best, 30% second, 20% third)
        const topCards = cardScores.slice(0, 3);
        const rand = Math.random();

        if (rand < 0.5 && topCards[0]) {
            return topCards[0].card;
        } else if (rand < 0.8 && topCards[1]) {
            return topCards[1].card;
        } else if (topCards[2]) {
            return topCards[2].card;
        }

        return topCards[0]?.card || filteredCards[0];
    }
}

// Select best card to counter a specific threat (with statistics and randomness)
async function selectCounterCard(game, aiPlayer, threat, availableCards, mlMode = false) {
    if (!threat || availableCards.length === 0) {
        // Use statistics-based selection
        return await selectCardByStats(game, aiPlayer, availableCards, null, mlMode) || availableCards[Math.floor(Math.random() * availableCards.length)];
    }

    // 30% chance to use pure statistics (learned from experience)
    if (Math.random() < 0.3) {
        return await selectCardByStats(game, aiPlayer, availableCards, null, mlMode);
    }

    // 30% randomness - same as players would have
    if (Math.random() < 0.3) {
        return availableCards[Math.floor(Math.random() * availableCards.length)];
    }

    // Heuristics (40% of the time) - but weighted by statistics
    const isSwarm = threat.maxHp < 150; // Low HP unit
    const isTank = threat.maxHp > 400; // High HP unit
    const isRanged = threat.range > 1;

    let bestCard = null;
    let bestScore = -Infinity;

    availableCards.forEach(card => {
        let score = 0;

        // DPS vs Tank
        if (isTank) {
            score += card.damage * 2;
        }

        // Splash/Fast vs Swarm
        if (isSwarm) {
            if (card.damage >= threat.hp) score += 50; // One-shot capability
            if (card.speed > 1.5) score += 20; // Fast response
        }

        // Gap close vs Ranged
        if (isRanged) {
            if (card.speed > 2) score += 40; // Fast gap closer
            if (card.hp > 300) score += 30; // Tank the shots
        }

        // Reduced defensive bias
        if (card.type === 'defense') score += 5;

        // Add statistics weight (30% of score from stats)
        const stats = aiStats.cardUsage[card.id];
        if (stats && stats.played >= 3) {
            const winRate = stats.wins / (stats.wins + stats.losses);
            score += (winRate - 0.5) * 30; // Boost score based on win rate
        }

        if (score > bestScore) {
            bestScore = score;
            bestCard = card;
        }
    });

    return bestCard || await selectCardByStats(game, aiPlayer, availableCards, null, mlMode) || availableCards[Math.floor(Math.random() * availableCards.length)];
}

// Strategic target selection
function selectStrategicTarget(game, aiPlayer, enemies) {
    // Filter enemies to only neighboring players or those in allowed 180-degree arc
    const allowedEnemies = enemies.filter(enemy =>
        isNeighboringPlayer(aiPlayer.gridX, aiPlayer.gridY, enemy.gridX, enemy.gridY) ||
        isAllowedDirection(aiPlayer.gridX, aiPlayer.gridY, enemy.gridX, enemy.gridY)
    );

    const validTargets = allowedEnemies.length > 0 ? allowedEnemies : enemies; // Fallback to all if none in arc

    if (validTargets.length === 0) return enemies[0]; // Safety fallback

    // Also consider who is attacking us (revenge/defense) - highest priority
    const attackers = validTargets.filter(e =>
        game.troops.some(t => t.ownerId === e.id && t.targetBaseId === aiPlayer.id)
    );

    if (attackers.length > 0 && Math.random() < 0.7) {
        return attackers[0];
    }

    // More balanced targeting: consider multiple factors, not just weakest
    // Score each target based on threat level, distance, and HP
    const scoredTargets = validTargets.map(enemy => {
        let score = 0;

        // Factor 1: Base HP (weaker = higher priority, but not exclusive)
        score += (1000 - enemy.baseHp) * 0.3;

        // Factor 2: Distance (closer = easier to reach)
        const distance = Math.abs(enemy.gridX - aiPlayer.gridX) + Math.abs(enemy.gridY - aiPlayer.gridY);
        score += (40 - distance) * 0.2;

        // Factor 3: Number of troops attacking them (if many, they're vulnerable)
        const troopsAttacking = game.troops.filter(t => t.targetBaseId === enemy.id && t.ownerId !== aiPlayer.id).length;
        score += troopsAttacking * 10;

        // Factor 4: Random variation to prevent always targeting same player
        score += Math.random() * 50;

        return { enemy, score };
    });

    // Sort by score and pick top candidate (with some randomness)
    scoredTargets.sort((a, b) => b.score - a.score);

    // 80% chance to pick top target, 20% chance to pick from top 2
    if (Math.random() < 0.8 || scoredTargets.length === 1) {
        return scoredTargets[0].enemy;
    } else {
        return scoredTargets[Math.floor(Math.random() * Math.min(2, scoredTargets.length))].enemy;
    }
}

// Smart defensive positioning
function getSmartDefensePosition(game, aiPlayer, threat) {
    const baseX = aiPlayer.gridX;
    const baseY = aiPlayer.gridY;

    if (!threat) return { gridX: baseX, gridY: baseY };

    // Calculate vector from base to threat
    const dx = threat.gridX - baseX;
    const dy = threat.gridY - baseY;

    // Place unit 2-3 tiles out towards the threat
    // Normalize and scale
    const dist = Math.sqrt(dx * dx + dy * dy);
    const scale = Math.min(dist - 1, 3); // Don't place ON the threat, keep distance

    if (dist < 1) return { gridX: baseX, gridY: baseY }; // Threat is on top of us

    const placeX = Math.round(baseX + (dx / dist) * scale);
    const placeY = Math.round(baseY + (dy / dist) * scale);

    // Validate bounds and obstacles
    if (isValidSpawn(game, placeX, placeY)) {
        return { gridX: placeX, gridY: placeY };
    }

    // Fallback: try adjacent to ideal
    const neighbors = [
        { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }
    ];

    for (const n of neighbors) {
        if (isValidSpawn(game, placeX + n.x, placeY + n.y)) {
            return { gridX: placeX + n.x, gridY: placeY + n.y };
        }
    }

    return { gridX: baseX, gridY: baseY };
}

// Check if a position is occupied by any troop
function isPositionOccupied(game, x, y, excludeTroopId = null) {
    if (!game || !game.troops || !Array.isArray(game.troops)) return false;
    return game.troops.some(t =>
        t &&
        t.gridX === x &&
        t.gridY === y &&
        t.id !== excludeTroopId
    );
}

// Find nearest unoccupied position
function findNearestUnoccupiedPosition(game, startX, startY, maxDistance = 5) {
    if (!isPositionOccupied(game, startX, startY)) {
        return { gridX: startX, gridY: startY };
    }

    // Search in expanding radius
    for (let radius = 1; radius <= maxDistance; radius++) {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                // Only check positions on the edge of the radius
                if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

                const x = startX + dx;
                const y = startY + dy;

                // Check bounds
                if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;

                // Check if passable and unoccupied
                const trenchSet = new Set(game.terrain.trench.map(t => `${t.x},${t.y}`));
                if (trenchSet.has(`${x},${y}`)) continue;

                if (!isPositionOccupied(game, x, y)) {
                    return { gridX: x, gridY: y };
                }
            }
        }
    }

    // If no position found, return original (will fail validation)
    return { gridX: startX, gridY: startY };
}

function isValidSpawn(game, x, y) {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return false;
    const trenchSet = new Set(game.terrain.trench.map(t => `${t.x},${t.y}`));
    if (trenchSet.has(`${x},${y}`)) return false;

    // Check if position is occupied by any troop
    if (isPositionOccupied(game, x, y)) return false;

    return true;
}

// Generate X-shaped mountain range with 4 bridges at midpoints + central bridge
function generateTrenchMap() {
    const trench = new Set();
    const bridges = [
        { x: 10, y: 10, name: 'northwest', quadrant: 'nw' },
        { x: 30, y: 10, name: 'northeast', quadrant: 'ne' },
        { x: 10, y: 30, name: 'southwest', quadrant: 'sw' },
        { x: 30, y: 30, name: 'southeast', quadrant: 'se' },
        { x: 20, y: 20, name: 'center1', quadrant: 'center' }, // First central bridge
        { x: 20, y: 20, name: 'center2', quadrant: 'center' }  // Second overlapping central bridge
    ];

    // Create X-shaped mountain range (diagonals) - make it wider
    for (let i = 0; i < GRID_SIZE; i++) {
        // Top-left to bottom-right diagonal (wider mountain)
        trench.add(`${i},${i}`);
        if (i > 0) trench.add(`${i - 1},${i}`);
        if (i < GRID_SIZE - 1) trench.add(`${i + 1},${i}`);

        // Top-right to bottom-left diagonal (wider mountain)
        const rightY = GRID_SIZE - 1 - i;
        trench.add(`${i},${rightY}`);
        if (i > 0) trench.add(`${i - 1},${rightY}`);
        if (i < GRID_SIZE - 1) trench.add(`${i + 1},${rightY}`);
    }

    // Clear central cross-section for full access
    const centerX = 20;
    const centerY = 20;
    const crossWidth = 3; // 3 cells wide for the cross

    // Clear horizontal cross-section (left-right through center)
    for (let x = 0; x < GRID_SIZE; x++) {
        for (let dy = -Math.floor(crossWidth / 2); dy <= Math.floor(crossWidth / 2); dy++) {
            const y = centerY + dy;
            if (y >= 0 && y < GRID_SIZE) {
                trench.delete(`${x},${y}`);
            }
        }
    }

    // Clear vertical cross-section (top-bottom through center)
    for (let y = 0; y < GRID_SIZE; y++) {
        for (let dx = -Math.floor(crossWidth / 2); dx <= Math.floor(crossWidth / 2); dx++) {
            const x = centerX + dx;
            if (x >= 0 && x < GRID_SIZE) {
                trench.delete(`${x},${y}`);
            }
        }
    }

    // Clear passable areas at each bridge location
    bridges.forEach(bridge => {
        // Clear 3x3 area around each bridge
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                trench.delete(`${bridge.x + dx},${bridge.y + dy}`);
            }
        }
    });

    return {
        trench: Array.from(trench).map(s => {
            const [x, y] = s.split(',').map(Number);
            return { x, y };
        }), bridges
    };
}

const CARDS = [
    // OFFENSIVE UNITS (6 total) - Lower HP, high speed and damage (all speeds +1.0)
    { id: 'shark', name: 'Shark', type: 'offense', cost: 4, hp: 180, damage: 50, speed: 5, range: 1, color: '#1E90FF' },
    { id: 'jellyfish', name: 'Jellyfish', type: 'offense', cost: 2, hp: 100, damage: 80, speed: 3, range: 1, color: '#DA70D6' },
    { id: 'trident', name: 'Trident', type: 'offense', cost: 6, hp: 70, damage: 100, speed: 7, range: 2, color: '#FFD700' },
    { id: 'barracuda', name: 'Barracuda', type: 'offense', cost: 3, hp: 130, damage: 40, speed: 6, range: 1, color: '#00CED1' },
    { id: 'orca', name: 'Orca', type: 'offense', cost: 7, hp: 300, damage: 90, speed: 4.6, range: 2, color: '#4B0082' },
    { id: 'mino', name: 'Mino', type: 'offense', cost: 3, hp: 50, damage: 40, speed: 9, range: 1, color: '#FF1493' }, // Extremely fast, meager HP
    { id: 'leviathan', name: 'Leviathan', type: 'offense', cost: 15, hp: 2000, damage: 500, speed: 7, range: 5, color: '#8B00FF', isLegendary: true }, // Legendary: 1% drop rate, better than all other troops combined

    // DEFENSIVE UNITS (6 total) - More expensive, less HP, can move within territory (except walls) (all speeds +1.0)
    { id: 'crab', name: 'Crab', type: 'defense', cost: 5, hp: 300, damage: 20, speed: 3, range: 3, color: '#FF4500', isWall: false },
    { id: 'turtle', name: 'Turtle', type: 'defense', cost: 7, hp: 400, damage: 10, speed: 2.6, range: 4, color: '#32CD32', isWall: false },
    { id: 'coral_wall', name: 'Coral Wall', type: 'defense', cost: 4, hp: 500, damage: 5, speed: 0, range: 2, color: '#F08080', isWall: true }, // Wall: tons of HP, minimal damage (stays 0)
    { id: 'narwhal', name: 'Narwhal', type: 'defense', cost: 6, hp: 250, damage: 45, speed: 2, range: 5, color: '#E0E0E0', isWall: false }, // Long-range archer
    { id: 'sea_urchin', name: 'Sea Urchin', type: 'defense', cost: 5, hp: 300, damage: 25, speed: 2.2, range: 2, color: '#8B4789', isWall: false }, // Spiky defender
    { id: 'turret', name: 'Turret', type: 'defense', cost: 8, hp: 10, damage: 7, speed: 0, range: 9, color: '#FF6B35', isWall: false, isTurret: true } // Stationary long-range turret (3/4 of original range)
];

function createGame(gameId) {
    const terrain = generateTrenchMap();
    return {
        id: gameId,
        players: {}, // socketId -> { id, color, elixir, baseHp, cards, hand }
        troops: [], // { id, ownerId, type, x, y, hp, target }
        status: 'waiting', // waiting, playing, ended
        lastUpdate: Date.now(),
        terrain: terrain,
        currentTurn: null, // socketId of current player
        turnOrder: [], // Array of player socketIds
        turnStartTime: null,
        turnTimeRemaining: TURN_DURATION,
        turnNumber: 0,
        movementMode: 'automatic', // 'automatic' or 'manual'
        movedTroops: new Set(), // Track which troops have moved this turn (for manual mode)
        gameMode: 'turns', // 'turns' or 'live'
        aiPlayerCount: 0, // Number of AI players (0-3)
        roomLeader: null, // Socket ID of the room leader
        cardUsage: {}, // Track card usage per player: { playerId: { cardId: count } }
        gameStartTime: null, // Track when game started
        disconnectedPlayers: {}, // Store disconnected player states: { username: { ...playerData, disconnectTime } }
        // ML / TensorFlow-related flags (used by the client UI)
        useMLAI: false,
        mlModelLastUpdated: null,
        mlAIInsights: {} // { [playerId]: { cardId, cardName, score?, moveType?, targetBaseId?, reason? } }
    };
}

function getRandomHand() {
    const hand = [];
    const offensiveCards = CARDS.filter(c => c.type === 'offense' && !c.isLegendary);
    const defensiveCards = CARDS.filter(c => c.type === 'defense' && !c.isLegendary);

    // Ensure balanced distribution: 2 offensive, 2 defensive
    for (let i = 0; i < 2; i++) {
        hand.push(offensiveCards[Math.floor(Math.random() * offensiveCards.length)]);
        hand.push(defensiveCards[Math.floor(Math.random() * defensiveCards.length)]);
    }

    // Shuffle the hand
    for (let i = hand.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [hand[i], hand[j]] = [hand[j], hand[i]];
    }

    return hand;
}

// Get a balanced random card based on player's current hand
// If defensiveCount is provided and >= 10, only return offensive cards
function getBalancedCard(playerHand, defensiveCount = null) {
    // 1% chance to get the legendary Leviathan
    if (Math.random() < 0.01) {
        const leviathan = CARDS.find(c => c.id === 'leviathan');
        if (leviathan) {
            return leviathan;
        }
    }

    const offensiveCards = CARDS.filter(c => c.type === 'offense' && !c.isLegendary);
    const defensiveCards = CARDS.filter(c => c.type === 'defense' && !c.isLegendary);

    // If defensive limit is reached, only return offensive cards
    if (defensiveCount !== null && defensiveCount >= 10) {
        return offensiveCards[Math.floor(Math.random() * offensiveCards.length)];
    }

    // Count current hand composition
    const offensiveCount = playerHand.filter(c => c.type === 'offense').length;
    const handDefensiveCount = playerHand.filter(c => c.type === 'defense').length;

    // If imbalanced, favor the underrepresented type (70% chance)
    if (offensiveCount > handDefensiveCount && Math.random() < 0.7) {
        return defensiveCards[Math.floor(Math.random() * defensiveCards.length)];
    } else if (handDefensiveCount > offensiveCount && Math.random() < 0.7) {
        return offensiveCards[Math.floor(Math.random() * offensiveCards.length)];
    }

    // Otherwise random
    const regularCards = CARDS.filter(c => !c.isLegendary);
    return regularCards[Math.floor(Math.random() * regularCards.length)];
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Clean up rate limit on disconnect
    socket.on('disconnect', () => {
        rateLimits.delete(socket.id);
        console.log('User disconnected:', socket.id);

        // Find which game the player was in
        for (const gameId in games) {
            const game = games[gameId];
            if (game.players[socket.id]) {
                const player = game.players[socket.id];
                console.log(`Player ${player.username} (${socket.id}) disconnected from game ${gameId}`);

                // Store player state for potential reconnection
                if (game.status === 'playing' || game.status === 'waiting') {
                    game.disconnectedPlayers[player.username] = {
                        ...player,
                        disconnectTime: Date.now()
                    };

                    // Remove from active players
                    delete game.players[socket.id];

                    if (game.status === 'playing') {
                        // In an active game, immediately remove from turn order
                        game.turnOrder = game.turnOrder.filter(id => id !== socket.id);

                        // If it was their turn, advance to next player
                        if (game.currentTurn === socket.id) {
                            nextTurn(gameId);
                        }
                    } else if (game.status === 'waiting') {
                        // In the lobby, reassign room leader if needed so the room doesn't get stuck
                        if (game.roomLeader === socket.id) {
                            const remainingIds = Object.keys(game.players);
                            game.roomLeader = remainingIds.length > 0 ? remainingIds[0] : null;
                        }
                    }

                    io.to(gameId).emit('gameState', serializeGameState(game));
                }
                break;
            }
        }
    });

    socket.on('joinGame', (data) => {
        // Rate limiting
        if (!checkRateLimit(socket.id)) {
            socket.emit('error', 'Too many requests. Please slow down.');
            return;
        }

        // Validate input
        if (!data) {
            socket.emit('error', 'Invalid join request');
            return;
        }

        const gameId = typeof data === 'string' ? data : (data.gameId || '');
        if (!validateGameId(gameId)) {
            socket.emit('error', 'Invalid game ID');
            return;
        }

        // Validate and sanitize username
        let username;
        if (typeof data === 'string') {
            username = `Player${socket.id.substr(0, 4)}`;
        } else {
            const providedUsername = data.username;
            if (providedUsername && validateUsername(providedUsername)) {
                username = sanitizeUsername(providedUsername);
            } else {
                username = sanitizeUsername(providedUsername) || `Player${socket.id.substr(0, 4)}`;
            }
        }

        let game = games[gameId];
        if (!game) {
            game = createGame(gameId);
            games[gameId] = game;
        }

        // Check for reconnection
        if (game.disconnectedPlayers[username]) {
            const savedState = game.disconnectedPlayers[username];
            const timeSinceDisconnect = Date.now() - savedState.disconnectTime;

            // Allow reconnection within 5 minutes
            if (timeSinceDisconnect < 5 * 60 * 1000) {
                console.log(`Player ${username} reconnecting...`);

                // Restore player state with new socket ID
                game.players[socket.id] = {
                    ...savedState,
                    id: socket.id, // Update to new socket ID
                    disconnectTime: undefined
                };

                // Remove from disconnected list
                delete game.disconnectedPlayers[username];

                // Update ownership of troops
                game.troops.forEach(t => {
                    if (t.ownerId === savedState.id) {
                        t.ownerId = socket.id;
                    }
                });

                // Update turn order if game is playing
                if (game.status === 'playing') {
                    // Add back to turn order if not present
                    if (!game.turnOrder.includes(socket.id)) {
                        game.turnOrder.push(socket.id);
                    }
                }

                socket.join(gameId);
                io.to(gameId).emit('gameState', serializeGameState(game));
                socket.emit('playerInfo', game.players[socket.id]);

                // Notify others
                socket.to(gameId).emit('toast', { message: `${username} reconnected!`, type: 'success' });
                return;
            } else {
                // Expired
                delete game.disconnectedPlayers[username];
            }
        }

        // Check if player is already in a game
        if (game.players[socket.id]) {
            socket.emit('error', 'You are already in this game');
            return;
        }

        if (Object.keys(game.players).length >= 4) {
            socket.emit('error', 'Game is full (maximum 4 players)');
            return;
        }

        // Validate game state
        if (!validateGameState(game)) {
            console.error(`Invalid game state for ${gameId}, recreating game`);
            game = createGame(gameId);
            games[gameId] = game;
        }

        // First player becomes room leader and sets initial settings
        if (Object.keys(game.players).length === 0) {
            game.roomLeader = socket.id;
            // Room leader can set these via updateRoomSettings
        }

        // Assign player position/color (midpoints of edges - between X arms)
        const playerCount = Object.keys(game.players).length;
        const positions = [
            { gridX: 20, gridY: 4, color: '#00BFFF' },   // Top (Deep Sky Blue)
            { gridX: 36, gridY: 20, color: '#FF4500' },  // Right (Orange Red)
            { gridX: 20, gridY: 36, color: '#32CD32' },  // Bottom (Lime Green)
            { gridX: 4, gridY: 20, color: '#FFD700' }    // Left (Gold)
        ];

        const playerInfo = positions[playerCount];
        playerInfo.x = playerInfo.gridX * CELL_SIZE + CELL_SIZE / 2;
        playerInfo.y = playerInfo.gridY * CELL_SIZE + CELL_SIZE / 2;

        game.players[socket.id] = {
            id: socket.id,
            username: username,
            ...playerInfo,
            elixir: 8, // Increased starting elixir from 5 to 8 for faster gameplay
            baseHp: 1000,
            hand: getRandomHand(),
            nextCard: null
        };

        // Set nextCard to balance the starting hand
        const initialDefensiveCount = game.troops.filter(t => t.ownerId === socket.id && t.type === 'defense').length;
        game.players[socket.id].nextCard = getBalancedCard(game.players[socket.id].hand, initialDefensiveCount);

        socket.join(gameId);
        io.to(gameId).emit('gameState', serializeGameState(game));
        socket.emit('playerInfo', { id: socket.id, username, ...playerInfo });

        if (Object.keys(game.players).length >= 2) {
            game.turnOrder = Object.keys(game.players);
        }
    });

    socket.on('getAIStats', () => {
        if (!checkRateLimit(socket.id)) return;
        socket.emit('aiStats', aiStats);
    });

    socket.on('updateRoomSettings', ({ gameId, settings }) => {
        // Rate limiting
        if (!checkRateLimit(socket.id)) {
            socket.emit('error', 'Too many requests. Please slow down.');
            return;
        }

        // Validate input
        if (!gameId || !settings) {
            socket.emit('error', 'Missing required parameters');
            return;
        }

        if (!validateGameId(gameId)) {
            socket.emit('error', 'Invalid game ID');
            return;
        }

        const game = games[gameId];
        if (!game) {
            socket.emit('error', 'Game not found');
            return;
        }

        if (game.status !== 'waiting') {
            socket.emit('error', 'Can only change settings while waiting');
            return;
        }

        if (socket.id !== game.roomLeader) {
            socket.emit('error', 'Only the room leader can change settings');
            return;
        }

        if (settings.gameMode) {
            if (settings.gameMode !== 'turns' && settings.gameMode !== 'live') {
                socket.emit('error', 'Invalid game mode');
                return;
            }

            // Don't allow live mode with AI players
            if (settings.gameMode === 'live' && game.aiPlayerCount > 0) {
                socket.emit('error', 'Cannot set live mode with AI players');
                return;
            }
            game.gameMode = settings.gameMode;
        }

        if (settings.movementMode) {
            if (settings.movementMode !== 'automatic' && settings.movementMode !== 'manual') {
                socket.emit('error', 'Invalid movement mode');
                return;
            }
            game.movementMode = settings.movementMode;
        }

        if (typeof settings.aiPlayerCount === 'number') {
            const newAICount = clamp(Math.floor(settings.aiPlayerCount), 0, 3);
            // Don't allow AI players in live mode
            if (game.gameMode === 'live' && newAICount > 0) {
                socket.emit('error', 'Cannot add AI players in live mode');
                return;
            }
            game.aiPlayerCount = newAICount;
        }

        // Toggle TensorFlow / ML-based AI
        if (typeof settings.useMLAI === 'boolean') {
            game.useMLAI = settings.useMLAI;

            if (settings.useMLAI) {
                // When enabling ML, attempt to read the model metadata so the
                // client can display a meaningful "last updated" timestamp.
                try {
                    if (fs.existsSync(ML_MODEL_FILE)) {
                        const raw = fs.readFileSync(ML_MODEL_FILE, 'utf8');
                        const parsed = JSON.parse(raw);
                        if (parsed && typeof parsed.lastUpdated === 'number') {
                            game.mlModelLastUpdated = parsed.lastUpdated;
                        } else {
                            game.mlModelLastUpdated = Date.now();
                        }
                    } else {
                        // Model file not present yet – keep timestamp null so UI shows "Pending training"
                        game.mlModelLastUpdated = null;
                    }
                } catch (err) {
                    console.error('Error reading ML model metadata:', err);
                }
            }
        }

        io.to(gameId).emit('gameState', serializeGameState(game));
    });

    socket.on('forceStart', (gameId) => {
        // Rate limiting
        if (!checkRateLimit(socket.id)) {
            socket.emit('error', 'Too many requests. Please slow down.');
            return;
        }

        // Validate input
        if (!gameId) {
            socket.emit('error', 'Missing game ID');
            return;
        }

        if (!validateGameId(gameId)) {
            socket.emit('error', 'Invalid game ID');
            return;
        }

        const game = games[gameId];
        if (!game) {
            socket.emit('error', 'Game not found');
            return;
        }

        if (game.status !== 'waiting') {
            socket.emit('error', 'Game has already started');
            return;
        }

        // Only room leader or players in the game can start
        if (socket.id !== game.roomLeader && !game.players[socket.id]) {
            socket.emit('error', 'You are not authorized to start this game');
            return;
        }

        const humanPlayerCount = Object.keys(game.players).length;

        // Add AI players if configured
        if (game.aiPlayerCount > 0) {
            const positions = [
                { gridX: 20, gridY: 4, color: '#00BFFF' },   // Top
                { gridX: 36, gridY: 20, color: '#FF4500' },  // Right
                { gridX: 20, gridY: 36, color: '#32CD32' },  // Bottom
                { gridX: 4, gridY: 20, color: '#FFD700' }    // Left
            ];

            for (let i = 0; i < game.aiPlayerCount && (humanPlayerCount + i) < 4; i++) {
                const aiId = `ai_${gameId}_${i}`;
                const playerInfo = positions[humanPlayerCount + i];
                playerInfo.x = playerInfo.gridX * CELL_SIZE + CELL_SIZE / 2;
                playerInfo.y = playerInfo.gridY * CELL_SIZE + CELL_SIZE / 2;

                const aiHand = getRandomHand();
                game.players[aiId] = {
                    id: aiId,
                    username: `AI Bot ${i + 1}`,
                    isAI: true,
                    ...playerInfo,
                    baseHp: 1000,
                    elixir: 8, // Same as humans for fairness - increased from 5 to 8
                    hand: aiHand,
                    nextCard: getBalancedCard(aiHand, 0), // AI starts with 0 defensive units
                    eliminated: false
                };
                console.log(`Added AI Bot ${i + 1} with ${aiHand.length} cards, elixir: 8`);
            }
        }

        const totalPlayers = Object.keys(game.players).length;
        if (totalPlayers >= 2) {
            game.status = 'playing';
            game.gameStartTime = Date.now();
            game.turnOrder = Object.keys(game.players);

            // In live mode, there's no turn order - everyone plays simultaneously
            if (game.gameMode === 'live') {
                game.currentTurn = null; // No turns in live mode
            } else {
                game.currentTurn = game.turnOrder[0];
                game.turnStartTime = Date.now();
                game.turnTimeRemaining = TURN_DURATION;
            }
            game.turnNumber = 1;

            console.log(`Game ${gameId} started in ${game.gameMode} mode. Players:`, totalPlayers);

            startGameLoop(gameId);
            io.to(gameId).emit('gameState', serializeGameState(game));
        }
    });

    socket.on('endTurn', (gameId) => {
        // Rate limiting
        if (!checkRateLimit(socket.id)) {
            socket.emit('error', 'Too many requests. Please slow down.');
            return;
        }

        // Validate input
        if (!gameId) {
            socket.emit('error', 'Missing game ID');
            return;
        }

        if (!validateGameId(gameId)) {
            socket.emit('error', 'Invalid game ID');
            return;
        }

        const game = games[gameId];
        if (!game) {
            socket.emit('error', 'Game not found');
            return;
        }

        if (game.status !== 'playing') {
            socket.emit('error', 'Game is not in progress');
            return;
        }

        if (game.gameMode !== 'turns') {
            socket.emit('error', 'Turn-based mode is not active');
            return;
        }

        if (socket.id !== game.currentTurn) {
            socket.emit('error', 'Not your turn');
            return;
        }

        nextTurn(gameId);
    });

    socket.on('setTarget', ({ gameId, troopId, targetBaseId }) => {
        // Rate limiting
        if (!checkRateLimit(socket.id)) {
            socket.emit('error', 'Too many requests. Please slow down.');
            return;
        }

        // Validate input
        if (!gameId || !troopId || !targetBaseId) {
            socket.emit('error', 'Missing required parameters');
            return;
        }

        if (!validateGameId(gameId)) {
            socket.emit('error', 'Invalid game ID');
            return;
        }

        if (!validateTroopId(troopId)) {
            socket.emit('error', 'Invalid troop ID');
            return;
        }

        const game = games[gameId];
        if (!game) {
            socket.emit('error', 'Game not found');
            return;
        }

        if (game.status !== 'playing') {
            socket.emit('error', 'Game is not in progress');
            return;
        }

        const troop = game.troops.find(t => t.id === troopId);
        if (!troop) {
            socket.emit('error', 'Troop not found');
            return;
        }

        if (troop.ownerId !== socket.id) {
            socket.emit('error', 'You do not own this troop');
            return;
        }

        // Validate target base
        const targetPlayer = game.players[targetBaseId];
        if (!targetPlayer) {
            socket.emit('error', 'Target player not found');
            return;
        }

        if (targetPlayer.eliminated) {
            socket.emit('error', 'Target player has been eliminated');
            return;
        }

        if (targetPlayer.id === socket.id) {
            socket.emit('error', 'Cannot target yourself');
            return;
        }

        // Set the target for this offensive unit
        troop.targetBaseId = targetBaseId;
        troop.state = 'moving_to_bridge';

        io.to(gameId).emit('gameState', serializeGameState(game));
    });

    socket.on('moveTroop', ({ gameId, troopId, targetGridX, targetGridY }) => {
        // Rate limiting
        if (!checkRateLimit(socket.id)) {
            socket.emit('error', 'Too many requests. Please slow down.');
            return;
        }

        // Validate input
        if (!gameId || !troopId || targetGridX === undefined || targetGridY === undefined) {
            socket.emit('error', 'Missing required parameters');
            return;
        }

        if (!validateGameId(gameId)) {
            socket.emit('error', 'Invalid game ID');
            return;
        }

        if (!validateTroopId(troopId)) {
            socket.emit('error', 'Invalid troop ID');
            return;
        }

        if (!validateCoordinates(targetGridX, targetGridY)) {
            socket.emit('error', 'Invalid target coordinates');
            return;
        }

        const game = games[gameId];
        if (!game) {
            socket.emit('error', 'Game not found');
            return;
        }

        if (game.status !== 'playing') {
            socket.emit('error', 'Game is not in progress');
            return;
        }

        if (game.movementMode !== 'manual') {
            socket.emit('error', 'Manual movement is not enabled');
            return;
        }

        if (socket.id !== game.currentTurn) {
            socket.emit('error', 'Not your turn');
            return;
        }

        const troop = game.troops.find(t => t.id === troopId);
        if (!troop) {
            socket.emit('error', 'Troop not found');
            return;
        }

        if (troop.ownerId !== socket.id) {
            socket.emit('error', 'You do not own this troop');
            return;
        }

        // Walls cannot move
        if (troop.isWall) {
            socket.emit('error', 'Walls cannot be moved');
            return;
        }

        // Check if already moved this turn
        if (game.movedTroops.has(troopId)) {
            socket.emit('error', 'This troop has already moved this turn');
            return;
        }

        // Validate move is within speed range
        const distance = Math.abs(troop.gridX - targetGridX) + Math.abs(troop.gridY - targetGridY);
        if (distance > Math.floor(troop.speed)) {
            socket.emit('error', 'Target is out of range');
            return;
        }

        if (distance === 0) {
            socket.emit('error', 'Cannot move to the same position');
            return;
        }

        // Check path is clear (simple validation)
        const trenchSet = new Set(game.terrain.trench.map(t => `${t.x},${t.y}`));
        if (trenchSet.has(`${targetGridX},${targetGridY}`)) {
            socket.emit('error', 'Cannot move to impassable terrain');
            return;
        }

        // Store old position for defensive troop damage check
        const oldGridX = troop.gridX;
        const oldGridY = troop.gridY;

        // Check if moving away from defensive troops and apply damage
        applyDefensiveTroopDamage(game, troop, oldGridX, oldGridY, targetGridX, targetGridY);

        // If troop died from defensive damage, don't move
        const troopStillExists = game.troops.find(t => t.id === troopId);
        if (!troopStillExists) {
            game.movedTroops.add(troopId);
            io.to(gameId).emit('gameState', serializeGameState(game));
            return;
        }

        // Move the troop
        troop.gridX = targetGridX;
        troop.gridY = targetGridY;
        troop.x = targetGridX * CELL_SIZE + CELL_SIZE / 2;
        troop.y = targetGridY * CELL_SIZE + CELL_SIZE / 2;

        // Mark as moved
        game.movedTroops.add(troopId);

        io.to(gameId).emit('gameState', serializeGameState(game));
    });

    socket.on('deployCard', ({ gameId, cardId, gridX, gridY, targetBaseId }) => {
        // Rate limiting
        if (!checkRateLimit(socket.id)) {
            socket.emit('error', 'Too many requests. Please slow down.');
            return;
        }

        // Validate input
        if (!gameId || !cardId) {
            socket.emit('error', 'Missing required parameters');
            return;
        }

        if (!validateGameId(gameId)) {
            socket.emit('error', 'Invalid game ID');
            return;
        }

        if (!validateCardId(cardId)) {
            socket.emit('error', 'Invalid card ID');
            return;
        }

        const game = games[gameId];
        if (!game) {
            socket.emit('error', 'Game not found');
            return;
        }

        if (game.status !== 'playing') {
            socket.emit('error', 'Game is not in progress');
            return;
        }

        // Validate game state
        if (!validateGameState(game)) {
            socket.emit('error', 'Game state is invalid');
            return;
        }

        // In turn mode, only current player can deploy. In live mode, anyone can deploy anytime
        if (game.gameMode === 'turns' && socket.id !== game.currentTurn) {
            socket.emit('error', 'Not your turn');
            return;
        }

        const player = game.players[socket.id];
        if (!player) {
            socket.emit('error', 'You are not in this game');
            return;
        }

        if (player.eliminated) {
            socket.emit('error', 'You have been eliminated');
            return;
        }

        const card = CARDS.find(c => c.id === cardId);
        if (!card) {
            socket.emit('error', 'Card not found');
            return;
        }

        if (player.elixir < card.cost) {
            socket.emit('error', 'Not enough elixir');
            return;
        }

        // Validate coordinates if provided (for defensive units)
        if (card.type === 'defense') {
            if (gridX !== undefined && gridY !== undefined) {
                if (!validateCoordinates(gridX, gridY)) {
                    socket.emit('error', 'Invalid deployment coordinates');
                    return;
                }
            }

            // Check defensive unit cap
            const defensiveCount = game.troops.filter(t => t.ownerId === socket.id && t.type === 'defense').length;
            if (defensiveCount >= 10) {
                socket.emit('error', 'Maximum defensive units reached (10)');
                return;
            }
        }

        // Validate target base for offensive units
        // If only 2 players remain, auto-target the enemy base
        const activePlayers = Object.values(game.players).filter(p => p && !p.eliminated);
        const isTwoPlayerMode = activePlayers.length === 2;

        if (card.type === 'offense') {
            if (isTwoPlayerMode) {
                // Auto-target the only enemy when only 2 players remain
                const enemies = Object.values(game.players).filter(p => p.id !== socket.id && !p.eliminated);
                if (enemies.length === 1) {
                    targetBaseId = enemies[0].id;
                }
            } else if (targetBaseId) {
                const targetPlayer = game.players[targetBaseId];
                if (!targetPlayer || targetPlayer.eliminated || targetPlayer.id === socket.id) {
                    socket.emit('error', 'Invalid target');
                    return;
                }
                // Allow attacks on neighboring players (can always reach via bridges)
                // Only restrict if it's not a neighboring player base
                if (!isNeighboringPlayer(player.gridX, player.gridY, targetPlayer.gridX, targetPlayer.gridY) &&
                    !isAllowedDirection(player.gridX, player.gridY, targetPlayer.gridX, targetPlayer.gridY)) {
                    socket.emit('error', 'Target is not in allowed direction (can only attack sides or opposite)');
                    return;
                }
            }
        }

        // Deduct elixir
        player.elixir -= card.cost;

        // Determine spawn position
        let spawnGridX, spawnGridY;
        let finalSpawnPos;

        if (card.type === 'defense' && gridX !== undefined && gridY !== undefined) {
            // Defensive units can be placed in custom positions within quadrant
            spawnGridX = gridX;
            spawnGridY = gridY;
        } else {
            // Offensive units spawn at base
            spawnGridX = player.gridX;
            spawnGridY = player.gridY;
        }

        // Spawn troop (grid-aligned)
        const troop = {
            id: Math.random().toString(36).substr(2, 9),
            ownerId: socket.id,
            type: card.type,
            name: card.name,
            cardId: card.id,
            hp: card.hp,
            maxHp: card.hp,
            damage: card.damage,
            speed: card.speed,
            range: card.range,
            color: card.color,
            isWall: card.isWall || false,
            isTurret: card.isTurret || false,
            gridX: spawnGridX,
            gridY: spawnGridY,
            x: spawnGridX * CELL_SIZE + CELL_SIZE / 2,
            y: spawnGridY * CELL_SIZE + CELL_SIZE / 2,
            target: null,
            state: card.type === 'defense' ? 'guarding' : 'moving_to_bridge',
            targetBaseId: targetBaseId || null, // Player-selected target
            path: [], // A* pathfinding path
            patrolAngle: Math.random() * Math.PI * 2,
            patrolRadius: 3, // grid cells
            patrolDir: Math.random() > 0.5 ? 1 : -1,
            patrolSpeed: 0.6
        };
        game.troops.push(troop);

        // Track card usage for statistics
        if (!game.cardUsage[socket.id]) {
            game.cardUsage[socket.id] = {};
        }
        if (!game.cardUsage[socket.id][cardId]) {
            game.cardUsage[socket.id][cardId] = 0;
        }
        game.cardUsage[socket.id][cardId]++;

        // Cycle card - use balanced card drawing
        const handIndex = player.hand.findIndex(c => c.id === cardId);
        if (handIndex !== -1) {
            player.hand[handIndex] = player.nextCard;
            // Check defensive count to prevent dealing defensive cards when limit is reached
            const defensiveCount = game.troops.filter(t => t.ownerId === socket.id && t.type === 'defense').length;
            player.nextCard = getBalancedCard(player.hand, defensiveCount);
        }

        io.to(gameId).emit('gameState', serializeGameState(game));
    });

    // Note: additional disconnect handling (game cleanup, AI stats, etc.)
    // is now centralized in this single handler above. Previous duplicate
    // disconnect logic has been removed to avoid conflicting behavior.
});

function isPassable(x, y, trenchSet) {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return false;
    const key = `${x},${y}`;
    return !trenchSet.has(key);
}

// Check if a position is on a bridge (within 3x3 area of any bridge)
function isOnBridge(x, y, bridges) {
    if (!bridges || !Array.isArray(bridges)) return false;
    return bridges.some(bridge => {
        const dx = Math.abs(x - bridge.x);
        const dy = Math.abs(y - bridge.y);
        return dx <= 1 && dy <= 1; // Within 3x3 area
    });
}

// Check if a position is on the central cross-section bridge
function isOnCentralBridge(x, y) {
    const centerX = 20;
    const centerY = 20;
    const crossWidth = 3;

    // Check if on horizontal cross-section
    const onHorizontal = Math.abs(y - centerY) <= Math.floor(crossWidth / 2);
    // Check if on vertical cross-section
    const onVertical = Math.abs(x - centerX) <= Math.floor(crossWidth / 2);

    return onHorizontal || onVertical;
}

// A* pathfinding with bridge preference
function findPath(startX, startY, endX, endY, trenchSet, bridges = null) {
    const openSet = [];
    const closedSet = new Set();
    const cameFrom = new Map();
    const gScore = new Map();
    const fScore = new Map();

    const startKey = `${startX},${startY}`;
    const endKey = `${endX},${endY}`;

    openSet.push({ x: startX, y: startY, key: startKey });
    gScore.set(startKey, 0);
    fScore.set(startKey, heuristic(startX, startY, endX, endY));

    while (openSet.length > 0) {
        // Find node with lowest fScore
        openSet.sort((a, b) => (fScore.get(a.key) || Infinity) - (fScore.get(b.key) || Infinity));
        const current = openSet.shift();

        if (current.key === endKey) {
            // Reconstruct path
            const path = [];
            let curr = endKey;
            while (cameFrom.has(curr)) {
                const [x, y] = curr.split(',').map(Number);
                path.unshift({ x, y });
                curr = cameFrom.get(curr);
            }
            return path;
        }

        closedSet.add(current.key);

        // Check neighbors
        const neighbors = [
            { x: current.x + 1, y: current.y },
            { x: current.x - 1, y: current.y },
            { x: current.x, y: current.y + 1 },
            { x: current.x, y: current.y - 1 }
        ];

        for (const neighbor of neighbors) {
            const neighborKey = `${neighbor.x},${neighbor.y}`;

            if (closedSet.has(neighborKey)) continue;
            if (!isPassable(neighbor.x, neighbor.y, trenchSet)) continue;

            // Calculate base movement cost
            let movementCost = 1;

            // Check if we need to cross a bridge (path crosses from one side to another)
            const needsBridge = needsBridgeCrossing(startX, startY, endX, endY, current.x, current.y, neighbor.x, neighbor.y);

            if (needsBridge) {
                // Strongly prefer bridge tiles when crossing
                const isNeighborOnBridge = bridges ? isOnBridge(neighbor.x, neighbor.y, bridges) : isOnCentralBridge(neighbor.x, neighbor.y);
                const isCurrentOnBridge = bridges ? isOnBridge(current.x, current.y, bridges) : isOnCentralBridge(current.x, current.y);

                if (isNeighborOnBridge) {
                    // Prefer bridge tiles - reduce cost significantly
                    movementCost = 0.5;
                } else if (!isCurrentOnBridge) {
                    // Penalize non-bridge tiles when we should be on a bridge
                    movementCost = 2.0;
                }
            }

            const tentativeGScore = (gScore.get(current.key) || Infinity) + movementCost;

            if (!gScore.has(neighborKey) || tentativeGScore < gScore.get(neighborKey)) {
                cameFrom.set(neighborKey, current.key);
                gScore.set(neighborKey, tentativeGScore);
                fScore.set(neighborKey, tentativeGScore + heuristic(neighbor.x, neighbor.y, endX, endY));

                if (!openSet.find(n => n.key === neighborKey)) {
                    openSet.push({ x: neighbor.x, y: neighbor.y, key: neighborKey });
                }
            }
        }
    }

    return []; // No path found
}

// Check if path needs to cross a bridge (crosses from one quadrant to another)
function needsBridgeCrossing(startX, startY, endX, endY, currentX, currentY, nextX, nextY) {
    // Determine quadrants
    const centerX = GRID_SIZE / 2; // 20
    const centerY = GRID_SIZE / 2; // 20

    // Check if start and end are on opposite sides of the center
    const startSideX = startX < centerX ? 'left' : (startX > centerX ? 'right' : 'center');
    const startSideY = startY < centerY ? 'top' : (startY > centerY ? 'bottom' : 'center');
    const endSideX = endX < centerX ? 'left' : (endX > centerX ? 'right' : 'center');
    const endSideY = endY < centerY ? 'top' : (endY > centerY ? 'bottom' : 'center');

    // If crossing center in X or Y direction, we need a bridge
    const crossingX = (startSideX === 'left' && endSideX === 'right') || (startSideX === 'right' && endSideX === 'left');
    const crossingY = (startSideY === 'top' && endSideY === 'bottom') || (startSideY === 'bottom' && endSideY === 'top');

    // Check if current position is near center and next position crosses center
    const currentNearCenter = Math.abs(currentX - centerX) <= 3 && Math.abs(currentY - centerY) <= 3;
    const nextNearCenter = Math.abs(nextX - centerX) <= 3 && Math.abs(nextY - centerY) <= 3;

    return (crossingX || crossingY) && (currentNearCenter || nextNearCenter);
}

function heuristic(x1, y1, x2, y2) {
    return Math.abs(x1 - x2) + Math.abs(y1 - y2);
}

function nextTurn(gameId) {
    const game = games[gameId];
    if (!game || game.status !== 'playing') return;

    // Validate game state
    if (!validateGameState(game)) {
        console.error(`Invalid game state in nextTurn for ${gameId}`);
        return;
    }

    // Check for winner before proceeding
    const activePlayers = Object.values(game.players).filter(p => p && !p.eliminated);
    if (activePlayers.length <= 1) {
        game.status = 'ended';
        const winner = activePlayers.length === 1 ? activePlayers[0] : null;
        io.to(gameId).emit('gameOver', {
            winner: winner ? winner.id : null,
            winnerName: winner ? winner.username : null
        });
        recordGameOutcome(gameId, winner);
        setTimeout(() => resetGame(gameId), 10000);
        return;
    }

    // Apply combat damage at end of turn
    applyCombatDamage(game, gameId);

    // Check for winner after combat
    const activePlayersAfterCombat = Object.values(game.players).filter(p => p && !p.eliminated);
    if (activePlayersAfterCombat.length <= 1) {
        game.status = 'ended';
        const winner = activePlayersAfterCombat.length === 1 ? activePlayersAfterCombat[0] : null;
        io.to(gameId).emit('gameOver', {
            winner: winner ? winner.id : null,
            winnerName: winner ? winner.username : null
        });
        recordGameOutcome(gameId, winner);
        setTimeout(() => resetGame(gameId), 10000);
        return;
    }

    // Move troops based on their speed
    // In automatic mode: all troops move
    // In manual mode: only AI-owned troops move automatically
    if (game.movementMode === 'automatic') {
        moveTroopsOnTurnEnd(game, false); // Move all troops
    } else {
        moveTroopsOnTurnEnd(game, true); // Move only AI troops
    }

    // Clear moved troops set for new turn
    game.movedTroops = new Set();

    // Validate turn order
    if (!Array.isArray(game.turnOrder) || game.turnOrder.length === 0) {
        console.error(`Invalid turn order for game ${gameId}`);
        game.turnOrder = Object.keys(game.players).filter(id => game.players[id] && !game.players[id].eliminated);
        if (game.turnOrder.length === 0) {
            game.status = 'ended';
            return;
        }
    }

    // Find next active player
    const currentIndex = game.turnOrder.indexOf(game.currentTurn);
    let nextIndex = currentIndex >= 0 ? (currentIndex + 1) % game.turnOrder.length : 0;
    let attempts = 0;
    const maxAttempts = game.turnOrder.length * 2; // Safety limit

    // Skip eliminated players and validate player exists
    while (attempts < maxAttempts) {
        const nextPlayerId = game.turnOrder[nextIndex];
        const nextPlayer = game.players[nextPlayerId];

        if (nextPlayer && !nextPlayer.eliminated) {
            break; // Found valid player
        }

        nextIndex = (nextIndex + 1) % game.turnOrder.length;
        attempts++;
    }

    if (attempts >= maxAttempts) {
        // All players eliminated or invalid state
        console.error(`Could not find next player for game ${gameId}`);
        game.status = 'ended';
        io.to(gameId).emit('gameOver', { winner: null, winnerName: null });
        return;
    }

    game.currentTurn = game.turnOrder[nextIndex];
    game.turnStartTime = Date.now();
    game.turnTimeRemaining = TURN_DURATION;
    game.turnNumber = (game.turnNumber || 0) + 1;

    // Give elixir to the player whose turn it is (same rate for humans and AI)
    const currentPlayer = game.players[game.currentTurn];
    if (currentPlayer) {
        // Validate and clamp elixir
        currentPlayer.elixir = clamp((currentPlayer.elixir || 0) + 6, 0, 15); // Increased from +4 to +6 for faster gameplay

        // If current player is AI, make their moves automatically (instant decisions, smooth animations)
        if (currentPlayer.isAI) {
            console.log(`🤖 AI ${currentPlayer.username}'s turn - Elixir: ${currentPlayer.elixir}, Hand: ${currentPlayer.hand?.length || 0} cards`);
            console.log(`🤖 AI ${currentPlayer.username} is making moves...`);
            
            // Make AI moves asynchronously
            makeAIMoves(gameId, currentPlayer.id).then(movesMade => {
                // AI takes only 100ms per turn for very fast gameplay
                const animationTime = 100;
                console.log(`🤖 AI ${currentPlayer.username} made ${movesMade} moves, waiting ${animationTime}ms`);

                setTimeout(() => {
                    if (games[gameId] && games[gameId].currentTurn === currentPlayer.id) {
                        console.log(`🤖 AI ${currentPlayer.username} ending turn`);
                        nextTurn(gameId);
                    }
                }, animationTime);
            }).catch(err => {
                console.error(`Error in AI moves for ${currentPlayer.username}:`, err);
                // Still advance turn on error
                setTimeout(() => nextTurn(gameId), 100);
            });
        }
    }

    io.to(gameId).emit('gameState', serializeGameState(game));
}

function applyCombatDamage(game, gameId) {
    const combatEvents = []; // { type: 'attack'|'death', attackerId, targetId, damage, x, y }

    // Combat happens at end of turn
    game.troops.forEach(troop => {
        // Check if troop is attacking an enemy base
        if (troop.targetBaseId) {
            const targetBase = game.players[troop.targetBaseId];
            if (targetBase && !targetBase.eliminated) {
                const dist = Math.abs(targetBase.gridX - troop.gridX) + Math.abs(targetBase.gridY - troop.gridY);

                // If adjacent to base, deal damage
                if (dist <= troop.range + 1) {
                    targetBase.baseHp -= troop.damage;

                    if (targetBase.baseHp <= 0) {
                        targetBase.baseHp = 0;
                        targetBase.eliminated = true;
                        io.to(gameId).emit('gameOver', { winner: null, eliminated: troop.targetBaseId });

                        // Check for winner
                        const activePlayers = Object.values(game.players).filter(p => !p.eliminated);
                        if (activePlayers.length === 1 && Object.keys(game.players).length > 1) {
                            game.status = 'ended';
                            const winner = activePlayers[0];
                            io.to(gameId).emit('gameOver', { winner: winner.id, winnerName: winner.username });

                            // Record game outcome for AI learning
                            recordGameOutcome(gameId, winner);

                            // Reset room after 10 seconds
                            setTimeout(() => {
                                resetGame(gameId);
                            }, 10000);
                        }
                    }
                }
            }
        }

        // Check for troop vs troop combat
        game.troops.forEach(other => {
            if (other.ownerId === troop.ownerId) return;

            const dist = Math.abs(other.gridX - troop.gridX) + Math.abs(other.gridY - troop.gridY);
            if (dist <= troop.range) {
                other.hp -= troop.damage;

                // Special handling for turrets - emit projectile event
                if (troop.isTurret) {
                    combatEvents.push({
                        type: 'projectile',
                        attackerId: troop.id,
                        targetId: other.id,
                        damage: troop.damage,
                        fromX: troop.x,
                        fromY: troop.y,
                        toX: other.x,
                        toY: other.y,
                        isBase: false
                    });
                } else {
                    combatEvents.push({
                        type: 'attack',
                        attackerId: troop.id,
                        targetId: other.id,
                        damage: troop.damage,
                        x: other.x,
                        y: other.y,
                        isBase: false
                    });
                }
            }
        });
    });

    // Remove dead troops and record deaths
    game.troops = game.troops.filter(t => {
        if (t.hp <= 0) {
            combatEvents.push({
                type: 'death',
                targetId: t.id,
                x: t.x,
                y: t.y
            });
            return false;
        }
        return true;
    });

    // Emit combat events if any occurred
    if (combatEvents.length > 0) {
        io.to(gameId).emit('combatEvents', combatEvents);
    }


}

function resetGame(gameId) {
    const game = games[gameId];
    if (game) {
        // Clean up intervals to prevent memory leaks
        if (game.elixirRegenInterval) {
            clearInterval(game.elixirRegenInterval);
            game.elixirRegenInterval = null;
        }

        // Clean up any AI action timeouts
        if (game.aiActionTimeouts) {
            Object.values(game.aiActionTimeouts).forEach(timeout => {
                if (timeout) clearTimeout(timeout);
            });
            game.aiActionTimeouts = {};
        }

        // Notify all players that room is resetting
        io.to(gameId).emit('roomReset');

        // Delete the game to reset it
        delete games[gameId];
        console.log(`Room ${gameId} has been reset`);
    }
}

function getBridgeForPath(fromBase, toBase, bridges) {
    // Determine which bridge to use based on base positions
    // fromBase and toBase have gridX, gridY

    // Determine quadrants
    const fromQuadrant = {
        x: fromBase.gridX < 10 ? 'left' : 'right',
        y: fromBase.gridY < 10 ? 'top' : 'bottom'
    };

    const toQuadrant = {
        x: toBase.gridX < 10 ? 'left' : 'right',
        y: toBase.gridY < 10 ? 'top' : 'bottom'
    };

    // Find appropriate bridge
    if (fromQuadrant.x === 'left' && fromQuadrant.y === 'top') {
        return bridges.find(b => b.quadrant === 'nw'); // Northwest bridge
    } else if (fromQuadrant.x === 'right' && fromQuadrant.y === 'top') {
        return bridges.find(b => b.quadrant === 'ne'); // Northeast bridge
    } else if (fromQuadrant.x === 'left' && fromQuadrant.y === 'bottom') {
        return bridges.find(b => b.quadrant === 'sw'); // Southwest bridge
    } else {
        return bridges.find(b => b.quadrant === 'se'); // Southeast bridge
    }
}

// Get TWO bridge options for multi-path attack on neighboring bases
function getTwoBridgesForNeighbor(fromBase, toBase, bridges) {
    const fromX = fromBase.gridX;
    const fromY = fromBase.gridY;
    const toX = toBase.gridX;
    const toY = toBase.gridY;
    
    // Identify which two bridges connect the bases
    // Top base (20, 4) can connect to:
    //   - Right (36, 20) via NE or Center
    //   - Bottom (20, 36) via NW+SW or NE+SE
    //   - Left (4, 20) via NW or Center
    
    // Right base (36, 20) can connect to:
    //   - Top (20, 4) via NE or Center
    //   - Bottom (20, 36) via SE or Center
    //   - Left (4, 20) via NW+NE or SW+SE
    
    // Bottom base (20, 36) can connect to:
    //   - Top (20, 4) via SW+NW or SE+NE
    //   - Right (36, 20) via SE or Center
    //   - Left (4, 20) via SW or Center
    
    // Left base (4, 20) can connect to:
    //   - Top (20, 4) via NW or Center
    //   - Right (36, 20) via NE+NW or SE+SW
    //   - Bottom (20, 36) via SW or Center
    
    const center = bridges.find(b => b.quadrant === 'center');
    const nw = bridges.find(b => b.quadrant === 'nw');
    const ne = bridges.find(b => b.quadrant === 'ne');
    const sw = bridges.find(b => b.quadrant === 'sw');
    const se = bridges.find(b => b.quadrant === 'se');
    
    // Top to Right or Right to Top
    if ((fromY < 10 && toX > 30) || (fromX > 30 && toY < 10)) {
        return [ne, center];
    }
    // Top to Left or Left to Top
    if ((fromY < 10 && toX < 10) || (fromX < 10 && toY < 10)) {
        return [nw, center];
    }
    // Bottom to Right or Right to Bottom
    if ((fromY > 30 && toX > 30) || (fromX > 30 && toY > 30)) {
        return [se, center];
    }
    // Bottom to Left or Left to Bottom
    if ((fromY > 30 && toX < 10) || (fromX < 10 && toY > 30)) {
        return [sw, center];
    }
    // Top to Bottom or Bottom to Top (opposite sides)
    if ((fromY < 10 && toY > 30) || (fromY > 30 && toY < 10)) {
        return [nw, ne]; // Use both top bridges or both bottom bridges
    }
    // Left to Right or Right to Left (opposite sides)
    if ((fromX < 10 && toX > 30) || (fromX > 30 && toX < 10)) {
        return [nw, sw]; // Use both left bridges or both right bridges
    }
    
    // Fallback: use center and closest corner bridge
    return [center, nw];
}

// Helper function to check if troops are in same quadrant
// Check if a troop is in range of defensive troops and apply damage if moving away
function applyDefensiveTroopDamage(game, movingTroop, oldGridX, oldGridY, newGridX, newGridY) {
    if (!movingTroop || !game.troops || !Array.isArray(game.troops)) return;

    // Only apply to offensive troops moving away from defensive troops
    if (movingTroop.type === 'defense') return;

    // Find all defensive troops that could attack this troop
    const defensiveTroops = game.troops.filter(t =>
        t &&
        t.type === 'defense' &&
        t.ownerId !== movingTroop.ownerId &&
        !t.isWall && // Walls don't attack
        game.players[t.ownerId] &&
        !game.players[t.ownerId].eliminated
    );

    for (const defensiveTroop of defensiveTroops) {
        // Calculate distance from old position to defensive troop
        const oldDistance = Math.abs(oldGridX - defensiveTroop.gridX) + Math.abs(oldGridY - defensiveTroop.gridY);

        // Check if troop was in range before moving
        if (oldDistance <= defensiveTroop.range + 1) {
            // Calculate distance from new position to defensive troop
            const newDistance = Math.abs(newGridX - defensiveTroop.gridX) + Math.abs(newGridY - defensiveTroop.gridY);

            // If moving away (distance increased), apply damage
            if (newDistance > oldDistance) {
                // Apply damage
                movingTroop.hp = Math.max(0, movingTroop.hp - defensiveTroop.damage);

                // Remove troop if dead
                if (movingTroop.hp <= 0) {
                    const index = game.troops.findIndex(t => t.id === movingTroop.id);
                    if (index !== -1) {
                        game.troops.splice(index, 1);
                    }
                }

                // Only apply damage from one defensive troop per move (first one found)
                break;
            }
        }
    }
}

// Check if a target is a neighboring player (one of the 3 valid neighbors: left, right, opposite)
function isNeighboringPlayer(fromX, fromY, toX, toY) {
    // Player positions are fixed:
    // Top: (20, 4), Right: (36, 20), Bottom: (20, 36), Left: (4, 20)
    const playerPositions = [
        { x: 20, y: 4 },   // Top
        { x: 36, y: 20 },  // Right
        { x: 20, y: 36 },  // Bottom
        { x: 4, y: 20 }    // Left
    ];

    // Check if from and to are both player base positions
    const fromIsBase = playerPositions.some(p => p.x === fromX && p.y === fromY);
    const toIsBase = playerPositions.some(p => p.x === toX && p.y === toY);

    if (!fromIsBase || !toIsBase) return false;

    // If both are base positions, they are neighbors (can always reach via bridges)
    return true;
}

// Check if a target position is within the allowed 180-degree arc from the starting position
// Players can only move to sides (90 degrees) or opposite (180 degrees), not diagonally
function isAllowedDirection(fromX, fromY, toX, toY) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Determine which edge the starting position is closest to
    const centerX = GRID_SIZE / 2; // 20
    const centerY = GRID_SIZE / 2; // 20

    // Calculate direction from center to starting position
    const dxFromCenter = fromX - centerX;
    const dyFromCenter = fromY - centerY;

    // Determine primary direction (top, right, bottom, left)
    let primaryDirection = null;
    if (Math.abs(dyFromCenter) > Math.abs(dxFromCenter)) {
        primaryDirection = dyFromCenter < 0 ? 'top' : 'bottom';
    } else {
        primaryDirection = dxFromCenter > 0 ? 'right' : 'left';
    }

    // Check if target is in allowed 180-degree arc
    // Allowed: left side, right side, or opposite (180 degrees)
    // NOT allowed: diagonally (corners)

    if (primaryDirection === 'top') {
        // From top: can go left (dx < 0, primarily horizontal), right (dx > 0, primarily horizontal), or bottom (dy > 0, primarily vertical)
        // NOT: both dx and dy significant (diagonal)
        return (dx < 0 && absDx > absDy * 2) || // Left (primarily horizontal left)
            (dx > 0 && absDx > absDy * 2) || // Right (primarily horizontal right)
            (dy > 0 && absDy > absDx * 2);  // Bottom (primarily vertical down)
    } else if (primaryDirection === 'right') {
        // From right: can go top (dy < 0, primarily vertical), bottom (dy > 0, primarily vertical), or left (dx < 0, primarily horizontal)
        return (dy < 0 && absDy > absDx * 2) || // Top (primarily vertical up)
            (dy > 0 && absDy > absDx * 2) || // Bottom (primarily vertical down)
            (dx < 0 && absDx > absDy * 2);  // Left (primarily horizontal left)
    } else if (primaryDirection === 'bottom') {
        // From bottom: can go left (dx < 0, primarily horizontal), right (dx > 0, primarily horizontal), or top (dy < 0, primarily vertical)
        return (dx < 0 && absDx > absDy * 2) || // Left (primarily horizontal left)
            (dx > 0 && absDx > absDy * 2) || // Right (primarily horizontal right)
            (dy < 0 && absDy > absDx * 2);  // Top (primarily vertical up)
    } else if (primaryDirection === 'left') {
        // From left: can go top (dy < 0, primarily vertical), bottom (dy > 0, primarily vertical), or right (dx > 0, primarily horizontal)
        return (dy < 0 && absDy > absDx * 2) || // Top (primarily vertical up)
            (dy > 0 && absDy > absDx * 2) || // Bottom (primarily vertical down)
            (dx > 0 && absDx > absDy * 2);  // Right (primarily horizontal right)
    }

    return true; // Default allow if can't determine
}

function isInSameQuadrant(troop1, troop2, basePlayer) {
    const gridX = troop1.gridX;
    const gridY = troop1.gridY;
    const enemyX = troop2.gridX;
    const enemyY = troop2.gridY;

    // Determine quadrant based on position relative to X diagonals
    const aboveDiag1 = gridY < gridX;
    const aboveDiag2 = gridY < (GRID_SIZE - 1 - gridX);

    const enemyAboveDiag1 = enemyY < enemyX;
    const enemyAboveDiag2 = enemyY < (GRID_SIZE - 1 - enemyX);

    // Compare quadrants
    return (aboveDiag1 === enemyAboveDiag1 && aboveDiag2 === enemyAboveDiag2);
}

function moveTroopsOnTurnEnd(game, aiOnly = false) {
    const trenchSet = new Set(game.terrain.trench.map(t => `${t.x},${t.y}`));

    game.troops.forEach(troop => {
        // In manual mode with aiOnly=true, only move AI-owned troops
        if (aiOnly) {
            const owner = game.players[troop.ownerId];
            if (!owner || !owner.isAI) {
                return; // Skip ALL human-owned troops in manual mode
            }
        }

        // In turn-based mode, only move troops belonging to the current player
        if (game.gameMode === 'turns' && troop.ownerId !== game.currentTurn) {
            return;
        }
        // Each troop moves a number of cells equal to their speed (at least 1 if speed > 0)
        const movesPerTurn = troop.speed > 0 ? Math.max(1, Math.floor(troop.speed)) : 0;

        if (movesPerTurn === 0) return; // Don't move if speed is 0 (walls, turrets)

        const ownerBase = game.players[troop.ownerId];

        // Determine target based on troop type
        let targetGridX, targetGridY;

        if (troop.type === 'defense' && ownerBase) {
            // Walls and turrets don't move
            if (troop.isWall || troop.isTurret) {
                return;
            }

            // Non-wall defensive units automatically patrol and engage within their territory
            // Find ALL enemy troops (not just in quadrant - to intercept)
            const allEnemyTroops = game.troops.filter(t => t.ownerId !== troop.ownerId);

            // Prioritize enemies in same quadrant
            const enemyTroopsInTerritory = allEnemyTroops.filter(t =>
                isInSameQuadrant(troop, t, ownerBase)
            );

            // Also check for enemies approaching the territory
            const approachingEnemies = allEnemyTroops.filter(t => {
                const distToBase = Math.abs(t.gridX - ownerBase.gridX) + Math.abs(t.gridY - ownerBase.gridY);
                return distToBase < 8 && t.type === 'offense'; // Enemies within 8 cells of base
            });

            if (enemyTroopsInTerritory.length > 0) {
                // Engage closest enemy in territory
                let closest = enemyTroopsInTerritory[0];
                let minDist = Math.abs(troop.gridX - closest.gridX) + Math.abs(troop.gridY - closest.gridY);

                for (const enemy of enemyTroopsInTerritory) {
                    const dist = Math.abs(troop.gridX - enemy.gridX) + Math.abs(troop.gridY - enemy.gridY);
                    if (dist < minDist) {
                        minDist = dist;
                        closest = enemy;
                    }
                }

                targetGridX = closest.gridX;
                targetGridY = closest.gridY;
            } else if (approachingEnemies.length > 0) {
                // Move towards approaching threats
                let closest = approachingEnemies[0];
                let minDist = Math.abs(troop.gridX - closest.gridX) + Math.abs(troop.gridY - closest.gridY);

                for (const enemy of approachingEnemies) {
                    const dist = Math.abs(troop.gridX - enemy.gridX) + Math.abs(troop.gridY - enemy.gridY);
                    if (dist < minDist) {
                        minDist = dist;
                        closest = enemy;
                    }
                }

                // Move towards the direction of the threat (but stay in territory)
                const dx = closest.gridX - troop.gridX;
                const dy = closest.gridY - troop.gridY;
                targetGridX = troop.gridX + Math.sign(dx);
                targetGridY = troop.gridY + Math.sign(dy);
            } else {
                // Active patrol pattern when no threats
                // Create a patrol pattern around the base
                if (!troop.patrolTarget || Math.random() < 0.1) {
                    // Pick a random patrol point within 2-6 cells of base
                    const patrolDist = 2 + Math.floor(Math.random() * 5);
                    const angle = Math.random() * Math.PI * 2;
                    troop.patrolTarget = {
                        x: Math.round(ownerBase.gridX + Math.cos(angle) * patrolDist),
                        y: Math.round(ownerBase.gridY + Math.sin(angle) * patrolDist)
                    };
                }

                targetGridX = troop.patrolTarget.x;
                targetGridY = troop.patrolTarget.y;

                // If reached patrol target, pick new one
                if (troop.gridX === targetGridX && troop.gridY === targetGridY) {
                    troop.patrolTarget = null;
                }
            }
        } else {
            // Offensive units: pathfind to target base
            // Check if only 2 players remain - auto-target enemy base
            const activePlayers = Object.values(game.players).filter(p => p && !p.eliminated);
            const isTwoPlayerMode = activePlayers.length === 2;

            if (!troop.targetBaseId) {
                // Pick the target that was assigned when deployed, or a random enemy
                const enemies = Object.values(game.players).filter(p => p.id !== troop.ownerId && !p.eliminated);
                if (enemies.length > 0) {
                    // If only 2 players, always target the enemy base
                    if (isTwoPlayerMode && enemies.length === 1) {
                        troop.targetBaseId = enemies[0].id;
                    } else {
                        const randomEnemy = enemies[Math.floor(Math.random() * enemies.length)];
                        troop.targetBaseId = randomEnemy.id;
                    }
                }
            }

            const targetBase = game.players[troop.targetBaseId];
            if (!targetBase || targetBase.eliminated) {
                // Target is gone, pick new target
                const enemies = Object.values(game.players).filter(p => p.id !== troop.ownerId && !p.eliminated);
                if (enemies.length > 0) {
                    // Filter enemies to only neighboring players or those in allowed 180-degree arc
                    const ownerBase = game.players[troop.ownerId];
                    const allowedEnemies = enemies.filter(enemy =>
                        isNeighboringPlayer(ownerBase.gridX, ownerBase.gridY, enemy.gridX, enemy.gridY) ||
                        isAllowedDirection(ownerBase.gridX, ownerBase.gridY, enemy.gridX, enemy.gridY)
                    );

                    const validTargets = allowedEnemies.length > 0 ? allowedEnemies : enemies; // Fallback to all if none in arc

                    // If only 2 players, always target the enemy base
                    if (isTwoPlayerMode && validTargets.length === 1) {
                        troop.targetBaseId = validTargets[0].id;
                    } else if (validTargets.length > 0) {
                        const randomEnemy = validTargets[Math.floor(Math.random() * validTargets.length)];
                        troop.targetBaseId = randomEnemy.id;
                    }
                    const newTarget = game.players[troop.targetBaseId];
                    if (newTarget) {
                        targetGridX = newTarget.gridX;
                        targetGridY = newTarget.gridY;
                    }
                }
            } else {
                targetGridX = targetBase.gridX;
                targetGridY = targetBase.gridY;
            }
        }

        if (targetGridX === undefined || targetGridY === undefined) return;

        // Calculate path using A* if we don't have one or if we're close to end of path
        if (!troop.path || troop.path.length === 0) {
            // Pass bridge information to pathfinding for strict bridge following
            const bridges = game.terrain.bridges || [];
            const ownerBase = game.players[troop.ownerId];
            const targetIsNeighboring = ownerBase && isNeighboringPlayer(ownerBase.gridX, ownerBase.gridY, targetGridX, targetGridY);

            let path = findPath(troop.gridX, troop.gridY, targetGridX, targetGridY, trenchSet, bridges);

            // SPLIT ATTACK: For neighboring bases, alternate troops between two bridge paths
            if (targetIsNeighboring) {
                const twoBridges = getTwoBridgesForNeighbor(ownerBase, { gridX: targetGridX, gridY: targetGridY }, bridges);
                
                // Assign this troop a path index if it doesn't have one
                if (troop.attackPathIndex === undefined) {
                    // Count existing troops attacking this target to alternate paths
                    const troopsOnTarget = game.troops.filter(t => 
                        t.ownerId === troop.ownerId && 
                        t.targetBaseId === troop.targetBaseId && 
                        t.id !== troop.id
                    );
                    troop.attackPathIndex = troopsOnTarget.length % 2; // Alternate 0, 1, 0, 1...
                }
                
                // Route through the assigned bridge
                const bridgeToUse = twoBridges[troop.attackPathIndex];
                if (bridgeToUse) {
                    const path1 = findPath(troop.gridX, troop.gridY, bridgeToUse.x, bridgeToUse.y, trenchSet, bridges);
                    const path2 = findPath(bridgeToUse.x, bridgeToUse.y, targetGridX, targetGridY, trenchSet, bridges);
                    
                    if (path1.length > 0 && path2.length > 0) {
                        path = [...path1, ...path2];
                    }
                }
            } else {
                // Non-neighboring attack: sometimes use center bridge for variety
                if (game.movementMode === 'automatic' && Math.random() < 0.3 && path.length > 0) {
                    // Try routing through center bridge
                    const centerX = 20;
                    const centerY = 20;
                    const path1 = findPath(troop.gridX, troop.gridY, centerX, centerY, trenchSet, bridges);
                    const path2 = findPath(centerX, centerY, targetGridX, targetGridY, trenchSet, bridges);

                    if (path1.length > 0 && path2.length > 0) {
                        // Use center route if it's not too much longer (within 50% of direct path)
                        const centerPathLength = path1.length + path2.length;
                        if (centerPathLength <= path.length * 1.5) {
                            path = [...path1, ...path2];
                        }
                    }
                }
            }

            troop.path = path;
        }

        // Move along the path
        for (let i = 0; i < movesPerTurn && troop.path && troop.path.length > 0; i++) {
            const nextStep = troop.path[0];

            // Store old position for defensive troop damage check
            const oldGridX = troop.gridX;
            const oldGridY = troop.gridY;

            // Check if moving away from defensive troops and apply damage
            applyDefensiveTroopDamage(game, troop, oldGridX, oldGridY, nextStep.x, nextStep.y);

            // If troop died from defensive damage, stop moving
            const troopStillExists = game.troops.find(t => t.id === troop.id);
            if (!troopStillExists) {
                break;
            }

            // Move to next step
            troop.gridX = nextStep.x;
            troop.gridY = nextStep.y;
            troop.x = troop.gridX * CELL_SIZE + CELL_SIZE / 2;
            troop.y = troop.gridY * CELL_SIZE + CELL_SIZE / 2;

            // Remove this step from path
            troop.path.shift();

            // If we're getting close to the end or path is empty, recalculate
            if (troop.path.length < 3) {
                const dist = Math.abs(troop.gridX - targetGridX) + Math.abs(troop.gridY - targetGridY);
                if (dist > 1) {
                    // Pass bridge information to pathfinding for strict bridge following
                    const bridges = game.terrain.bridges || [];
                    const ownerBase = game.players[troop.ownerId];
                    const targetIsNeighboring = ownerBase && isNeighboringPlayer(ownerBase.gridX, ownerBase.gridY, targetGridX, targetGridY);

                    let path = findPath(troop.gridX, troop.gridY, targetGridX, targetGridY, trenchSet, bridges);

                    // SPLIT ATTACK: For neighboring bases, use assigned bridge path
                    if (targetIsNeighboring && troop.attackPathIndex !== undefined) {
                        const twoBridges = getTwoBridgesForNeighbor(ownerBase, { gridX: targetGridX, gridY: targetGridY }, bridges);
                        const bridgeToUse = twoBridges[troop.attackPathIndex];
                        
                        if (bridgeToUse) {
                            const path1 = findPath(troop.gridX, troop.gridY, bridgeToUse.x, bridgeToUse.y, trenchSet, bridges);
                            const path2 = findPath(bridgeToUse.x, bridgeToUse.y, targetGridX, targetGridY, trenchSet, bridges);
                            
                            if (path1.length > 0 && path2.length > 0) {
                                path = [...path1, ...path2];
                            }
                        }
                    } else if (!targetIsNeighboring && game.movementMode === 'automatic' && Math.random() < 0.3 && path.length > 0) {
                        // Non-neighboring: sometimes use center bridge
                        const centerX = 20;
                        const centerY = 20;
                        const path1 = findPath(troop.gridX, troop.gridY, centerX, centerY, trenchSet, bridges);
                        const path2 = findPath(centerX, centerY, targetGridX, targetGridY, trenchSet, bridges);

                        if (path1.length > 0 && path2.length > 0) {
                            // Use center route if it's not too much longer (within 50% of direct path)
                            const centerPathLength = path1.length + path2.length;
                            if (centerPathLength <= path.length * 1.5) {
                                path = [...path1, ...path2];
                            }
                        }
                    }

                    troop.path = path;
                }
            }
        }
    });
}

function startGameLoop(gameId) {
    // Initialize AI timers for live mode
    const game = games[gameId];
    if (game.gameMode === 'live') {
        // In live mode, AI players act every few seconds
        Object.values(game.players).forEach(player => {
            if (player.isAI) {
                scheduleAIAction(gameId, player.id);
            }
        });

        // In live mode, regenerate elixir for ALL players (humans and AI equally) every 1.5 seconds
        game.elixirRegenInterval = setInterval(() => {
            const g = games[gameId];
            if (!g || g.status !== 'playing') {
                if (game.elixirRegenInterval) {
                    clearInterval(game.elixirRegenInterval);
                    game.elixirRegenInterval = null;
                }
                return;
            }
            // Give elixir to ALL players equally
            Object.values(g.players).forEach(player => {
                if (player && !player.eliminated) {
                    player.elixir = clamp((player.elixir || 0) + 3, 0, 15); // Increased from +2 to +3 for faster gameplay
                }
            });
        }, 1000); // 1 second elixir regeneration for very fast gameplay
    }

    const interval = setInterval(() => {
        const game = games[gameId];
        if (!game || game.status !== 'playing') {
            clearInterval(interval);
            if (game && game.elixirRegenInterval) {
                clearInterval(game.elixirRegenInterval);
                game.elixirRegenInterval = null;
            }
            return;
        }

        const now = Date.now();
        const dt = (now - game.lastUpdate) / 1000;
        game.lastUpdate = now;

        // Update turn timer (only in turn-based mode)
        if (game.gameMode === 'turns') {
            const elapsed = (now - game.turnStartTime) / 1000;
            game.turnTimeRemaining = Math.max(0, TURN_DURATION - elapsed);

            // Auto-advance turn when time runs out
            if (game.turnTimeRemaining <= 0) {
                nextTurn(gameId);
                return;
            }
        }

        // In live mode, continuously handle combat and movement
        if (game.gameMode === 'live') {
            // Combat happens continuously
            applyCombatDamage(game, gameId);

            // Move troops continuously
            // In automatic mode: all troops move
            // In manual mode: only AI troops move automatically
            if (game.movementMode === 'automatic') {
                moveTroopsOnTurnEnd(game, false); // All troops
            } else {
                moveTroopsOnTurnEnd(game, true); // Only AI troops
            }
        }

        // Update troop grid positions
        game.troops.forEach(troop => {
            // Update grid position based on pixel position
            troop.gridX = Math.floor(troop.x / CELL_SIZE);
            troop.gridY = Math.floor(troop.y / CELL_SIZE);
        });

        io.to(gameId).emit('gameState', serializeGameState(game));
    }, 1000 / 60); // 60 FPS for smooth gameplay
}

// Schedule AI actions for live mode - instant response, no delays
function scheduleAIAction(gameId, aiPlayerId) {
    const makeMove = async () => {
        const game = games[gameId];
        if (!game || game.status !== 'playing') return;

        const aiPlayer = game.players[aiPlayerId];
        if (!aiPlayer || aiPlayer.eliminated) return;

        // AI makes moves in live mode instantly when they have elixir
        if (game.gameMode === 'live' && aiPlayer.elixir >= 2) {
            try {
                await makeAIMoves(gameId, aiPlayerId);
            } catch (err) {
                console.error(`Error in live mode AI moves:`, err);
            }
        }

        // Check again very quickly (every 200ms) - AI acts as soon as they have elixir
        if (game.gameMode === 'live' && game.status === 'playing') {
            setTimeout(makeMove, 200); // Very fast AI response
        }
    };

    // Start immediately with no initial delay
    makeMove();
}

// ============================================================================
// ML TRAINING SYSTEM: Self-Play Training Engine
// ============================================================================

// Training state
let trainingState = {
    isRunning: false,
    totalGames: 0,
    gamesCompleted: 0,
    mlWins: 0,
    baselineWins: 0,
    history: [], // { step, timestamp, mlWinRate, baselineWinRate, gamesInBlock }
    trainingDataBuffer: [] // Collects training samples during games
};

// Run a single hidden self-play training game (ML vs baseline AI)
async function runTrainingGame() {
    return new Promise((resolve) => {
        const trainingGameId = `training_${Date.now()}_${Math.random()}`;
        const game = createGame(trainingGameId);
        game.isTrainingGame = true; // Mark as training game
        game.trainingData = []; // Store decisions made during this game
        
        // Set game to playing immediately (no lobby)
        game.status = 'playing';
        game.gameStartTime = Date.now();
        game.gameMode = 'turns';
        game.movementMode = 'automatic';
        
        // Add two AI players: one with ML mode, one baseline
        const positions = [
            { gridX: 20, gridY: 4, color: '#00BFFF' },   // Top
            { gridX: 20, gridY: 36, color: '#32CD32' }  // Bottom
        ];
        
        // ML AI player
        const mlAiId = 'ml_ai';
        game.players[mlAiId] = {
            id: mlAiId,
            username: 'ML Bot',
            isAI: true,
            useMLAI: true, // Enable ML mode
            ...positions[0],
            x: positions[0].gridX * CELL_SIZE + CELL_SIZE / 2,
            y: positions[0].gridY * CELL_SIZE + CELL_SIZE / 2,
            baseHp: 1000,
            elixir: 8,
            hand: getRandomHand(),
            eliminated: false
        };
        game.players[mlAiId].nextCard = getBalancedCard(game.players[mlAiId].hand, 0);
        
        // Baseline AI player
        const baselineAiId = 'baseline_ai';
        game.players[baselineAiId] = {
            id: baselineAiId,
            username: 'Baseline Bot',
            isAI: true,
            useMLAI: false, // Normal mode
            ...positions[1],
            x: positions[1].gridX * CELL_SIZE + CELL_SIZE / 2,
            y: positions[1].gridY * CELL_SIZE + CELL_SIZE / 2,
            baseHp: 1000,
            elixir: 8,
            hand: getRandomHand(),
            eliminated: false
        };
        game.players[baselineAiId].nextCard = getBalancedCard(game.players[baselineAiId].hand, 0);
        
        // Set turn order
        game.turnOrder = [mlAiId, baselineAiId];
        game.currentTurn = game.turnOrder[0];
        game.turnStartTime = Date.now();
        game.turnTimeRemaining = TURN_DURATION;
        game.turnNumber = 1;
        
        // Store the game temporarily
        games[trainingGameId] = game;
        
        // Fast-forward game loop (no graphics, accelerated turns)
        const maxTurns = 200; // Increased limit to allow games to finish
        let turnCount = 0;
        
        const gameInterval = setInterval(async () => {
            const g = games[trainingGameId];
            if (!g || g.status !== 'playing') {
                clearInterval(gameInterval);
                
                // Determine winner
                const activePlayers = Object.values(game.players).filter(p => !p.eliminated);
                const winner = activePlayers.length === 1 ? activePlayers[0] : null;
                
                // Label training data based on outcome
                const mlWon = winner && winner.id === mlAiId;
                const baselineWon = winner && winner.id === baselineAiId;
                
                if (game.trainingData && game.trainingData.length > 0) {
                    game.trainingData.forEach(sample => {
                        // Label: 1 if the player who made this decision won, 0 if lost, 0.5 if draw
                        let label = 0.5;
                        if (sample.playerId === mlAiId) {
                            label = mlWon ? 1 : (baselineWon ? 0 : 0.5);
                        } else if (sample.playerId === baselineAiId) {
                            label = baselineWon ? 1 : (mlWon ? 0 : 0.5);
                        }
                        
                        // Only add non-draw samples for ML player
                        if (sample.playerId === mlAiId && label !== 0.5) {
                            trainingState.trainingDataBuffer.push({
                                features: sample.features,
                                label: label
                            });
                        }
                    });
                }
                
                // Clean up
                delete games[trainingGameId];
                
                resolve({
                    mlWon: mlWon,
                    baselineWon: baselineWon,
                    draw: !winner,
                    turns: turnCount
                });
                return;
            }
            
            // Fast turn simulation
            const currentPlayer = g.players[g.currentTurn];
            if (currentPlayer && currentPlayer.isAI) {
                try {
                    await makeAIMoves(trainingGameId, currentPlayer.id);
                } catch (err) {
                    console.error('Error in training game AI moves:', err);
                }
            }
            
            // Apply combat
            applyCombatDamage(g, trainingGameId);
            
            // Move troops
            moveTroopsOnTurnEnd(g, false);
            
            // Check for winner
            const activePlayers = Object.values(g.players).filter(p => !p.eliminated);
            if (activePlayers.length <= 1) {
                g.status = 'ended';
                clearInterval(gameInterval);
                
                const winner = activePlayers.length === 1 ? activePlayers[0] : null;
                
                // Label training data based on outcome
                const mlWon = winner && winner.id === mlAiId;
                const baselineWon = winner && winner.id === baselineAiId;
                
                if (g.trainingData && g.trainingData.length > 0) {
                    g.trainingData.forEach(sample => {
                        let label = 0.5;
                        if (sample.playerId === mlAiId) {
                            label = mlWon ? 1 : (baselineWon ? 0 : 0.5);
                        } else if (sample.playerId === baselineAiId) {
                            label = baselineWon ? 1 : (mlWon ? 0 : 0.5);
                        }
                        
                        // Only add non-draw samples for ML player
                        if (sample.playerId === mlAiId && label !== 0.5) {
                            trainingState.trainingDataBuffer.push({
                                features: sample.features,
                                label: label
                            });
                        }
                    });
                }
                
                delete games[trainingGameId];
                
                resolve({
                    mlWon: mlWon,
                    baselineWon: baselineWon,
                    draw: !winner,
                    turns: turnCount
                });
                return;
            }
            
            // Advance turn
            turnCount++;
            if (turnCount >= maxTurns) {
                // Force end on timeout
                g.status = 'ended';
                clearInterval(gameInterval);
                delete games[trainingGameId];
                
                resolve({
                    mlWon: false,
                    baselineWon: false,
                    draw: true,
                    turns: turnCount
                });
                return;
            }
            
            // Next turn
            const currentIndex = g.turnOrder.indexOf(g.currentTurn);
            const nextIndex = (currentIndex + 1) % g.turnOrder.length;
            g.currentTurn = g.turnOrder[nextIndex];
            g.turnStartTime = Date.now();
            g.turnNumber++;
            
            // Give elixir
            const nextPlayer = g.players[g.currentTurn];
            if (nextPlayer) {
                nextPlayer.elixir = clamp((nextPlayer.elixir || 0) + 6, 0, 15);
            }
        }, 50); // Fast simulation: 50ms per turn
    });
}

// Run training loop
async function runTrainingLoop() {
    console.log(`🧠 ML Training started: ${trainingState.totalGames} games`);
    
    const blockSize = 10; // Report progress every 10 games
    
    for (let i = 0; i < trainingState.totalGames; i++) {
        if (!trainingState.isRunning) {
            console.log('🛑 Training stopped by user');
            break;
        }
        
        try {
            const result = await runTrainingGame();
            
            if (result.mlWon) trainingState.mlWins++;
            if (result.baselineWon) trainingState.baselineWins++;
            trainingState.gamesCompleted++;
            
            // Log each game result
            console.log(`Game ${trainingState.gamesCompleted}: ${result.mlWon ? 'ML WIN' : result.baselineWon ? 'BASELINE WIN' : 'DRAW'} (${result.turns} turns)`);
            
            // Report progress every block
            if (trainingState.gamesCompleted % blockSize === 0) {
                const mlWinRate = trainingState.mlWins / trainingState.gamesCompleted;
                const baselineWinRate = trainingState.baselineWins / trainingState.gamesCompleted;
                
                // TRAIN THE MODEL with collected data
                let trainingResult = null;
                if (trainingState.trainingDataBuffer.length >= 50) {
                    console.log(`🎓 Training neural network with ${trainingState.trainingDataBuffer.length} samples...`);
                    trainingResult = await trainMLModelWithData(trainingState.trainingDataBuffer);
                    
                    // Clear buffer after training
                    trainingState.trainingDataBuffer = [];
                }
                
                trainingState.history.push({
                    step: trainingState.gamesCompleted,
                    timestamp: Date.now(),
                    mlWinRate,
                    baselineWinRate,
                    gamesInBlock: blockSize,
                    trainLoss: trainingResult ? trainingResult.loss : null,
                    trainAccuracy: trainingResult ? trainingResult.accuracy : null
                });
                
                console.log(`📊 Training progress: ${trainingState.gamesCompleted}/${trainingState.totalGames} | ML: ${(mlWinRate * 100).toFixed(1)}% | Baseline: ${(baselineWinRate * 100).toFixed(1)}%`);
                if (trainingResult) {
                    console.log(`   Neural net trained - Loss: ${trainingResult.loss.toFixed(4)}, Acc: ${(trainingResult.accuracy * 100).toFixed(1)}%`);
                }
                
                // Update model metadata after each block
                try {
                    const modelData = fs.existsSync(ML_MODEL_FILE) 
                        ? JSON.parse(fs.readFileSync(ML_MODEL_FILE, 'utf8'))
                        : {};
                    
                    modelData.lastUpdated = Date.now();
                    modelData.sampleCount = (modelData.sampleCount || 0) + blockSize;
                    modelData.mlWinRate = mlWinRate;
                    modelData.baselineWinRate = baselineWinRate;
                    modelData.trainingGames = trainingState.gamesCompleted;
                    
                    // Note: Weights are already saved by saveMLModel() after training
                    fs.writeFileSync(ML_MODEL_FILE, JSON.stringify(modelData, null, 2), 'utf8');
                } catch (err) {
                    console.error('Error updating model file:', err);
                }
            }
        } catch (err) {
            console.error('Training game error:', err);
        }
    }
    
    trainingState.isRunning = false;
    console.log(`✅ Training completed: ${trainingState.gamesCompleted} games | ML: ${trainingState.mlWins} wins | Baseline: ${trainingState.baselineWins} wins`);
}

// Socket endpoints for training control
io.on('connection', (socket) => {
    socket.on('startMLTraining', ({ games: numGames }) => {
        if (!checkRateLimit(socket.id)) return;
        
        if (trainingState.isRunning) {
            socket.emit('error', 'Training is already running');
            return;
        }
        
        const gamesToRun = Math.min(Math.max(1, parseInt(numGames) || 100), 1000); // Limit 1-1000
        
        trainingState = {
            isRunning: true,
            totalGames: gamesToRun,
            gamesCompleted: 0,
            mlWins: 0,
            baselineWins: 0,
            history: [],
            trainingDataBuffer: []
        };
        
        socket.emit('trainingStarted', { games: gamesToRun });
        console.log(`🚀 Training started by ${socket.id}: ${gamesToRun} games`);
        
        // Run training in background
        runTrainingLoop().catch(err => {
            console.error('Training loop error:', err);
            trainingState.isRunning = false;
        });
    });
    
    socket.on('stopMLTraining', () => {
        if (!checkRateLimit(socket.id)) return;
        
        if (!trainingState.isRunning) {
            socket.emit('error', 'No training is running');
            return;
        }
        
        trainingState.isRunning = false;
        socket.emit('trainingStopped');
        console.log(`🛑 Training stopped by ${socket.id}`);
    });
    
    socket.on('getMLTrainingStatus', () => {
        if (!checkRateLimit(socket.id)) return;
        
        socket.emit('mlTrainingStatus', {
            isRunning: trainingState.isRunning,
            totalGames: trainingState.totalGames,
            gamesCompleted: trainingState.gamesCompleted,
            mlWins: trainingState.mlWins,
            baselineWins: trainingState.baselineWins,
            mlWinRate: trainingState.gamesCompleted > 0 ? trainingState.mlWins / trainingState.gamesCompleted : 0,
            baselineWinRate: trainingState.gamesCompleted > 0 ? trainingState.baselineWins / trainingState.gamesCompleted : 0,
            history: trainingState.history
        });
    });
});

// Update getAIStats to include training data
io.on('connection', (socket) => {
    const originalGetAIStats = socket.on.bind(socket, 'getAIStats');
    
    socket.on('getAIStats', () => {
        if (!checkRateLimit(socket.id)) return;
        
        const statsWithTraining = {
            ...aiStats,
            training: {
                isRunning: trainingState.isRunning,
                gamesCompleted: trainingState.gamesCompleted,
                totalGames: trainingState.totalGames,
                mlWinRate: trainingState.gamesCompleted > 0 ? trainingState.mlWins / trainingState.gamesCompleted : 0,
                baselineWinRate: trainingState.gamesCompleted > 0 ? trainingState.baselineWins / trainingState.gamesCompleted : 0,
                history: trainingState.history
            }
        };
        
        // Try to load model metadata
        try {
            if (fs.existsSync(ML_MODEL_FILE)) {
                const modelData = JSON.parse(fs.readFileSync(ML_MODEL_FILE, 'utf8'));
                statsWithTraining.mlModel = {
                    lastUpdated: modelData.lastUpdated,
                    sampleCount: modelData.sampleCount,
                    mlWinRate: modelData.mlWinRate,
                    baselineWinRate: modelData.baselineWinRate,
                    trainingGames: modelData.trainingGames
                };
            }
        } catch (err) {
            // Model file doesn't exist yet
        }
        
        socket.emit('aiStats', statsWithTraining);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT} and accessible on all interfaces`);
});
