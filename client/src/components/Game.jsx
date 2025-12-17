import React, { useEffect, useMemo, useRef, useState } from 'react';
import io from 'socket.io-client';
import './Game.css';
import { sanitizeUsernameInput, validateUsername, USERNAME_RULES } from '../utils/username';
import sharkIcon from '../assets/shark.svg';
import crabIcon from '../assets/crab.svg';
import jellyfishIcon from '../assets/jellyfish.svg';
import turtleIcon from '../assets/turtle.svg';
import tridentIcon from '../assets/trident.svg';
import coralWallIcon from '../assets/coral_wall.svg';
import barracudaIcon from '../assets/barracuda.svg';
import orcaIcon from '../assets/orca.svg';
import narwhalIcon from '../assets/narwhal.svg';
import seaUrchinIcon from '../assets/sea_urchin.svg';
import minoIcon from '../assets/mino.svg';
import leviathanIcon from '../assets/leviathan.svg';
import mountainXWithBridgesSvg from '../assets/mountain_x_with_bridges.svg';
import bridgeSvg from '../assets/bridge.svg';

const CARD_ICONS = {
    shark: sharkIcon,
    crab: crabIcon,
    jellyfish: jellyfishIcon,
    turtle: turtleIcon,
    trident: tridentIcon,
    coral_wall: coralWallIcon,
    barracuda: barracudaIcon,
    orca: orcaIcon,
    narwhal: narwhalIcon,
    sea_urchin: seaUrchinIcon,
    mino: minoIcon,
    leviathan: leviathanIcon,
    turret: null // Will use fallback rendering
};

// Connect to the server
// In production (Docker), use relative path which is proxied by Nginx to the server
// In development, connect directly to port 3001
const SOCKET_URL = import.meta.env.PROD ? '/' : `http://${window.location.hostname}:3001`;

const socket = io(SOCKET_URL);

const GRID_SIZE = 40;
const CELL_SIZE = 50;
const MAP_SIZE = GRID_SIZE * CELL_SIZE; // 1000x1000

function computeTroopStackLayout(troops) {
    const byCell = new Map(); // key -> troop[]
    for (const t of troops || []) {
        if (!t || t.gridX === undefined || t.gridY === undefined || !t.id) continue;
        const key = `${t.gridX},${t.gridY}`;
        const arr = byCell.get(key) || [];
        arr.push(t);
        byCell.set(key, arr);
    }

    // Stable ordering for offsets so stacks don't shuffle frame-to-frame
    for (const arr of byCell.values()) {
        arr.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }

    const offsetById = new Map(); // id -> { dx, dy, size }
    const cellInfo = new Map(); // key -> { gridX, gridY, size }

    for (const [key, arr] of byCell.entries()) {
        const size = arr.length;
        const [gxStr, gyStr] = key.split(',');
        const gridX = Number(gxStr);
        const gridY = Number(gyStr);
        cellInfo.set(key, { gridX, gridY, size });

        for (let idx = 0; idx < size; idx++) {
            const t = arr[idx];
            if (size <= 1) {
                offsetById.set(t.id, { dx: 0, dy: 0, size, idx });
                continue;
            }
            // Fan troops around the cell center so stacks are visible
            const r = Math.min(14, 5 + Math.sqrt(size) * 3);
            const angle = (idx / size) * Math.PI * 2;
            offsetById.set(t.id, {
                dx: Math.cos(angle) * r,
                dy: Math.sin(angle) * r,
                size,
                idx
            });
        }
    }

    return { offsetById, cellInfo };
}

// Helper function to darken a hex color
const darkenColor = (color, factor) => {
    // Validate hex color
    let hex = color.replace('#', '');
    if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }

    // Convert to RGB
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);

    // Darken
    r = Math.floor(r * (1 - factor));
    g = Math.floor(g * (1 - factor));
    b = Math.floor(b * (1 - factor));

    // Clamp
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));

    // Convert back to hex
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
};

const Game = () => {
    const canvasRef = useRef(null);
    const [gameState, setGameState] = useState(null);
    const [myPlayer, setMyPlayer] = useState(null);
    const [selectedCard, setSelectedCard] = useState(null);
    const [joined, setJoined] = useState(false);
    const [gameId, setGameId] = useState('room1');
    const [endState, setEndState] = useState(null); // { outcome: 'win' | 'lose', winnerId?: string }
    const [username, setUsername] = useState('');
    const [movementMode] = useState('automatic');
    const [showLobby, setShowLobby] = useState(true);
    const [currentTab, setCurrentTab] = useState('lobby'); // 'lobby' or 'training'
    const [selectedRoom, setSelectedRoom] = useState('room1');
    const [roomStatusById, setRoomStatusById] = useState({});
    const [joinPending, setJoinPending] = useState(false);
    const joinPendingRef = useRef(false);
    const pendingJoinGameIdRef = useRef(null);

    const troopIconImagesRef = useRef({});
    const mountainXRef = useRef(null);
    const bridgeImageRef = useRef(null);
    const troopAnimationsRef = useRef({}); // Store animation data for each troop
    const [hoveredTroop, setHoveredTroop] = useState(null);
    const [placementMode, setPlacementMode] = useState(false);
    const [hoveredCell, setHoveredCell] = useState(null);
    const [targetSelectionMode, setTargetSelectionMode] = useState(false);
    const [pendingOffensiveCard, setPendingOffensiveCard] = useState(null);
    const [_selectedTroop, setSelectedTroop] = useState(null);
    const [possibleMoves, setPossibleMoves] = useState([]);
    const [draggingTroop, setDraggingTroop] = useState(null);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [renderTick, setRenderTick] = useState(0); // For forcing re-renders during drag
    const [moveNotification, setMoveNotification] = useState(null);
    const [connectionStatus, setConnectionStatus] = useState('connected'); // 'connected', 'disconnected', 'reconnecting'
    const [toasts, setToasts] = useState([]);
    const reconnectTimeoutRef = useRef(null);
    const reconnectAttemptsRef = useRef(0);
    const [hoveredCard, setHoveredCard] = useState(null);
    const [hoveredCardPosition, setHoveredCardPosition] = useState({ x: 0, y: 0 });
    const [projectiles, setProjectiles] = useState([]);
    const turretAimRef = useRef({}); // { [turretId]: { angle, time } }
    const [showAIStats, setShowAIStats] = useState(false);
    const [aiStatsData, setAiStatsData] = useState(null);
    const aiStatsCloseBtnRef = useRef(null);
    const lastFocusedElRef = useRef(null);

    // Precompute stack layout so multiple troops on the same tile are clearly visible.
    const troopStackLayout = useMemo(() => {
        return computeTroopStackLayout(gameState?.troops || []);
    }, [gameState?.troops]);

    // ML Training Mode state
    const [trainingStatus, setTrainingStatus] = useState(null);
    const [trainingGames, setTrainingGames] = useState(100);

    // Track join/reconnect metadata
    const hasJoinedRef = useRef(false);
    const shouldAttemptRejoinRef = useRef(false);
    const lastJoinInfoRef = useRef(null); // { gameId, username, movementMode }

    // Preload terrain SVG image(s)
    useEffect(() => {
        const mxImg = new Image();
        mxImg.src = mountainXWithBridgesSvg;
        mountainXRef.current = mxImg;

        const bridgeImg = new Image();
        bridgeImg.src = bridgeSvg;
        bridgeImageRef.current = bridgeImg;
    }, []);

    // Toast notification system
    const showToast = (message, type = 'info') => {
        const id = Date.now() + Math.random();
        const toast = { id, message, type };
        setToasts(prev => [...prev, toast]);

        // Auto-remove after 4 seconds
        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
        }, 4000);
    };

    // Cleanup function for toasts
    useEffect(() => {
        return () => {
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
        };
    }, []);

    // AI Stats modal focus + escape handling
    useEffect(() => {
        if (!showAIStats) return;

        lastFocusedElRef.current = document.activeElement;
        const t = setTimeout(() => aiStatsCloseBtnRef.current?.focus?.(), 0);

        const onKeyDown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                setShowAIStats(false);
            }
        };
        window.addEventListener('keydown', onKeyDown);

        return () => {
            clearTimeout(t);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [showAIStats]);

    useEffect(() => {
        if (showAIStats) return;
        const el = lastFocusedElRef.current;
        if (el && typeof el.focus === 'function') el.focus();
    }, [showAIStats]);

    // Keep hasJoinedRef in sync with joined state
    useEffect(() => {
        hasJoinedRef.current = joined;
    }, [joined]);

    // Keep joinPendingRef in sync so socket callbacks don't capture stale state
    useEffect(() => {
        joinPendingRef.current = joinPending;
    }, [joinPending]);

    useEffect(() => {
        socket.on('connect', () => {
            console.log('Connected to server');
            setConnectionStatus('connected');
            reconnectAttemptsRef.current = 0;
            showToast('Connected to server', 'success');

            // If we were previously in a game, automatically try to rejoin it
            if (shouldAttemptRejoinRef.current && lastJoinInfoRef.current) {
                const { gameId: lastGameId, username: lastUsername, movementMode: lastMovementMode } = lastJoinInfoRef.current;
                console.log('Attempting automatic rejoin:', lastGameId, lastUsername);
                socket.emit('joinGame', {
                    gameId: lastGameId,
                    username: lastUsername,
                    movementMode: lastMovementMode || movementMode
                });
                shouldAttemptRejoinRef.current = false;
                showToast(`Rejoining ${lastGameId}...`, 'info');
            }

            // Clear any pending reconnection
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }
        });

        socket.on('disconnect', (reason) => {
            console.log('Disconnected from server:', reason);
            setConnectionStatus('disconnected');
            showToast('Disconnected from server', 'error');

            // Remember to attempt an automatic rejoin once we connect again
            if (hasJoinedRef.current && gameId && username) {
                lastJoinInfoRef.current = {
                    gameId,
                    username: username.trim(),
                    movementMode
                };
                shouldAttemptRejoinRef.current = true;
            }

            // Attempt reconnection with exponential backoff
            if (reason === 'io server disconnect') {
                // Server disconnected, don't auto-reconnect
                return;
            }

            reconnectAttemptsRef.current++;
            const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), 10000);

            setConnectionStatus('reconnecting');
            showToast(`Reconnecting... (Attempt ${reconnectAttemptsRef.current})`, 'warning');

            reconnectTimeoutRef.current = setTimeout(() => {
                socket.connect();
            }, delay);
        });

        socket.on('connect_error', (error) => {
            console.error('Connection error:', error);
            setConnectionStatus('disconnected');
            if (reconnectAttemptsRef.current === 0) {
                showToast('Failed to connect to server', 'error');
            }
        });

        socket.on('gameState', (state) => {
            console.log('Received gameState:', state);
            console.log('Current socket ID:', socket.id);

            // Update troop animations when positions change
            if (state.troops) {
                state.troops.forEach(troop => {
                    const existingAnim = troopAnimationsRef.current[troop.id];

                    // Update target position for smooth interpolation
                    if (existingAnim) {
                        // Only update if position changed significantly
                        if (Math.abs(existingAnim.targetX - troop.x) > 0.1 ||
                            Math.abs(existingAnim.targetY - troop.y) > 0.1) {
                            existingAnim.targetX = troop.x;
                            existingAnim.targetY = troop.y;
                        }
                    } else {
                        // New troop, initialize at current position
                        troopAnimationsRef.current[troop.id] = {
                            startX: troop.x,
                            startY: troop.y,
                            targetX: troop.x,
                            targetY: troop.y,
                            currentX: troop.x,
                            currentY: troop.y
                        };
                    }
                });

                // Clean up animations for removed troops
                Object.keys(troopAnimationsRef.current).forEach(troopId => {
                    if (!state.troops.find(t => t.id === troopId)) {
                        delete troopAnimationsRef.current[troopId];
                    }
                });
            }

            setGameState(state);

            if (socket.id && state.players[socket.id]) {
                console.log('Found my player in gameState');
                setMyPlayer(state.players[socket.id]);
            } else {
                console.warn('My player not found in gameState!', {
                    socketId: socket.id,
                    players: Object.keys(state.players)
                });
            }

            // Confirm lobby join only after we actually receive gameState for the room we requested.
            if (joinPendingRef.current && pendingJoinGameIdRef.current && state?.id === pendingJoinGameIdRef.current) {
                setJoined(true);
                setShowLobby(false);
                setJoinPending(false);
                pendingJoinGameIdRef.current = null;
                showToast(`Joined ${state.id}`, 'success');
            }
        });

        socket.on('playerInfo', (info) => {
            console.log('My info:', info);
        });

        socket.on('gameOver', ({ winner, winnerName, eliminated }) => {
            setGameState(prev => prev ? { ...prev, status: 'ended' } : prev);

            if (winner) {
                const outcome = winner === socket.id ? 'win' : 'lose';
                setEndState({ outcome, winnerId: winner, winnerName: winnerName || null });
            } else if (eliminated) {
                if (eliminated === socket.id) {
                    setEndState({ outcome: 'lose', winnerId: null, winnerName: null });
                } else {
                    console.log(`Player ${eliminated} eliminated`);
                }
            }
        });

        socket.on('error', (msg) => {
            console.error('Server error:', msg);
            showToast(msg || 'An error occurred', 'error');

            // If a join was pending, treat this as a join failure and keep the user in the lobby.
            if (joinPendingRef.current) {
                setJoinPending(false);
                pendingJoinGameIdRef.current = null;
                setJoined(false);
                setShowLobby(true);
            }
        });

        socket.on('roomReset', () => {
            // Room has been reset, send players back to lobby
            setJoined(false);
            setShowLobby(true);
            setGameState(null);
            setMyPlayer(null);
            setEndState(null);
            setSelectedCard(null);
            setSelectedTroop(null);
            setPossibleMoves([]);
            setProjectiles([]);
        });

        socket.on('roomStatus', (rooms) => {
            const next = {};
            (rooms || []).forEach(r => {
                if (r && r.roomId) next[r.roomId] = r;
            });
            setRoomStatusById(next);
        });

        socket.on('combatEvents', (events) => {
            // Handle projectile events
            events.forEach(event => {
                if (event.type === 'projectile') {
                    // Store turret aim direction so the barrel can rotate toward its most recent shot
                    if (event.attackerId && typeof event.fromX === 'number' && typeof event.fromY === 'number' &&
                        typeof event.toX === 'number' && typeof event.toY === 'number') {
                        turretAimRef.current[event.attackerId] = {
                            angle: Math.atan2(event.toY - event.fromY, event.toX - event.fromX),
                            time: Date.now()
                        };
                    }

                    const projectile = {
                        id: `projectile_${Date.now()}_${Math.random()}`,
                        fromX: event.fromX,
                        fromY: event.fromY,
                        toX: event.toX,
                        toY: event.toY,
                        startTime: Date.now(),
                        duration: 500, // 500ms travel time
                        color: '#FF6B35' // Turret color
                    };
                    setProjectiles(prev => [...prev, projectile]);

                    // Remove projectile after animation
                    setTimeout(() => {
                        setProjectiles(prev => prev.filter(p => p.id !== projectile.id));
                    }, projectile.duration);
                }
            });
        });

        socket.on('aiStats', (stats) => {
            setAiStatsData(stats);
        });

        socket.on('mlTrainingStatus', (status) => {
            setTrainingStatus(status);
        });

        socket.on('trainingStarted', ({ games }) => {
            showToast(`Training started: ${games} games`, 'success');
            // Poll for status updates
            const interval = setInterval(() => {
                socket.emit('getMLTrainingStatus');
            }, 1000);

            // Store interval ID to clear later
            setTimeout(() => clearInterval(interval), games * 1000); // Clear after expected duration
        });

        socket.on('trainingStopped', () => {
            showToast('Training stopped', 'warning');
            socket.emit('getMLTrainingStatus');
        });

        return () => {
            socket.off('connect');
            socket.off('disconnect');
            socket.off('connect_error');
            socket.off('gameState');
            socket.off('playerInfo');
            socket.off('gameOver');
            socket.off('error');
            socket.off('roomReset');
            socket.off('roomStatus');
            socket.off('aiStats');
            socket.off('mlTrainingStatus');
            socket.off('trainingStarted');
            socket.off('trainingStopped');

            // Cleanup reconnection timeout
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }

            // (No training interval to clean up anymore)
        };
    }, []);

    // Poll for room status while in the lobby (Game tab)
    useEffect(() => {
        if (!showLobby || currentTab !== 'lobby') return;

        socket.emit('getRoomStatus');
        const interval = setInterval(() => {
            socket.emit('getRoomStatus');
        }, 2000);

        return () => clearInterval(interval);
    }, [showLobby, currentTab]);

    // Poll for training status when in lobby
    useEffect(() => {
        if (showLobby && !joined) {
            socket.emit('getMLTrainingStatus');
            const interval = setInterval(() => {
                socket.emit('getMLTrainingStatus');
            }, 2000); // Poll every 2 seconds

            return () => clearInterval(interval);
        }
    }, [showLobby, joined]);

    // Preload troop icon images once
    useEffect(() => {
        const images = {};
        Object.entries(CARD_ICONS).forEach(([id, src]) => {
            const img = new Image();
            img.src = src;
            images[id] = img;
        });
        troopIconImagesRef.current = images;
    }, []);

    useEffect(() => {
        if (!gameState || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');

        // High DPI support for crisp rendering
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();

        // Only resize if dimensions changed (prevents flickering)
        if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
        }

        // Scale context to match
        ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
        ctx.scale(dpr, dpr);

        const width = rect.width;
        const height = rect.height;

        // Clear canvas with deep ocean color
        ctx.fillStyle = '#001e3c';
        ctx.fillRect(0, 0, width, height);

        // Scale to fit map into canvas
        const scale = Math.min(width / MAP_SIZE, height / MAP_SIZE);
        const offsetX = (width - MAP_SIZE * scale) / 2;
        const offsetY = (height - MAP_SIZE * scale) / 2;

        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);

        // Draw Grid
        ctx.strokeStyle = 'rgba(0, 150, 200, 0.3)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= GRID_SIZE; i++) {
            // Vertical lines
            ctx.beginPath();
            ctx.moveTo(i * CELL_SIZE, 0);
            ctx.lineTo(i * CELL_SIZE, MAP_SIZE);
            ctx.stroke();
            // Horizontal lines
            ctx.beginPath();
            ctx.moveTo(0, i * CELL_SIZE);
            ctx.lineTo(MAP_SIZE, i * CELL_SIZE);
            ctx.stroke();
        }

        // Draw unified X-shaped Mountain Range with Bridges (single vector)
        if (mountainXRef.current && mountainXRef.current.complete) {
            ctx.drawImage(mountainXRef.current, 0, 0, MAP_SIZE, MAP_SIZE);
        } else {
            // Fallback if image not loaded - draw simple X pattern
            ctx.fillStyle = '#4A4A4A';
            if (gameState.terrain && gameState.terrain.trench) {
                gameState.terrain.trench.forEach(cell => {
                    ctx.fillRect(cell.x * CELL_SIZE, cell.y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
                });
            }

            // Draw bridge markers for non-central bridges
            ctx.fillStyle = '#8B4513';
            if (gameState.terrain && gameState.terrain.bridges) {
                gameState.terrain.bridges.forEach(bridge => {
                    // Skip central bridges here; they are rendered explicitly below
                    if (bridge.name && bridge.name.startsWith('center')) return;
                    ctx.fillRect(
                        bridge.x * CELL_SIZE - CELL_SIZE,
                        bridge.y * CELL_SIZE - CELL_SIZE,
                        CELL_SIZE * 3,
                        CELL_SIZE * 3
                    );
                });
            }
        }

        // Draw two perpendicular central bridges at the middle of the map so they
        // clearly cross the X-shaped trench from side to side.
        // This is rendered regardless of whether the mountainX asset is loaded,
        // so the central chokepoint is always visually obvious.
        const centerPixelX = MAP_SIZE / 2;
        const centerPixelY = MAP_SIZE / 2;
        // Larger bridges so they clearly span across the trench arms:
        // ~8 cells long and 2 cells wide.
        const bridgeLength = CELL_SIZE * 8;
        const bridgeWidth = CELL_SIZE * 2;

        const drawCentralBridge = (angleDeg, fallbackColor) => {
            ctx.save();
            ctx.translate(centerPixelX, centerPixelY);
            ctx.rotate((angleDeg * Math.PI) / 180);

            if (bridgeImageRef.current && bridgeImageRef.current.complete) {
                ctx.drawImage(
                    bridgeImageRef.current,
                    -bridgeLength / 2,
                    -bridgeWidth / 2,
                    bridgeLength,
                    bridgeWidth
                );
            } else {
                ctx.fillStyle = fallbackColor;
                ctx.fillRect(
                    -bridgeLength / 2,
                    -bridgeWidth / 2,
                    bridgeLength,
                    bridgeWidth
                );
            }

            ctx.restore();
        };

        // One horizontal and one vertical bridge, both perpendicular to the X-trench
        drawCentralBridge(0, '#8B4513');   // Left ↔ Right
        drawCentralBridge(90, '#A0522D');  // Top ↔ Bottom

        // Draw Map Boundaries
        ctx.strokeStyle = '#006994';
        ctx.lineWidth = 5;
        ctx.strokeRect(0, 0, MAP_SIZE, MAP_SIZE);

        // Draw placement grid and valid zones for defensive units
        if (placementMode && selectedCard?.type === 'defense' && myPlayer) {
            ctx.strokeStyle = 'rgba(0, 255, 0, 0.3)';
            ctx.lineWidth = 1;

            // Highlight valid placement cells
            for (let gx = 0; gx < GRID_SIZE; gx++) {
                for (let gy = 0; gy < GRID_SIZE; gy++) {
                    if (isInPlayerQuadrant(gx, gy, myPlayer)) {
                        ctx.fillStyle = 'rgba(0, 255, 0, 0.1)';
                        ctx.fillRect(gx * CELL_SIZE, gy * CELL_SIZE, CELL_SIZE, CELL_SIZE);
                        ctx.strokeRect(gx * CELL_SIZE, gy * CELL_SIZE, CELL_SIZE, CELL_SIZE);
                    }
                }
            }

            // Highlight hovered cell
            if (hoveredCell && isInPlayerQuadrant(hoveredCell.gridX, hoveredCell.gridY, myPlayer)) {
                ctx.fillStyle = 'rgba(0, 255, 0, 0.4)';
                ctx.fillRect(
                    hoveredCell.gridX * CELL_SIZE,
                    hoveredCell.gridY * CELL_SIZE,
                    CELL_SIZE,
                    CELL_SIZE
                );
                ctx.strokeStyle = 'rgba(0, 255, 0, 1)';
                ctx.lineWidth = 3;
                ctx.strokeRect(
                    hoveredCell.gridX * CELL_SIZE,
                    hoveredCell.gridY * CELL_SIZE,
                    CELL_SIZE,
                    CELL_SIZE
                );
            }
        }

        // Draw possible moves for manual mode
        if (gameState.movementMode === 'manual' && possibleMoves.length > 0) {
            possibleMoves.forEach(move => {
                ctx.fillStyle = 'rgba(0, 255, 0, 0.3)';
                ctx.fillRect(move.gridX * CELL_SIZE, move.gridY * CELL_SIZE, CELL_SIZE, CELL_SIZE);
                ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)';
                ctx.lineWidth = 2;
                ctx.strokeRect(move.gridX * CELL_SIZE, move.gridY * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            });
        }

        // Draw Bases as Castles - retain player colors
        Object.values(gameState.players).forEach(p => {
            const castleX = p.x;
            const castleY = p.y;
            const castleSize = 70;

            ctx.save();

            // Castle base (main structure) - use player color
            ctx.fillStyle = p.color;
            ctx.fillRect(castleX - castleSize, castleY - castleSize * 0.3, castleSize * 2, castleSize * 1.2);

            // Castle walls with darker shade for depth
            const darkerColor = darkenColor(p.color, 0.2);
            ctx.fillStyle = darkerColor;

            // Left wall
            ctx.fillRect(castleX - castleSize, castleY - castleSize * 0.3, castleSize * 0.3, castleSize * 1.2);
            // Right wall
            ctx.fillRect(castleX + castleSize * 0.7, castleY - castleSize * 0.3, castleSize * 0.3, castleSize * 1.2);

            // Castle battlements (top crenellations)
            const battlementWidth = castleSize * 0.4;
            const battlementHeight = castleSize * 0.25;
            const numBattlements = 5;
            const spacing = (castleSize * 2) / numBattlements;

            ctx.fillStyle = p.color;
            for (let i = 0; i < numBattlements; i++) {
                const x = castleX - castleSize + i * spacing + spacing * 0.1;
                ctx.fillRect(x, castleY - castleSize * 0.3 - battlementHeight, battlementWidth, battlementHeight);
            }

            // Central tower (taller)
            const towerWidth = castleSize * 0.6;
            const towerHeight = castleSize * 0.8;
            ctx.fillStyle = p.color;
            ctx.fillRect(castleX - towerWidth / 2, castleY - castleSize * 0.3 - towerHeight, towerWidth, towerHeight);

            // Tower battlements
            const towerBattlementWidth = towerWidth * 0.3;
            const towerBattlementHeight = castleSize * 0.2;
            ctx.fillRect(castleX - towerWidth / 2, castleY - castleSize * 0.3 - towerHeight - towerBattlementHeight, towerBattlementWidth, towerBattlementHeight);
            ctx.fillRect(castleX + towerWidth / 2 - towerBattlementWidth, castleY - castleSize * 0.3 - towerHeight - towerBattlementHeight, towerBattlementWidth, towerBattlementHeight);

            // Tower window
            ctx.fillStyle = 'rgba(255, 255, 200, 0.6)';
            ctx.fillRect(castleX - towerWidth * 0.15, castleY - castleSize * 0.5, towerWidth * 0.3, towerWidth * 0.3);
            ctx.strokeStyle = darkerColor;
            ctx.lineWidth = 2;
            ctx.strokeRect(castleX - towerWidth * 0.15, castleY - castleSize * 0.5, towerWidth * 0.3, towerWidth * 0.3);

            // Castle outline/border
            ctx.strokeStyle = darkerColor;
            ctx.lineWidth = 3;
            ctx.strokeRect(castleX - castleSize, castleY - castleSize * 0.3, castleSize * 2, castleSize * 1.2);
            ctx.strokeRect(castleX - towerWidth / 2, castleY - castleSize * 0.3 - towerHeight, towerWidth, towerHeight);

            ctx.restore();

            // Base HP Bar + Shield Icon + Text (HP / Max)
            const maxBaseHp = 1000;
            const clampedHp = Math.max(0, Math.min(maxBaseHp, p.baseHp || 0));
            const hpRatio = clampedHp / maxBaseHp;

            // Background bar
            ctx.fillStyle = 'red';
            ctx.fillRect(p.x - 50, p.y - 95, 100, 14);
            // Current HP segment
            ctx.fillStyle = 'green';
            ctx.fillRect(p.x - 50, p.y - 95, 100 * hpRatio, 14);

            // Shield icon to the left of the bar
            const shieldWidth = 16;
            const shieldHeight = 20;
            const shieldX = p.x - 70;
            const shieldY = p.y - 100;

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(shieldX + shieldWidth / 2, shieldY); // top
            ctx.lineTo(shieldX + shieldWidth, shieldY + shieldHeight * 0.3);
            ctx.lineTo(shieldX + shieldWidth * 0.8, shieldY + shieldHeight);
            ctx.lineTo(shieldX + shieldWidth * 0.2, shieldY + shieldHeight);
            ctx.lineTo(shieldX, shieldY + shieldHeight * 0.3);
            ctx.closePath();
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // HP text (current / max) next to the bar
            ctx.fillStyle = 'white';
            ctx.font = 'bold 16px Arial';
            ctx.textAlign = 'left';
            ctx.fillText(
                `${Math.ceil(clampedHp)}/${maxBaseHp}`,
                p.x - 45,
                p.y - 82
            );

            // Optional ML AI "thought" line above the tower (what the TensorFlow model is favoring)
            if (gameState.useMLAI && p.isAI && gameState.mlAIInsights && gameState.mlAIInsights[p.id]) {
                const thought = gameState.mlAIInsights[p.id];
                const label = thought.cardName || thought.cardId || 'ML deciding...';
                const scoreText = typeof thought.score === 'number'
                    ? ` (${(thought.score * 100).toFixed(1)}%)`
                    : '';

                ctx.fillStyle = '#00e5ff';
                ctx.font = '12px Arial';
                ctx.textAlign = 'center';
                ctx.fillText(
                    `ML: ${label}${scoreText}`,
                    p.x,
                    p.y - castleSize * 0.7
                );
            }

            // Player name below the tower
            ctx.fillStyle = 'white';
            ctx.font = 'bold 26px Arial';
            ctx.textAlign = 'center';
            const displayName = p.username || `Player ${p.id.substr(0, 4)}`;
            ctx.fillText(displayName, p.x, p.y + 18);

            // "YOU" Indicator
            if (myPlayer && p.id === myPlayer.id) {
                // Pulsing Ring
                const time = Date.now() / 500;
                const radius = 90 + Math.sin(time) * 8;
                ctx.strokeStyle = 'white';
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
                ctx.stroke();

                // "YOU" Label
                ctx.fillStyle = 'white';
                ctx.font = 'bold 28px Arial';
                ctx.fillText('YOU', p.x, p.y - 120);

                // Arrow
                ctx.beginPath();
                ctx.moveTo(p.x, p.y - 105);
                ctx.lineTo(p.x - 14, p.y - 130);
                ctx.lineTo(p.x + 14, p.y - 130);
                ctx.fill();
            }

            // Win Probability Display (for all players)
            if (gameState.aiWinProbabilities && gameState.aiWinProbabilities[p.id]) {
                const winProb = gameState.aiWinProbabilities[p.id];
                const probPercent = parseFloat(winProb.percentage);

                // Background box
                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                ctx.fillRect(p.x - 60, p.y + 40, 120, 35);

                // Border
                ctx.strokeStyle = p.color;
                ctx.lineWidth = 2;
                ctx.strokeRect(p.x - 60, p.y + 40, 120, 35);

                // Win probability text
                ctx.fillStyle = probPercent >= 50 ? '#4CAF50' : probPercent >= 30 ? '#FFC107' : '#F44336';
                ctx.font = 'bold 18px Arial';
                ctx.textAlign = 'center';
                ctx.fillText(`Win: ${winProb.percentage}%`, p.x, p.y + 60);

                // Probability bar
                ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
                ctx.fillRect(p.x - 55, p.y + 65, 110, 6);
                ctx.fillStyle = probPercent >= 50 ? '#4CAF50' : probPercent >= 30 ? '#FFC107' : '#F44336';
                ctx.fillRect(p.x - 55, p.y + 65, 110 * (probPercent / 100), 6);
            }

            if (p.eliminated) {
                ctx.fillStyle = 'rgba(0,0,0,0.7)';
                ctx.beginPath(); ctx.arc(p.x, p.y, 70, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = 'red';
                ctx.font = 'bold 40px Arial';
                ctx.fillText('X', p.x, p.y + 14);
            }
        });

        // Update and draw animated troops
        const now = Date.now();
        gameState.troops.forEach(t => {
            // Skip rendering the troop being dragged (we'll render it separately)
            if (draggingTroop && draggingTroop.id === t.id) {
                return;
            }

            // Get or create animation data
            let anim = troopAnimationsRef.current[t.id];
            if (!anim) {
                anim = {
                    startX: t.x,
                    startY: t.y,
                    targetX: t.x,
                    targetY: t.y,
                    currentX: t.x,
                    currentY: t.y,
                    startTime: now,
                    duration: 0
                };
                troopAnimationsRef.current[t.id] = anim;
            }

            // Calculate animated position with smooth interpolation
            let displayX, displayY;

            // Use linear interpolation for smoother real-time updates
            const lerpFactor = 0.2; // Interpolation speed (0-1, higher = faster)
            const dx = anim.targetX - anim.currentX;
            const dy = anim.targetY - anim.currentY;

            if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                // Smoothly lerp towards target
                displayX = anim.currentX + dx * lerpFactor;
                displayY = anim.currentY + dy * lerpFactor;
                anim.currentX = displayX;
                anim.currentY = displayY;
            } else {
                // Close enough, snap to target
                displayX = anim.targetX;
                displayY = anim.targetY;
                anim.currentX = displayX;
                anim.currentY = displayY;
            }

            // Apply stack offset so multiple troops in the same grid cell are visible
            const stack = troopStackLayout?.offsetById?.get(t.id);
            if (stack) {
                displayX += stack.dx;
                displayY += stack.dy;
            }

            const radius = 30;
            const iconImg = t.cardId ? troopIconImagesRef.current[t.cardId] : null;

            // Get owner's color
            const owner = gameState.players[t.ownerId];
            const ownerColor = owner ? owner.color : t.color;

            // Check if this troop has already moved
            const hasMoved = gameState.movedTroops && gameState.movedTroops.includes(t.id);

            // Draw colored background circle matching owner's tower
            ctx.save();
            ctx.beginPath();
            ctx.arc(displayX, displayY, radius + 8, 0, Math.PI * 2);
            ctx.fillStyle = hasMoved ? 'rgba(128, 128, 128, 0.6)' : ownerColor;
            ctx.fill();

            // Add white border around background
            ctx.strokeStyle = hasMoved ? 'rgba(255, 255, 255, 0.5)' : 'white';
            ctx.lineWidth = 3;
            ctx.stroke();
            ctx.restore();

            if (t.isTurret) {
                // Special rendering for turret
                ctx.save();
                ctx.fillStyle = '#FF6B35';
                ctx.beginPath();
                ctx.arc(displayX, displayY, radius, 0, Math.PI * 2);
                ctx.fill();

                // Draw turret barrel
                ctx.strokeStyle = '#8B4513';
                ctx.lineWidth = 6;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(displayX, displayY);
                // Point barrel towards last shot target (fallback: upward)
                const aim = turretAimRef.current[t.id];
                const angle = aim && (Date.now() - aim.time) < 1500 ? aim.angle : Math.atan2(0, -1);
                ctx.lineTo(displayX + Math.cos(angle) * (radius + 10), displayY + Math.sin(angle) * (radius + 10));
                ctx.stroke();

                // Draw turret base
                ctx.fillStyle = '#4A4A4A';
                ctx.beginPath();
                ctx.arc(displayX, displayY, radius * 0.6, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            } else if (iconImg && iconImg.complete) {
                // Icon avatar with circular mask
                ctx.save();
                ctx.beginPath();
                ctx.arc(displayX, displayY, radius, 0, Math.PI * 2);
                ctx.closePath();
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.fill();

                ctx.save();
                ctx.beginPath();
                ctx.arc(displayX, displayY, radius - 2, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(iconImg, displayX - radius, displayY - radius, radius * 2, radius * 2);
                ctx.restore();
                ctx.restore();
            } else {
                // Fallback colored orb
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.beginPath();
                ctx.arc(displayX, displayY, radius, 0, Math.PI * 2);
                ctx.fill();
            }

            // Troop HP
            ctx.fillStyle = 'red';
            ctx.fillRect(displayX - 30, displayY - 40, 60, 7);
            ctx.fillStyle = 'lime';
            ctx.fillRect(displayX - 30, displayY - 40, 60 * (t.hp / t.maxHp), 7);

            // Simple attack animation: highlight when near an enemy
            let isAttacking = false;
            let attackTarget = null;
            let minDist = Infinity;

            gameState.troops.forEach(other => {
                if (other.ownerId === t.ownerId) return;
                const otherAnim = troopAnimationsRef.current[other.id];
                const otherX = otherAnim ? otherAnim.currentX : other.x;
                const otherY = otherAnim ? otherAnim.currentY : other.y;
                const dist = Math.hypot(otherX - displayX, otherY - displayY);
                const attackRange = (t.range * CELL_SIZE + CELL_SIZE / 2);
                if (dist < minDist && dist <= attackRange) {
                    minDist = dist;
                    isAttacking = true;
                    attackTarget = { x: otherX, y: otherY };
                }
            });

            if (isAttacking && attackTarget) {
                const time = Date.now() / 200;
                const pulse = 2 + Math.sin(time) * 1.5;

                // Glow ring around attacker
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(displayX, displayY, radius + pulse, 0, Math.PI * 2);
                ctx.stroke();

                // Strike line towards target
                ctx.strokeStyle = 'rgba(255, 215, 0, 0.8)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(displayX, displayY);
                ctx.lineTo(attackTarget.x, attackTarget.y);
                ctx.stroke();
            }

            // Show "MOVED" indicator for troops that have already moved (in manual mode)
            if (hasMoved && gameState.movementMode === 'manual') {
                // Semi-transparent gray overlay
                ctx.save();
                ctx.globalAlpha = 0.7;
                ctx.fillStyle = 'rgba(50, 50, 50, 0.8)';
                ctx.beginPath();
                ctx.arc(displayX, displayY, radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();

                // "MOVED" text
                ctx.save();
                ctx.font = 'bold 12px Arial';
                ctx.fillStyle = 'white';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.strokeStyle = 'black';
                ctx.lineWidth = 3;
                ctx.strokeText('MOVED', displayX, displayY);
                ctx.fillText('MOVED', displayX, displayY);
                ctx.restore();

                // Checkmark icon
                ctx.save();
                ctx.strokeStyle = '#44ff44';
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                ctx.moveTo(displayX - 8, displayY + 15);
                ctx.lineTo(displayX - 3, displayY + 20);
                ctx.lineTo(displayX + 8, displayY + 10);
                ctx.stroke();
                ctx.restore();
            }
        });

        // Draw stack counts (xN) once per cell so it's obvious multiple troops share the same square
        if (troopStackLayout?.cellInfo) {
            troopStackLayout.cellInfo.forEach(({ gridX, gridY, size }) => {
                if (size <= 1) return;
                const cx = gridX * CELL_SIZE + CELL_SIZE / 2;
                const cy = gridY * CELL_SIZE + CELL_SIZE / 2;
                const bx = cx + 18;
                const by = cy - 18;

                ctx.save();
                ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
                ctx.beginPath();
                ctx.arc(bx, by, 13, 0, Math.PI * 2);
                ctx.fill();

                ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
                ctx.lineWidth = 2;
                ctx.stroke();

                ctx.fillStyle = 'white';
                ctx.font = 'bold 14px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(`x${size}`, bx, by);
                ctx.restore();
            });
        }

        // Draw projectiles
        projectiles.forEach(projectile => {
            const elapsed = now - projectile.startTime;
            const progress = Math.min(elapsed / projectile.duration, 1);

            // Calculate current position
            const currentX = projectile.fromX + (projectile.toX - projectile.fromX) * progress;
            const currentY = projectile.fromY + (projectile.toY - projectile.fromY) * progress;

            // Draw projectile (animated pellet)
            ctx.save();
            ctx.globalAlpha = 1 - progress * 0.3; // Fade slightly as it travels
            ctx.fillStyle = projectile.color;
            ctx.shadowColor = projectile.color;
            ctx.shadowBlur = 10;

            // Draw pellet with trail effect
            ctx.beginPath();
            ctx.arc(currentX, currentY, 6, 0, Math.PI * 2);
            ctx.fill();

            // Draw trail
            if (progress > 0.1) {
                const trailX = projectile.fromX + (projectile.toX - projectile.fromX) * (progress - 0.1);
                const trailY = projectile.fromY + (projectile.toY - projectile.fromY) * (progress - 0.1);
                ctx.globalAlpha = 0.3;
                ctx.beginPath();
                ctx.arc(trailX, trailY, 4, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.restore();
        });

        // Draw the dragging troop at cursor position
        if (draggingTroop && dragOffset) {
            const t = draggingTroop;
            const displayX = dragOffset.x;
            const displayY = dragOffset.y;
            const radius = 30;
            const iconImg = t.cardId ? troopIconImagesRef.current[t.cardId] : null;

            // Get owner's color
            const owner = gameState.players[t.ownerId];
            const ownerColor = owner ? owner.color : t.color;

            // Draw colored background circle with slight transparency and glow
            ctx.save();
            ctx.globalAlpha = 0.9;
            ctx.shadowColor = ownerColor;
            ctx.shadowBlur = 20;
            ctx.beginPath();
            ctx.arc(displayX, displayY, radius + 8, 0, Math.PI * 2);
            ctx.fillStyle = ownerColor;
            ctx.fill();

            // Add white border
            ctx.shadowBlur = 0;
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 3;
            ctx.stroke();
            ctx.restore();

            // Draw the troop icon
            if (t.isTurret) {
                // Special rendering for turret
                ctx.save();
                ctx.fillStyle = '#FF6B35';
                ctx.beginPath();
                ctx.arc(displayX, displayY, radius, 0, Math.PI * 2);
                ctx.fill();

                // Draw turret barrel
                ctx.strokeStyle = '#8B4513';
                ctx.lineWidth = 6;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(displayX, displayY);
                const aim = turretAimRef.current[t.id];
                const angle = aim && (Date.now() - aim.time) < 1500 ? aim.angle : Math.atan2(0, -1);
                ctx.lineTo(displayX + Math.cos(angle) * (radius + 10), displayY + Math.sin(angle) * (radius + 10));
                ctx.stroke();

                // Draw turret base
                ctx.fillStyle = '#4A4A4A';
                ctx.beginPath();
                ctx.arc(displayX, displayY, radius * 0.6, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            } else if (iconImg && iconImg.complete) {
                ctx.save();
                ctx.beginPath();
                ctx.arc(displayX, displayY, radius, 0, Math.PI * 2);
                ctx.closePath();
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.fill();

                ctx.save();
                ctx.beginPath();
                ctx.arc(displayX, displayY, radius - 2, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(iconImg, displayX - radius, displayY - radius, radius * 2, radius * 2);
                ctx.restore();
                ctx.restore();
            } else {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.beginPath();
                ctx.arc(displayX, displayY, radius, 0, Math.PI * 2);
                ctx.fill();
            }

            // HP bar
            ctx.fillStyle = 'red';
            ctx.fillRect(displayX - 30, displayY - 40, 60, 7);
            ctx.fillStyle = 'lime';
            ctx.fillRect(displayX - 30, displayY - 40, 60 * (t.hp / t.maxHp), 7);
        }

        ctx.restore();

    }, [gameState, myPlayer, mountainXRef.current, draggingTroop, dragOffset, renderTick]);

    // Continuous animation loop for smooth dragging
    useEffect(() => {
        if (!draggingTroop) return;

        let animationFrameId;
        const animate = () => {
            // Force a re-render by updating the render tick
            // This ensures the canvas re-renders smoothly during dragging
            setRenderTick(tick => tick + 1);
            animationFrameId = requestAnimationFrame(animate);
        };

        animationFrameId = requestAnimationFrame(animate);

        return () => {
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
            }
        };
    }, [draggingTroop]);

    const handleJoin = () => {
        const validation = validateUsername(username);
        if (!validation.ok) {
            showToast(validation.reason, 'error');
            return;
        }
        const sanitizedUsername = validation.username;

        // Validate game ID
        if (!gameId || gameId.trim().length === 0) {
            showToast('Please select a room', 'error');
            return;
        }

        const selectedStatus = roomStatusById?.[gameId];
        if (selectedStatus?.inGame) {
            showToast('Room is in game. Please choose another room.', 'error');
            return;
        }

        // Check connection status
        if (connectionStatus !== 'connected') {
            showToast('Not connected to server. Please wait...', 'error');
            return;
        }

        try {
            setJoinPending(true);
            pendingJoinGameIdRef.current = gameId;
            socket.emit('joinGame', { gameId, username: sanitizedUsername, movementMode });
            // Cache last successful join info so we can auto-rejoin on transient disconnects
            lastJoinInfoRef.current = {
                gameId,
                username: sanitizedUsername,
                movementMode
            };
            showToast(`Joining ${gameId}...`, 'info');
        } catch (error) {
            console.error('Error joining game:', error);
            setJoinPending(false);
            pendingJoinGameIdRef.current = null;
            showToast('Failed to join game. Please try again.', 'error');
        }
    };

    const handleStart = () => {
        if (connectionStatus !== 'connected') {
            showToast('Not connected to server. Please wait...', 'error');
            return;
        }

        try {
            socket.emit('forceStart', gameId);
            showToast('Starting game...', 'info');
        } catch (error) {
            console.error('Error starting game:', error);
            showToast('Failed to start game. Please try again.', 'error');
        }
    };

    const getPlayerQuadrant = (player) => {
        // Determine which quadrant the player is in based on position relative to X diagonals
        const gridX = player.gridX;
        const gridY = player.gridY;

        // Diagonal 1: y = x
        // Diagonal 2: y = (GRID_SIZE - 1 - x)
        const aboveDiag1 = gridY < gridX;
        const aboveDiag2 = gridY < (GRID_SIZE - 1 - gridX);

        // North: Above both diagonals (top position: gridY = 2, gridX = 10)
        if (aboveDiag1 && aboveDiag2) return 'north';
        // East: Below diag1, above diag2 (right position: gridY = 10, gridX = 17)
        if (!aboveDiag1 && aboveDiag2) return 'east';
        // South: Below both diagonals (bottom position: gridY = 17, gridX = 10)
        if (!aboveDiag1 && !aboveDiag2) return 'south';
        // West: Above diag1, below diag2 (left position: gridY = 10, gridX = 2)
        if (aboveDiag1 && !aboveDiag2) return 'west';

        return null;
    };

    const isInPlayerQuadrant = (gridX, gridY, player) => {
        const quadrant = getPlayerQuadrant(player);
        if (!quadrant) return false;

        // Check if position is not in mountain
        const trenchSet = new Set(gameState.terrain.trench.map(t => `${t.x},${t.y}`));
        if (trenchSet.has(`${gridX},${gridY}`)) return false;

        // The X-shaped mountain creates 4 triangular regions
        // Diagonal 1: y = x (top-left to bottom-right)
        // Diagonal 2: y = (GRID_SIZE - 1 - x) (top-right to bottom-left)

        // Determine which quadrant based on position relative to diagonals
        const aboveDiag1 = gridY < gridX;  // Above/left of main diagonal
        const aboveDiag2 = gridY < (GRID_SIZE - 1 - gridX);  // Above/right of anti-diagonal

        // North quadrant: Above both diagonals (top point)
        if (aboveDiag1 && aboveDiag2) {
            return quadrant === 'north';
        }
        // East quadrant: Below diag1, above diag2 (right point)
        if (!aboveDiag1 && aboveDiag2) {
            return quadrant === 'east';
        }
        // South quadrant: Below both diagonals (bottom point)
        if (!aboveDiag1 && !aboveDiag2) {
            return quadrant === 'south';
        }
        // West quadrant: Above diag1, below diag2 (left point)
        if (aboveDiag1 && !aboveDiag2) {
            return quadrant === 'west';
        }

        return false;
    };

    const handleCanvasClick = (e) => {
        if (!selectedCard || !myPlayer || myPlayer.eliminated || !canvasRef.current || gameState.status !== 'playing') return;
        // Turn-based: only deploy on your turn
        if (gameState.currentTurn !== socket.id) return;

        if (selectedCard.type === 'defense') {
            // Defensive units need grid placement
            const canvas = canvasRef.current;
            const rect = canvas.getBoundingClientRect();
            const scale = Math.min(rect.width / MAP_SIZE, rect.height / MAP_SIZE);
            const offsetX = (rect.width - MAP_SIZE * scale) / 2;
            const offsetY = (rect.height - MAP_SIZE * scale) / 2;

            const clickX = (e.clientX - rect.left - offsetX) / scale;
            const clickY = (e.clientY - rect.top - offsetY) / scale;

            const gridX = Math.floor(clickX / CELL_SIZE);
            const gridY = Math.floor(clickY / CELL_SIZE);

            // Check if valid placement in player's quadrant
            if (isInPlayerQuadrant(gridX, gridY, myPlayer)) {
                socket.emit('deployCard', {
                    gameId,
                    cardId: selectedCard.id,
                    gridX,
                    gridY
                });
                setSelectedCard(null);
                setPlacementMode(false);
            }
        } else {
            // Offensive units need target selection
            setPendingOffensiveCard(selectedCard);
            setTargetSelectionMode(true);
            setSelectedCard(null);
        }
    };

    const handleTargetSelection = (targetBaseId) => {
        if (!pendingOffensiveCard) return;

        socket.emit('deployCard', {
            gameId,
            cardId: pendingOffensiveCard.id,
            targetBaseId
        });

        setPendingOffensiveCard(null);
        setTargetSelectionMode(false);
    };

    const calculatePossibleMoves = (troop) => {
        if (!troop || !gameState) return [];

        const moves = [];
        const maxDistance = Math.floor(troop.speed);
        const trenchSet = new Set(gameState.terrain.trench.map(t => `${t.x},${t.y}`));

        // BFS to find all reachable cells within speed limit
        const queue = [{ x: troop.gridX, y: troop.gridY, dist: 0 }];
        const visited = new Set([`${troop.gridX},${troop.gridY}`]);

        while (queue.length > 0) {
            const current = queue.shift();

            if (current.dist < maxDistance) {
                const neighbors = [
                    { x: current.x + 1, y: current.y },
                    { x: current.x - 1, y: current.y },
                    { x: current.x, y: current.y + 1 },
                    { x: current.x, y: current.y - 1 }
                ];

                for (const neighbor of neighbors) {
                    const key = `${neighbor.x},${neighbor.y}`;

                    if (!visited.has(key) &&
                        neighbor.x >= 0 && neighbor.x < GRID_SIZE &&
                        neighbor.y >= 0 && neighbor.y < GRID_SIZE &&
                        !trenchSet.has(key)) {
                        visited.add(key);
                        queue.push({ ...neighbor, dist: current.dist + 1 });
                        if (current.dist + 1 <= maxDistance) {
                            moves.push({ gridX: neighbor.x, gridY: neighbor.y });
                        }
                    }
                }
            }
        }

        return moves;
    };

    const handleCanvasMouseDown = (e) => {
        if (!canvasRef.current || !gameState || !myPlayer) return;
        if (gameState.movementMode !== 'manual') return;
        if (gameState.currentTurn !== socket.id) return;

        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        const scale = Math.min(rect.width / MAP_SIZE, rect.height / MAP_SIZE);
        const offsetX = (rect.width - MAP_SIZE * scale) / 2;
        const offsetY = (rect.height - MAP_SIZE * scale) / 2;

        const mouseX = (e.clientX - rect.left - offsetX) / scale;
        const mouseY = (e.clientY - rect.top - offsetY) / scale;

        // Check if clicking on a troop (use animated position)
        const clickedTroop = gameState.troops.find(t => {
            const anim = troopAnimationsRef.current[t.id];
            const stack = troopStackLayout?.offsetById?.get(t.id);
            const tx = (anim?.currentX || t.x) + (stack?.dx || 0);
            const ty = (anim?.currentY || t.y) + (stack?.dy || 0);
            const dist = Math.sqrt(Math.pow(tx - mouseX, 2) + Math.pow(ty - mouseY, 2));
            return dist < 40 && t.ownerId === myPlayer.id;
        });

        if (clickedTroop) {
            // Check if troop has already moved
            const alreadyMoved = Array.isArray(gameState.movedTroops)
                ? gameState.movedTroops.includes(clickedTroop.id)
                : false;

            if (alreadyMoved) {
                // Show notification that this troop can't move
                setMoveNotification({
                    message: 'This troop has already moved this turn!',
                    type: 'warning'
                });
                setTimeout(() => setMoveNotification(null), 2500);
                return;
            }

            setDraggingTroop(clickedTroop);
            setDragOffset({ x: mouseX, y: mouseY });
            setPossibleMoves(calculatePossibleMoves(clickedTroop));
        }
    };

    const handleCanvasMouseMove = (e) => {
        if (!canvasRef.current) return;

        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        const scale = Math.min(rect.width / MAP_SIZE, rect.height / MAP_SIZE);
        const offsetX = (rect.width - MAP_SIZE * scale) / 2;
        const offsetY = (rect.height - MAP_SIZE * scale) / 2;

        const mouseX = (e.clientX - rect.left - offsetX) / scale;
        const mouseY = (e.clientY - rect.top - offsetY) / scale;

        const gridX = Math.floor(mouseX / CELL_SIZE);
        const gridY = Math.floor(mouseY / CELL_SIZE);

        // Update dragging troop position
        if (draggingTroop) {
            setDragOffset({ x: mouseX, y: mouseY });
        }

        // Update hovered cell for placement mode
        if (placementMode && selectedCard?.type === 'defense') {
            setHoveredCell({ gridX, gridY });
        } else {
            setHoveredCell(null);
        }

        // Check for hovered troops (only when not dragging)
        if (gameState && gameState.troops && !draggingTroop) {
            const hoveredTroopData = gameState.troops.find(t => {
                const anim = troopAnimationsRef.current[t.id];
                const stack = troopStackLayout?.offsetById?.get(t.id);
                const tx = (anim?.currentX || t.x) + (stack?.dx || 0);
                const ty = (anim?.currentY || t.y) + (stack?.dy || 0);
                const dist = Math.hypot(mouseX - tx, mouseY - ty);
                return dist < 30; // 30px radius
            });
            setHoveredTroop(hoveredTroopData || null);
        }
    };

    const handleCanvasMouseUp = (e) => {
        if (!draggingTroop || !canvasRef.current || !gameState) {
            setDraggingTroop(null);
            setPossibleMoves([]);
            return;
        }

        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        const scale = Math.min(rect.width / MAP_SIZE, rect.height / MAP_SIZE);
        const offsetX = (rect.width - MAP_SIZE * scale) / 2;
        const offsetY = (rect.height - MAP_SIZE * scale) / 2;

        const mouseX = (e.clientX - rect.left - offsetX) / scale;
        const mouseY = (e.clientY - rect.top - offsetY) / scale;

        const targetGridX = Math.floor(mouseX / CELL_SIZE);
        const targetGridY = Math.floor(mouseY / CELL_SIZE);

        // Check if target is in possible moves
        const validMove = possibleMoves.find(m => m.gridX === targetGridX && m.gridY === targetGridY);

        if (validMove) {
            // Send move command to server
            socket.emit('moveTroop', {
                gameId,
                troopId: draggingTroop.id,
                targetGridX,
                targetGridY
            });
        }

        setDraggingTroop(null);
        setPossibleMoves([]);
    };

    const handleEndTurn = () => {
        if (gameState && gameState.currentTurn === socket.id) {
            socket.emit('endTurn', gameId);
        }
    };

    if (!joined || showLobby) {
        return (
            <div className="lobby">
                <h1 className="lobby-title">Oceanic.io</h1>

                {/* Tab Navigation */}
                <div className="lobby-tabs" role="tablist" aria-label="Home tabs">
                    <button
                        onClick={() => setCurrentTab('lobby')}
                        className={`tab-button ${currentTab === 'lobby' ? 'active' : ''}`}
                        role="tab"
                        aria-selected={currentTab === 'lobby'}
                    >
                        Game
                    </button>
                    <button
                        onClick={() => setCurrentTab('training')}
                        className={`tab-button ${currentTab === 'training' ? 'active training' : ''}`}
                        role="tab"
                        aria-selected={currentTab === 'training'}
                    >
                        Training
                    </button>
                </div>

                {currentTab === 'lobby' && (
                    <>
                        <div className="lobby-section">
                            <label>Username</label>
                            <input
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(sanitizeUsernameInput(e.target.value))}
                                onKeyDown={(e) => {
                                    if (e.key === ' ') e.preventDefault();
                                }}
                                placeholder="Enter your username"
                                maxLength={USERNAME_RULES.USERNAME_MAX_LEN}
                            />
                        </div>

                        <div className="lobby-section">
                            <label>Select Room</label>
                            <div className="room-grid">
                                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(num => {
                                    const roomId = `room${num}`;
                                    const status = roomStatusById?.[roomId];
                                    const playerCount = typeof status?.playerCount === 'number' ? status.playerCount : 0;
                                    const maxPlayers = typeof status?.maxPlayers === 'number' ? status.maxPlayers : 4;
                                    const inGame = !!status?.inGame;

                                    return (
                                        <button
                                            key={num}
                                            className={`room-button ${selectedRoom === roomId ? 'selected' : ''} ${inGame ? 'in-game' : ''}`}
                                            disabled={inGame}
                                            onClick={() => {
                                                if (inGame) return;
                                                setSelectedRoom(roomId);
                                                setGameId(roomId);
                                            }}
                                        >
                                            <div className="room-title">Room {num}</div>
                                            <div className="room-meta">
                                                <span className="room-count">{playerCount} / {maxPlayers}</span>
                                                {inGame && <span className="room-in-game-tag">In game</span>}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="lobby-buttons single">
                            <button className="join-button" onClick={handleJoin} disabled={joinPending}>
                                {joinPending ? 'Joining...' : 'Join Game'}
                            </button>
                        </div>
                    </>
                )}

                {currentTab === 'training' && (
                    <>
                        {/* ML Training Mode Tab */}
                        <div className="lobby-section" style={{
                            background: 'linear-gradient(135deg, rgba(0, 229, 255, 0.15), rgba(156, 39, 176, 0.15))',
                            border: '2px solid #00e5ff',
                            borderRadius: '15px',
                            padding: '25px',
                            marginTop: '20px'
                        }}>
                            <h3 style={{ color: '#00e5ff', marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <span>🧠</span> ML Training Mode
                            </h3>
                            <p style={{ color: '#aaa', fontSize: '0.95rem', marginBottom: '15px' }}>
                                Train the TensorFlow model through self-play (ML bot vs baseline AI).
                            </p>

                            <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '15px', flexWrap: 'wrap' }}>
                                <label style={{ color: '#fff', fontWeight: 'bold' }}>Games to Run:</label>
                                <input
                                    type="number"
                                    min="10"
                                    max="1000"
                                    step="10"
                                    value={trainingGames}
                                    onChange={(e) => setTrainingGames(Math.min(1000, Math.max(10, parseInt(e.target.value) || 100)))}
                                    style={{
                                        padding: '8px 12px',
                                        background: 'rgba(0,0,0,0.3)',
                                        border: '1px solid #00e5ff',
                                        borderRadius: '8px',
                                        color: '#fff',
                                        fontSize: '1rem',
                                        width: '100px'
                                    }}
                                />
                                <div style={{ display: 'flex', gap: '10px' }}>
                                    <button
                                        onClick={() => {
                                            socket.emit('startMLTraining', { games: trainingGames });
                                        }}
                                        disabled={trainingStatus?.isRunning}
                                        style={{
                                            padding: '10px 20px',
                                            background: trainingStatus?.isRunning ? '#666' : 'linear-gradient(135deg, #00e5ff, #0088cc)',
                                            border: 'none',
                                            borderRadius: '8px',
                                            color: '#fff',
                                            fontSize: '1rem',
                                            fontWeight: 'bold',
                                            cursor: trainingStatus?.isRunning ? 'not-allowed' : 'pointer',
                                            transition: 'all 0.3s'
                                        }}
                                    >
                                        {trainingStatus?.isRunning ? '⏸️ Running...' : '▶️ Start Training'}
                                    </button>
                                    {trainingStatus?.isRunning && (
                                        <button
                                            onClick={() => socket.emit('stopMLTraining')}
                                            style={{
                                                padding: '10px 20px',
                                                background: 'linear-gradient(135deg, #ff5252, #c62828)',
                                                border: 'none',
                                                borderRadius: '8px',
                                                color: '#fff',
                                                fontSize: '1rem',
                                                fontWeight: 'bold',
                                                cursor: 'pointer',
                                                transition: 'all 0.3s'
                                            }}
                                        >
                                            ⏹️ Stop
                                        </button>
                                    )}
                                </div>
                            </div>

                            {trainingStatus && (
                                <div style={{
                                    background: 'rgba(0,0,0,0.4)',
                                    padding: '15px',
                                    borderRadius: '10px',
                                    border: '1px solid rgba(0, 229, 255, 0.3)'
                                }}>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '15px', marginBottom: '10px' }}>
                                        <div style={{ textAlign: 'center' }}>
                                            <div style={{ fontSize: '0.85rem', color: '#aaa', marginBottom: '5px' }}>Progress</div>
                                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#00e5ff' }}>
                                                {trainingStatus.gamesCompleted} / {trainingStatus.totalGames}
                                            </div>
                                        </div>
                                        <div style={{ textAlign: 'center' }}>
                                            <div style={{ fontSize: '0.85rem', color: '#aaa', marginBottom: '5px' }}>ML Wins</div>
                                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#4CAF50' }}>
                                                {trainingStatus.mlWins} ({(trainingStatus.mlWinRate * 100).toFixed(1)}%)
                                            </div>
                                        </div>
                                        <div style={{ textAlign: 'center' }}>
                                            <div style={{ fontSize: '0.85rem', color: '#aaa', marginBottom: '5px' }}>Baseline Wins</div>
                                            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#F44336' }}>
                                                {trainingStatus.baselineWins} ({(trainingStatus.baselineWinRate * 100).toFixed(1)}%)
                                            </div>
                                        </div>
                                    </div>

                                    {/* Progress bar */}
                                    <div style={{
                                        width: '100%',
                                        height: '8px',
                                        background: 'rgba(255,255,255,0.1)',
                                        borderRadius: '4px',
                                        overflow: 'hidden',
                                        marginTop: '10px'
                                    }}>
                                        <div style={{
                                            width: `${(trainingStatus.gamesCompleted / trainingStatus.totalGames) * 100}%`,
                                            height: '100%',
                                            background: 'linear-gradient(90deg, #00e5ff, #0088cc)',
                                            transition: 'width 0.3s'
                                        }}></div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <p style={{ color: '#aaa', fontSize: '0.95rem', marginTop: '30px', textAlign: 'center', maxWidth: '800px', margin: '30px auto 0' }}>
                            Train the ML bot through self-play battles. The neural network learns from each game and updates its strategy in real-time.
                            Watch the graphs below to see improvement over time!
                        </p>

                        <div className="lobby-buttons" style={{ gridTemplateColumns: '1fr' }}>
                            <button
                                className="ai-stats-button"
                                onClick={() => {
                                    setAiStatsData(null);
                                    socket.emit('getAIStats');
                                    setShowAIStats(true);
                                }}
                            >
                                AI Stats
                            </button>
                        </div>
                    </>
                )}

                {showAIStats && (
                    <div
                        className="modal-overlay"
                        onMouseDown={(e) => {
                            if (e.target === e.currentTarget) setShowAIStats(false);
                        }}
                        role="presentation"
                    >
                        <div className="modal-panel ai-stats-modal-panel" role="dialog" aria-modal="true" aria-label="AI Stats">
                            <div className="modal-header">
                                <div className="modal-title">AI Stats</div>
                                <button
                                    ref={aiStatsCloseBtnRef}
                                    type="button"
                                    className="modal-close"
                                    onClick={() => setShowAIStats(false)}
                                    aria-label="Close AI stats"
                                >
                                    ×
                                </button>
                            </div>

                            <div className="modal-body">
                                {!aiStatsData ? (
                                    <div className="modal-loading">Loading…</div>
                                ) : (
                                    <>
                                        <h2 style={{ textAlign: 'center', color: '#00bfff', fontSize: '2rem', margin: '6px 0 18px 0' }}>
                                            AI Performance
                                        </h2>

                            <div className="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '40px' }}>
                                <div className="stat-card" style={{ background: 'rgba(255,255,255,0.1)', padding: '20px', borderRadius: '10px', textAlign: 'center' }}>
                                    <div style={{ fontSize: '1.2rem', color: '#aaa' }}>Total Games</div>
                                    <div style={{ fontSize: '2.5rem', fontWeight: 'bold' }}>{aiStatsData.totalGames}</div>
                                </div>
                                <div className="stat-card" style={{ background: 'rgba(255,255,255,0.1)', padding: '20px', borderRadius: '10px', textAlign: 'center' }}>
                                    <div style={{ fontSize: '1.2rem', color: '#aaa' }}>Wins</div>
                                    <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: '#4CAF50' }}>{aiStatsData.wins}</div>
                                </div>
                                <div className="stat-card" style={{ background: 'rgba(255,255,255,0.1)', padding: '20px', borderRadius: '10px', textAlign: 'center' }}>
                                    <div style={{ fontSize: '1.2rem', color: '#aaa' }}>Losses</div>
                                    <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: '#F44336' }}>{aiStatsData.losses}</div>
                                </div>
                                <div className="stat-card" style={{ background: 'rgba(255,255,255,0.1)', padding: '20px', borderRadius: '10px', textAlign: 'center' }}>
                                    <div style={{ fontSize: '1.2rem', color: '#aaa' }}>Win Rate</div>
                                    <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: '#FFC107' }}>
                                        {aiStatsData.totalGames > 0 ? ((aiStatsData.wins / aiStatsData.totalGames) * 100).toFixed(1) : 0}%
                                    </div>
                                </div>
                                {aiStatsData.mlModel && (
                                    <div className="stat-card" style={{ background: 'rgba(0,150,136,0.2)', padding: '20px', borderRadius: '10px', textAlign: 'center' }}>
                                        <div style={{ fontSize: '1.2rem', color: '#aaa' }}>TF Samples Seen</div>
                                        <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: '#4CAF50' }}>
                                            {aiStatsData.mlModel.sampleCount || 0}
                                        </div>
                                        <div style={{ fontSize: '0.9rem', color: '#ccc', marginTop: '8px' }}>
                                            Last Update:{' '}
                                            {aiStatsData.mlModel.lastUpdated
                                                ? new Date(aiStatsData.mlModel.lastUpdated).toLocaleTimeString()
                                                : 'Pending'}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* AI vs Humans Stats */}
                            {aiStatsData.vsHumans && aiStatsData.vsHumans.games > 0 && (
                                <div style={{
                                    background: 'rgba(0, 191, 255, 0.1)',
                                    border: '2px solid #00bfff',
                                    borderRadius: '15px',
                                    padding: '20px',
                                    marginBottom: '40px'
                                }}>
                                    <h3 style={{ color: '#00bfff', marginBottom: '20px', textAlign: 'center' }}>
                                        👤 Performance vs Humans
                                    </h3>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '15px' }}>
                                        <div style={{ background: 'rgba(255,255,255,0.1)', padding: '15px', borderRadius: '10px', textAlign: 'center' }}>
                                            <div style={{ fontSize: '1rem', color: '#aaa' }}>Games vs Humans</div>
                                            <div style={{ fontSize: '2rem', fontWeight: 'bold' }}>{aiStatsData.vsHumans.games}</div>
                                        </div>
                                        <div style={{ background: 'rgba(255,255,255,0.1)', padding: '15px', borderRadius: '10px', textAlign: 'center' }}>
                                            <div style={{ fontSize: '1rem', color: '#aaa' }}>Wins</div>
                                            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#4CAF50' }}>{aiStatsData.vsHumans.wins}</div>
                                        </div>
                                        <div style={{ background: 'rgba(255,255,255,0.1)', padding: '15px', borderRadius: '10px', textAlign: 'center' }}>
                                            <div style={{ fontSize: '1rem', color: '#aaa' }}>Losses</div>
                                            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#F44336' }}>{aiStatsData.vsHumans.losses}</div>
                                        </div>
                                        <div style={{ background: 'rgba(255,255,255,0.1)', padding: '15px', borderRadius: '10px', textAlign: 'center' }}>
                                            <div style={{ fontSize: '1rem', color: '#aaa' }}>Win Rate</div>
                                            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#FFC107' }}>
                                                {((aiStatsData.vsHumans.wins / aiStatsData.vsHumans.games) * 100).toFixed(1)}%
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            <h3 style={{ color: '#00bfff', borderBottom: '1px solid #00bfff', paddingBottom: '10px', marginBottom: '20px' }}>
                                📈 Win/Loss Ratio vs Games Played (vs Humans)
                            </h3>

                            <div className="chart-container" style={{
                                height: 'min(400px, 55vh)',
                                background: 'rgba(0,0,0,0.3)',
                                borderRadius: '10px',
                                padding: '20px',
                                marginBottom: '40px',
                                position: 'relative'
                            }}>
                                {(() => {
                                    // Filter for games against humans only
                                    const history = (aiStatsData.gameHistory || [])
                                        .filter(game => game.vsHuman);

                                    if (history.length === 0) {
                                        return (
                                            <div style={{
                                                display: 'flex',
                                                justifyContent: 'center',
                                                alignItems: 'center',
                                                height: '100%',
                                                color: '#aaa',
                                                fontSize: '1.2rem'
                                            }}>
                                                No games against humans yet. Play some games to see statistics!
                                            </div>
                                        );
                                    }

                                    // Calculate win/loss ratio at each game
                                    let wins = 0;
                                    let losses = 0;
                                    const dataPoints = history.map((game, i) => {
                                        if (game.aiWon) {
                                            wins++;
                                        } else {
                                            losses++;
                                        }
                                        const gamesPlayed = i + 1;
                                        const ratio = losses === 0 ? wins : wins / losses;
                                        const winRate = (wins / gamesPlayed) * 100;
                                        return {
                                            gamesPlayed,
                                            ratio,
                                            wins,
                                            losses,
                                            winRate
                                        };
                                    });

                                    const maxGames = dataPoints[dataPoints.length - 1].gamesPlayed;
                                    const maxRatio = Math.max(...dataPoints.map(p => p.ratio), 2); // At least 2 for scale
                                    const chartHeight = 300;

                                    return (
                                        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                                            {/* Y-axis labels (Win/Loss Ratio) */}
                                            <div style={{
                                                position: 'absolute',
                                                left: 0,
                                                top: 0,
                                                bottom: 60,
                                                width: '50px',
                                                display: 'flex',
                                                flexDirection: 'column',
                                                justifyContent: 'space-between',
                                                fontSize: '0.8rem',
                                                color: '#aaa',
                                                paddingRight: '5px',
                                                textAlign: 'right'
                                            }}>
                                                <div>{maxRatio.toFixed(1)}</div>
                                                <div>{(maxRatio * 0.75).toFixed(1)}</div>
                                                <div>{(maxRatio * 0.5).toFixed(1)}</div>
                                                <div>{(maxRatio * 0.25).toFixed(1)}</div>
                                                <div>0.0</div>
                                            </div>

                                            {/* Y-axis label */}
                                            <div style={{
                                                position: 'absolute',
                                                left: '-5px',
                                                top: '50%',
                                                transform: 'rotate(-90deg) translateX(-50%)',
                                                transformOrigin: 'left center',
                                                fontSize: '0.9rem',
                                                color: '#00bfff',
                                                fontWeight: 'bold',
                                                whiteSpace: 'nowrap'
                                            }}>
                                                Win/Loss Ratio
                                            </div>

                                            {/* Chart area */}
                                            <div style={{ marginLeft: '60px', marginRight: '20px', height: '100%', position: 'relative' }}>
                                                {/* Grid lines */}
                                                {[0, 0.25, 0.5, 0.75, 1].map(fraction => (
                                                    <div key={fraction} style={{
                                                        position: 'absolute',
                                                        left: 0,
                                                        right: 0,
                                                        bottom: `${60 + (fraction * chartHeight)}px`,
                                                        height: '1px',
                                                        background: fraction === 0.5 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)'
                                                    }} />
                                                ))}

                                                {/* 1.0 ratio reference line (50% win rate) */}
                                                <div style={{
                                                    position: 'absolute',
                                                    left: 0,
                                                    right: 0,
                                                    bottom: `${60 + ((1.0 / maxRatio) * chartHeight)}px`,
                                                    height: '2px',
                                                    background: 'rgba(255, 193, 7, 0.5)',
                                                    borderTop: '2px dashed rgba(255, 193, 7, 0.8)'
                                                }}>
                                                    <div style={{
                                                        position: 'absolute',
                                                        right: '5px',
                                                        top: '-10px',
                                                        fontSize: '0.75rem',
                                                        color: '#FFC107',
                                                        background: 'rgba(0,0,0,0.7)',
                                                        padding: '2px 6px',
                                                        borderRadius: '3px'
                                                    }}>
                                                        1:1 (50%)
                                                    </div>
                                                </div>

                                                {/* Line chart */}
                                                <svg style={{
                                                    position: 'absolute',
                                                    bottom: '60px',
                                                    left: 0,
                                                    width: '100%',
                                                    height: chartHeight,
                                                    overflow: 'visible'
                                                }}>
                                                    {/* Area fill under the line */}
                                                    <defs>
                                                        <linearGradient id="areaGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                                                            <stop offset="0%" stopColor="#00bfff" stopOpacity="0.3" />
                                                            <stop offset="100%" stopColor="#00bfff" stopOpacity="0.05" />
                                                        </linearGradient>
                                                    </defs>

                                                    {/* Area polygon */}
                                                    <polygon
                                                        points={
                                                            `0,${chartHeight} ` +
                                                            dataPoints.map((point) => {
                                                                const x = (point.gamesPlayed / maxGames) * 100;
                                                                const y = chartHeight - ((point.ratio / maxRatio) * chartHeight);
                                                                return `${x}%,${y}`;
                                                            }).join(' ') +
                                                            ` 100%,${chartHeight}`
                                                        }
                                                        fill="url(#areaGradient)"
                                                    />

                                                    {/* Main line */}
                                                    <polyline
                                                        points={dataPoints.map((point) => {
                                                            const x = (point.gamesPlayed / maxGames) * 100;
                                                            const y = chartHeight - ((point.ratio / maxRatio) * chartHeight);
                                                            return `${x}%,${y}`;
                                                        }).join(' ')}
                                                        fill="none"
                                                        stroke="#00bfff"
                                                        strokeWidth="3"
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                    />

                                                    {/* Data points */}
                                                    {dataPoints.map((point, i) => {
                                                        const x = (point.gamesPlayed / maxGames) * 100;
                                                        const y = chartHeight - ((point.ratio / maxRatio) * chartHeight);
                                                        const isLabelPoint = i === dataPoints.length - 1 || point.gamesPlayed % 5 === 0;

                                                        return (
                                                            <g key={i}>
                                                                <circle
                                                                    cx={`${x}%`}
                                                                    cy={y}
                                                                    r={isLabelPoint ? "5" : "3"}
                                                                    fill={point.ratio >= 1 ? "#4CAF50" : "#F44336"}
                                                                    stroke="#001e3c"
                                                                    strokeWidth="2"
                                                                >
                                                                    <title>
                                                                        Game {point.gamesPlayed}: {point.wins}W-{point.losses}L
                                                                        {'\n'}Ratio: {point.ratio.toFixed(2)}
                                                                        {'\n'}Win Rate: {point.winRate.toFixed(1)}%
                                                                    </title>
                                                                </circle>
                                                                {isLabelPoint && (
                                                                    <text
                                                                        x={`${x}%`}
                                                                        y={y - 15}
                                                                        textAnchor="middle"
                                                                        fill="#00bfff"
                                                                        fontSize="11"
                                                                        fontWeight="bold"
                                                                    >
                                                                        {point.ratio.toFixed(1)}
                                                                    </text>
                                                                )}
                                                            </g>
                                                        );
                                                    })}
                                                </svg>

                                                {/* X-axis labels */}
                                                <div style={{
                                                    position: 'absolute',
                                                    bottom: '35px',
                                                    left: 0,
                                                    right: 0,
                                                    display: 'flex',
                                                    justifyContent: 'space-between',
                                                    fontSize: '0.8rem',
                                                    color: '#aaa'
                                                }}>
                                                    {[0, Math.floor(maxGames * 0.25), Math.floor(maxGames * 0.5), Math.floor(maxGames * 0.75), maxGames].map((games, i) => (
                                                        <div key={i}>{games}</div>
                                                    ))}
                                                </div>

                                                {/* X-axis label */}
                                                <div style={{
                                                    position: 'absolute',
                                                    bottom: '10px',
                                                    left: 0,
                                                    right: 0,
                                                    textAlign: 'center',
                                                    fontSize: '0.9rem',
                                                    color: '#00bfff',
                                                    fontWeight: 'bold'
                                                }}>
                                                    Number of Games Played
                                                </div>
                                            </div>

                                            {/* Legend */}
                                            <div style={{
                                                position: 'absolute',
                                                top: '10px',
                                                right: '30px',
                                                background: 'rgba(0,0,0,0.7)',
                                                padding: '12px',
                                                borderRadius: '8px',
                                                fontSize: '0.85rem',
                                                border: '1px solid rgba(0,191,255,0.3)'
                                            }}>
                                                <div style={{ marginBottom: '8px', fontWeight: 'bold', color: '#00bfff' }}>
                                                    Current Stats
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '5px' }}>
                                                    <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#4CAF50' }} />
                                                    <span>Ratio ≥ 1.0 (Winning)</span>
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '5px' }}>
                                                    <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#F44336' }} />
                                                    <span>Ratio &lt; 1.0 (Losing)</span>
                                                </div>
                                                <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.2)' }}>
                                                    <div style={{ fontSize: '0.75rem', color: '#aaa' }}>Total Games: {maxGames}</div>
                                                    <div style={{ fontSize: '0.75rem', color: '#aaa' }}>
                                                        Final Ratio: {dataPoints[dataPoints.length - 1].ratio.toFixed(2)}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>

                            <h3 style={{ color: '#00bfff', borderBottom: '1px solid #00bfff', paddingBottom: '10px', marginBottom: '20px' }}>
                                📊 Strategy Performance
                            </h3>

                            <div className="chart-container" style={{
                                height: '300px',
                                background: 'rgba(0,0,0,0.3)',
                                borderRadius: '10px',
                                padding: '20px',
                                marginBottom: '40px',
                                display: 'flex',
                                alignItems: 'flex-end',
                                gap: '2px',
                                position: 'relative'
                            }}>
                                {(() => {
                                    // Strategy Stats Graph
                                    const strategies = [
                                        { name: 'Defensive', ...aiStatsData.strategyStats.defensivePlays },
                                        { name: 'Offensive', ...aiStatsData.strategyStats.offensivePlays },
                                        { name: 'Early Game', ...aiStatsData.strategyStats.earlyGame },
                                        { name: 'Late Game', ...aiStatsData.strategyStats.lateGame }
                                    ];

                                    return (
                                        <div style={{ width: '100%', height: '100%', display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end' }}>
                                            {strategies.map((stat, i) => (
                                                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '15%' }}>
                                                    <div style={{ marginBottom: '10px', fontWeight: 'bold' }}>{(stat.winRate * 100).toFixed(1)}%</div>
                                                    <div style={{
                                                        width: '100%',
                                                        height: `${Math.max(5, stat.winRate * 200)}px`,
                                                        background: stat.winRate > 0.5 ? '#4CAF50' : '#F44336',
                                                        borderRadius: '5px 5px 0 0',
                                                        transition: 'height 1s ease-out'
                                                    }}></div>
                                                    <div style={{ marginTop: '10px', fontSize: '0.9rem', textAlign: 'center' }}>{stat.name}</div>
                                                    <div style={{ fontSize: '0.8rem', color: '#aaa' }}>({stat.count} plays)</div>
                                                </div>
                                            ))}
                                        </div>
                                    );
                                })()}
                            </div>

                            {/* ML Training History Graph */}
                            {aiStatsData.training && aiStatsData.training.history && aiStatsData.training.history.length > 0 && (
                                <>
                                    <h3 style={{ color: '#00bfff', borderBottom: '1px solid #00bfff', paddingBottom: '10px', marginBottom: '20px' }}>
                                        🧠 ML Training Progress
                                    </h3>

                                    <div className="chart-container" style={{
                                        height: '350px',
                                        background: 'rgba(0,0,0,0.3)',
                                        borderRadius: '10px',
                                        padding: '20px',
                                        marginBottom: '40px',
                                        position: 'relative'
                                    }}>
                                        {(() => {
                                            const history = aiStatsData.training.history;

                                            if (history.length === 0) {
                                                return (
                                                    <div style={{
                                                        display: 'flex',
                                                        justifyContent: 'center',
                                                        alignItems: 'center',
                                                        height: '100%',
                                                        color: '#aaa',
                                                        fontSize: '1.2rem'
                                                    }}>
                                                        No training data yet. Start training to see progress!
                                                    </div>
                                                );
                                            }

                                            const maxStep = history[history.length - 1].step;
                                            const chartHeight = 280;

                                            return (
                                                <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                                                    {/* Y-axis labels (Win Rate %) */}
                                                    <div style={{
                                                        position: 'absolute',
                                                        left: 0,
                                                        top: 0,
                                                        bottom: 50,
                                                        width: '50px',
                                                        display: 'flex',
                                                        flexDirection: 'column',
                                                        justifyContent: 'space-between',
                                                        fontSize: '0.8rem',
                                                        color: '#aaa',
                                                        paddingRight: '5px',
                                                        textAlign: 'right'
                                                    }}>
                                                        <div>100%</div>
                                                        <div>75%</div>
                                                        <div>50%</div>
                                                        <div>25%</div>
                                                        <div>0%</div>
                                                    </div>

                                                    {/* Y-axis label */}
                                                    <div style={{
                                                        position: 'absolute',
                                                        left: '-5px',
                                                        top: '50%',
                                                        transform: 'rotate(-90deg) translateX(-50%)',
                                                        transformOrigin: 'left center',
                                                        fontSize: '0.9rem',
                                                        color: '#00bfff',
                                                        fontWeight: 'bold',
                                                        whiteSpace: 'nowrap'
                                                    }}>
                                                        Win Rate (%)
                                                    </div>

                                                    {/* Chart area */}
                                                    <div style={{ marginLeft: '60px', marginRight: '20px', height: '100%', position: 'relative' }}>
                                                        {/* Grid lines */}
                                                        {[0, 0.25, 0.5, 0.75, 1].map(fraction => (
                                                            <div key={fraction} style={{
                                                                position: 'absolute',
                                                                left: 0,
                                                                right: 0,
                                                                bottom: `${50 + (fraction * chartHeight)}px`,
                                                                height: '1px',
                                                                background: fraction === 0.5 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)'
                                                            }} />
                                                        ))}

                                                        {/* 50% reference line */}
                                                        <div style={{
                                                            position: 'absolute',
                                                            left: 0,
                                                            right: 0,
                                                            bottom: `${50 + (0.5 * chartHeight)}px`,
                                                            height: '2px',
                                                            background: 'rgba(255, 193, 7, 0.5)',
                                                            borderTop: '2px dashed rgba(255, 193, 7, 0.8)'
                                                        }}>
                                                            <div style={{
                                                                position: 'absolute',
                                                                right: '5px',
                                                                top: '-10px',
                                                                fontSize: '0.75rem',
                                                                color: '#FFC107',
                                                                background: 'rgba(0,0,0,0.7)',
                                                                padding: '2px 6px',
                                                                borderRadius: '3px'
                                                            }}>
                                                                50% Baseline
                                                            </div>
                                                        </div>

                                                        {/* Line chart */}
                                                        <svg style={{
                                                            position: 'absolute',
                                                            bottom: '50px',
                                                            left: 0,
                                                            width: '100%',
                                                            height: chartHeight,
                                                            overflow: 'visible'
                                                        }}>
                                                            <defs>
                                                                <linearGradient id="mlGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                                                                    <stop offset="0%" stopColor="#4CAF50" stopOpacity="0.3" />
                                                                    <stop offset="100%" stopColor="#4CAF50" stopOpacity="0.05" />
                                                                </linearGradient>
                                                                <linearGradient id="baselineGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                                                                    <stop offset="0%" stopColor="#F44336" stopOpacity="0.3" />
                                                                    <stop offset="100%" stopColor="#F44336" stopOpacity="0.05" />
                                                                </linearGradient>
                                                            </defs>

                                                            {/* ML Win Rate Line */}
                                                            <polyline
                                                                points={history.map((point) => {
                                                                    const x = (point.step / maxStep) * 100;
                                                                    const y = chartHeight - (point.mlWinRate * chartHeight);
                                                                    return `${x}%,${y}`;
                                                                }).join(' ')}
                                                                fill="none"
                                                                stroke="#4CAF50"
                                                                strokeWidth="3"
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                            />

                                                            {/* Baseline Win Rate Line */}
                                                            <polyline
                                                                points={history.map((point) => {
                                                                    const x = (point.step / maxStep) * 100;
                                                                    const y = chartHeight - (point.baselineWinRate * chartHeight);
                                                                    return `${x}%,${y}`;
                                                                }).join(' ')}
                                                                fill="none"
                                                                stroke="#F44336"
                                                                strokeWidth="3"
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                            />

                                                            {/* Data points */}
                                                            {history.map((point, i) => {
                                                                const x = (point.step / maxStep) * 100;
                                                                const mlY = chartHeight - (point.mlWinRate * chartHeight);
                                                                const baselineY = chartHeight - (point.baselineWinRate * chartHeight);
                                                                const isLabelPoint = i === history.length - 1 || i % 2 === 0;

                                                                return (
                                                                    <g key={i}>
                                                                        {/* ML point */}
                                                                        <circle
                                                                            cx={`${x}%`}
                                                                            cy={mlY}
                                                                            r={isLabelPoint ? "5" : "3"}
                                                                            fill="#4CAF50"
                                                                            stroke="#001e3c"
                                                                            strokeWidth="2"
                                                                        >
                                                                            <title>
                                                                                Step {point.step}: ML {(point.mlWinRate * 100).toFixed(1)}%
                                                                            </title>
                                                                        </circle>

                                                                        {/* Baseline point */}
                                                                        <circle
                                                                            cx={`${x}%`}
                                                                            cy={baselineY}
                                                                            r={isLabelPoint ? "5" : "3"}
                                                                            fill="#F44336"
                                                                            stroke="#001e3c"
                                                                            strokeWidth="2"
                                                                        >
                                                                            <title>
                                                                                Step {point.step}: Baseline {(point.baselineWinRate * 100).toFixed(1)}%
                                                                            </title>
                                                                        </circle>
                                                                    </g>
                                                                );
                                                            })}
                                                        </svg>

                                                        {/* X-axis labels */}
                                                        <div style={{
                                                            position: 'absolute',
                                                            bottom: '25px',
                                                            left: 0,
                                                            right: 0,
                                                            display: 'flex',
                                                            justifyContent: 'space-between',
                                                            fontSize: '0.8rem',
                                                            color: '#aaa'
                                                        }}>
                                                            {[0, Math.floor(maxStep * 0.25), Math.floor(maxStep * 0.5), Math.floor(maxStep * 0.75), maxStep].map((step, i) => (
                                                                <div key={i}>{step}</div>
                                                            ))}
                                                        </div>

                                                        {/* X-axis label */}
                                                        <div style={{
                                                            position: 'absolute',
                                                            bottom: '5px',
                                                            left: 0,
                                                            right: 0,
                                                            textAlign: 'center',
                                                            fontSize: '0.9rem',
                                                            color: '#00bfff',
                                                            fontWeight: 'bold'
                                                        }}>
                                                            Training Games Completed
                                                        </div>
                                                    </div>

                                                    {/* Legend */}
                                                    <div style={{
                                                        position: 'absolute',
                                                        top: '10px',
                                                        right: '30px',
                                                        background: 'rgba(0,0,0,0.7)',
                                                        padding: '12px',
                                                        borderRadius: '8px',
                                                        fontSize: '0.85rem',
                                                        border: '1px solid rgba(0,191,255,0.3)'
                                                    }}>
                                                        <div style={{ marginBottom: '8px', fontWeight: 'bold', color: '#00bfff' }}>
                                                            Training Results
                                                        </div>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '5px' }}>
                                                            <div style={{ width: '20px', height: '3px', background: '#4CAF50' }} />
                                                            <span>ML Bot Win Rate</span>
                                                        </div>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                            <div style={{ width: '20px', height: '3px', background: '#F44336' }} />
                                                            <span>Baseline Bot Win Rate</span>
                                                        </div>
                                                        {history.length > 0 && (
                                                            <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.2)' }}>
                                                                <div style={{ fontSize: '0.75rem', color: '#aaa' }}>
                                                                    Total Games: {history[history.length - 1].step}
                                                                </div>
                                                                <div style={{ fontSize: '0.75rem', color: '#4CAF50' }}>
                                                                    ML: {(history[history.length - 1].mlWinRate * 100).toFixed(1)}%
                                                                </div>
                                                                <div style={{ fontSize: '0.75rem', color: '#F44336' }}>
                                                                    Baseline: {(history[history.length - 1].baselineWinRate * 100).toFixed(1)}%
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })()}
                                    </div>
                                </>
                            )}

                            <h3 style={{ color: '#00bfff', borderBottom: '1px solid #00bfff', paddingBottom: '10px', marginBottom: '20px' }}>
                                🃏 Card Performance
                            </h3>

                            <div className="card-stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '15px' }}>
                                {Object.entries(aiStatsData.cardUsage)
                                    .sort(([, a], [, b]) => (b.wins / (b.wins + b.losses || 1)) - (a.wins / (a.wins + a.losses || 1)))
                                    .map(([cardId, stats]) => {
                                        const total = stats.wins + stats.losses;
                                        if (total === 0) return null;
                                        const winRate = (stats.wins / total) * 100;

                                        return (
                                            <div key={cardId} style={{
                                                background: 'rgba(255,255,255,0.05)',
                                                padding: '15px',
                                                borderRadius: '8px',
                                                borderLeft: `4px solid ${winRate >= 50 ? '#4CAF50' : '#F44336'}`
                                            }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                                                    <span style={{ fontWeight: 'bold', textTransform: 'capitalize' }}>{cardId.replace('_', ' ')}</span>
                                                    <span style={{ color: winRate >= 50 ? '#4CAF50' : '#F44336', fontWeight: 'bold' }}>{winRate.toFixed(1)}%</span>
                                                </div>
                                                <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                                                    <div style={{ width: `${winRate}%`, height: '100%', background: winRate >= 50 ? '#4CAF50' : '#F44336' }}></div>
                                                </div>
                                                <div style={{ fontSize: '0.8rem', color: '#aaa', marginTop: '5px' }}>
                                                    {stats.played} plays | {stats.wins} wins
                                                </div>
                                            </div>
                                        );
                                    })}
                            </div>

                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    const handlePlayAgain = () => {
        // Simple reset: reload the page to clear game state
        window.location.reload();
    };

    if (!gameState) return <div className="loading">Loading...</div>;

    const isSpectator = !myPlayer || !gameState.players[myPlayer.id];

    return (
        <div className="game-container">
            {/* Connection Status Indicator */}
            <div
                className={`connection-status ${connectionStatus}`}
                aria-live="polite"
                aria-atomic="true"
            >
                <span className="connection-dot" aria-hidden="true" />
                {connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'reconnecting' ? 'Reconnecting...' : 'Disconnected'}
            </div>

            {/* Toast Notifications */}
            <div className="toast-stack" aria-live="polite" aria-relevant="additions removals">
                {toasts.map(toast => (
                    <div
                        key={toast.id}
                        className={`toast ${toast.type || 'info'}`}
                        onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
                    >
                        {toast.message}
                    </div>
                ))}
            </div>

            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <canvas
                    ref={canvasRef}
                    style={{ width: '100%', height: '100%', cursor: placementMode ? 'crosshair' : (draggingTroop ? 'grabbing' : 'default') }}
                    onClick={handleCanvasClick}
                    onMouseDown={handleCanvasMouseDown}
                    onMouseMove={handleCanvasMouseMove}
                    onMouseUp={handleCanvasMouseUp}
                />
                {gameState.useMLAI && (
                    <div
                        style={{
                            position: 'absolute',
                            top: '10px',
                            right: '10px',
                            background: 'rgba(0, 0, 0, 0.7)',
                            borderRadius: '8px',
                            padding: '4px 10px',
                            fontSize: '0.75rem',
                            color: '#00e5ff',
                            pointerEvents: 'none'
                        }}
                    >
                        TensorFlow ML AI
                        <span style={{ color: '#aaa', marginLeft: '6px' }}>
                            {gameState.mlModelLastUpdated
                                ? new Date(gameState.mlModelLastUpdated).toLocaleTimeString()
                                : 'training...'}
                        </span>
                    </div>
                )}
                {isSpectator && (
                    <div
                        style={{
                            position: 'absolute',
                            top: '10px',
                            left: '10px',
                            background: 'rgba(0, 0, 0, 0.7)',
                            borderRadius: '8px',
                            padding: '6px 12px',
                            fontSize: '0.75rem',
                            color: '#fff',
                            pointerEvents: 'none'
                        }}
                    >
                        <div>
                            Turn #{gameState.turnNumber || 1}
                        </div>
                        <div style={{ color: '#ccc' }}>
                            Players alive:{' '}
                            {Object.values(gameState.players).filter(p => !p.eliminated).length}
                            {' / '}
                            {Object.keys(gameState.players).length}
                        </div>
                        {gameState.useMLAI && (
                            <div style={{ color: '#00e5ff' }}>
                                ML Self-Play: {gameState.isTraining ? 'Training' : 'Match'}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Target Selection Modal for Offensive Units */}
            {targetSelectionMode && pendingOffensiveCard && (
                <div className="target-selection-modal">
                    <div className="modal-content">
                        <h3>Select Target Tower</h3>
                        <p className="modal-subtitle">Choose which enemy base to attack with {pendingOffensiveCard.name}</p>
                        <div className="target-options">
                            {Object.values(gameState.players).map(p => {
                                if (myPlayer && (p.id === myPlayer.id || p.eliminated)) return null;
                                return (
                                    <button
                                        key={p.id}
                                        className="target-button"
                                        style={{
                                            borderColor: p.color,
                                            background: `linear-gradient(135deg, ${p.color}40, ${p.color}20)`
                                        }}
                                        onClick={() => handleTargetSelection(p.id)}
                                    >
                                        <div className="target-color" style={{ background: p.color }}></div>
                                        <div className="target-info">
                                            <div className="target-name">{p.username || `Player ${p.id.substr(0, 4)}`}</div>
                                            <div className="target-hp">HP: {Math.ceil(p.baseHp)} / 1000</div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                        <button
                            className="cancel-target-btn"
                            onClick={() => {
                                setTargetSelectionMode(false);
                                setPendingOffensiveCard(null);
                                setSelectedCard(pendingOffensiveCard);
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* Move Notification */}
            {moveNotification && (
                <div className={`move-notification ${moveNotification.type}`}>
                    <div className="notification-icon">
                        {moveNotification.type === 'warning' ? '⚠️' : '✓'}
                    </div>
                    <div className="notification-message">{moveNotification.message}</div>
                </div>
            )}

            {/* Troop Stats Tooltip */}
            {hoveredTroop && !targetSelectionMode && (
                <div className="troop-tooltip" style={{
                    left: '20px',
                    top: '50%',
                    transform: 'translateY(-50%)'
                }}>
                    <div className="tooltip-header" style={{ color: hoveredTroop.color }}>
                        {hoveredTroop.name}
                    </div>
                    <div className="tooltip-stat">
                        <span className="stat-label">HP:</span>
                        <span className="stat-value">{Math.ceil(hoveredTroop.hp)} / {hoveredTroop.maxHp}</span>
                    </div>
                    <div className="tooltip-stat">
                        <span className="stat-label">Damage:</span>
                        <span className="stat-value">{hoveredTroop.damage}</span>
                    </div>
                    <div className="tooltip-stat">
                        <span className="stat-label">Speed:</span>
                        <span className="stat-value">{hoveredTroop.speed}</span>
                    </div>
                    <div className="tooltip-stat">
                        <span className="stat-label">Range:</span>
                        <span className="stat-value">{hoveredTroop.range}</span>
                    </div>
                    <div className="tooltip-type">
                        Type: {hoveredTroop.type}
                    </div>
                </div>
            )}

            {gameState.status === 'waiting' && (
                <div className="waiting-overlay">
                    <h2>Room {gameId}</h2>
                    {gameState.roomLeader === socket.id && (
                        <div className="room-leader-badge">👑 You are the Room Leader</div>
                    )}
                    <div className="player-count">
                        {Object.keys(gameState.players).length} / 4 Players
                    </div>
                    <div className="player-list">
                        {Object.values(gameState.players).map(p => {
                            const winProb = gameState.aiWinProbabilities && gameState.aiWinProbabilities[p.id];
                            const mlThought = gameState.mlAIInsights && gameState.mlAIInsights[p.id];
                            return (
                                <div key={p.id} className="player-item" style={{ color: p.color }}>
                                    <div className="player-name">
                                        {p.username || `Player ${p.id.substr(0, 4)}`}
                                        {myPlayer && p.id === myPlayer.id && ' (YOU)'}
                                        {p.id === gameState.roomLeader && ' 👑'}
                                        {p.isAI && (
                                            <>
                                                {' 🤖 '}
                                                <span style={{ color: '#aaa', fontSize: '0.85rem' }}>
                                                    ({(p.aiSkill || gameState.aiDifficulty || (gameState.useMLAI ? 'hardest' : 'normal'))})
                                                </span>
                                            </>
                                        )}
                                    </div>
                                    {winProb && (
                                        <div className="ai-win-prob" style={{
                                            color: parseFloat(winProb.percentage) >= 50 ? '#4CAF50' : parseFloat(winProb.percentage) >= 30 ? '#FFC107' : '#F44336'
                                        }}>
                                            Win: {winProb.percentage}%
                                        </div>
                                    )}
                                    {p.isAI && gameState.useMLAI && mlThought && (
                                        <div className="ai-ml-thought" style={{ fontSize: '0.8rem', color: '#00e5ff', marginTop: '2px' }}>
                                            ML next: {mlThought.cardName || mlThought.cardId}
                                            {typeof mlThought.score === 'number' && (
                                                <span style={{ color: '#aaa' }}>
                                                    {' '}(score {(mlThought.score * 100).toFixed(1)}%)
                                                </span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {gameState.roomLeader === socket.id && (
                        <div className="room-settings">
                            <h3>Game Settings</h3>

                            <div className="setting-group">
                                <label>Movement Mode</label>
                                <div className="setting-buttons">
                                    <button
                                        className={`setting-btn ${gameState.movementMode === 'automatic' ? 'active' : ''}`}
                                        onClick={() => socket.emit('updateRoomSettings', {
                                            gameId,
                                            settings: { movementMode: 'automatic' }
                                        })}
                                    >
                                        ⚙️ Automatic
                                    </button>
                                    <button
                                        className={`setting-btn ${gameState.movementMode === 'manual' ? 'active' : ''}`}
                                        onClick={() => socket.emit('updateRoomSettings', {
                                            gameId,
                                            settings: { movementMode: 'manual' }
                                        })}
                                    >
                                        🎮 Manual
                                    </button>
                                </div>
                            </div>

                            <div className="setting-group">
                                <label>
                                    AI Players: {gameState.aiPlayerCount || 0}
                                </label>
                                <div className="setting-buttons">
                                    {[0, 1, 2, 3].map(num => (
                                        <button
                                            key={num}
                                            className={`setting-btn small ${gameState.aiPlayerCount === num ? 'active' : ''}`}
                                            onClick={() => socket.emit('updateRoomSettings', {
                                                gameId,
                                                settings: { aiPlayerCount: num }
                                            })}
                                            disabled={
                                                Object.keys(gameState.players).length + num > 4
                                            }
                                        >
                                            {num}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="setting-group">
                                <label>AI Skill (default)</label>
                                <select
                                    value={gameState.aiDifficulty || (gameState.useMLAI ? 'hardest' : 'normal')}
                                    onChange={(e) => socket.emit('updateRoomSettings', {
                                        gameId,
                                        settings: { aiDifficulty: e.target.value }
                                    })}
                                    style={{
                                        width: '100%',
                                        padding: '10px 12px',
                                        background: 'rgba(0,0,0,0.3)',
                                        border: '1px solid rgba(255,255,255,0.25)',
                                        borderRadius: '10px',
                                        color: '#fff',
                                        fontSize: '1rem'
                                    }}
                                >
                                    <option value="easy">Easy (makes mistakes)</option>
                                    <option value="normal">Normal</option>
                                    <option value="hard">Hard (stats-driven)</option>
                                    <option value="hardest">Hardest (TensorFlow + stats)</option>
                                </select>
                                <div style={{ fontSize: '0.8rem', color: '#aaa', marginTop: '6px' }}>
                                    All bots have the same cards dealt and elixir. Skill only changes decision-making quality.
                                </div>
                            </div>

                            {(gameState.aiPlayerCount || 0) > 0 && (
                                <div className="setting-group">
                                    <label>Per-bot Skill (optional)</label>
                                    <div style={{ display: 'grid', gap: '10px' }}>
                                        {Array.from({ length: gameState.aiPlayerCount || 0 }).map((_, i) => {
                                            const current = (gameState.aiPlayerSkills && gameState.aiPlayerSkills[i])
                                                || gameState.aiDifficulty
                                                || (gameState.useMLAI ? 'hardest' : 'normal');
                                            return (
                                                <div key={i} style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '10px', alignItems: 'center' }}>
                                                    <div style={{ color: '#ccc', fontSize: '0.9rem' }}>Bot {i + 1}</div>
                                                    <select
                                                        value={current}
                                                        onChange={(e) => {
                                                            const next = Array.isArray(gameState.aiPlayerSkills) ? [...gameState.aiPlayerSkills] : [];
                                                            next[i] = e.target.value;
                                                            socket.emit('updateRoomSettings', { gameId, settings: { aiPlayerSkills: next } });
                                                        }}
                                                        style={{
                                                            width: '100%',
                                                            padding: '8px 10px',
                                                            background: 'rgba(0,0,0,0.3)',
                                                            border: '1px solid rgba(255,255,255,0.25)',
                                                            borderRadius: '10px',
                                                            color: '#fff',
                                                            fontSize: '0.95rem'
                                                        }}
                                                    >
                                                        <option value="easy">Easy</option>
                                                        <option value="normal">Normal</option>
                                                        <option value="hard">Hard</option>
                                                        <option value="hardest">Hardest</option>
                                                    </select>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {gameState.useMLAI && (
                                <div className="setting-group">
                                    <div style={{ fontSize: '0.9rem', color: '#00e5ff' }}>
                                        TensorFlow Model: <strong>Enabled</strong>
                                    </div>
                                    <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
                                        Last Update:{' '}
                                        {gameState.mlModelLastUpdated
                                            ? new Date(gameState.mlModelLastUpdated).toLocaleString()
                                            : 'Pending training'}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {gameState.roomLeader !== socket.id && (
                        <div className="room-settings-display">
                            <h3>Game Settings</h3>
                            <div className="setting-info">
                                <span className="setting-label">Mode:</span>
                                <span className="setting-value">🔄 Turn-Based</span>
                            </div>
                            <div className="setting-info">
                                <span className="setting-label">Movement:</span>
                                <span className="setting-value">{gameState.movementMode === 'automatic' ? '⚙️ Automatic' : '🎮 Manual'}</span>
                            </div>
                            <div className="setting-info">
                                <span className="setting-label">AI Players:</span>
                                <span className="setting-value">{gameState.aiPlayerCount || 0}</span>
                            </div>
                            <div className="setting-info">
                                <span className="setting-label">AI Skill:</span>
                                <span className="setting-value">
                                    {(() => {
                                        const n = gameState.aiPlayerCount || 0;
                                        if (n <= 0) return (gameState.aiDifficulty || 'normal');
                                        const skills = Array.from({ length: n }).map((_, i) =>
                                            (gameState.aiPlayerSkills && gameState.aiPlayerSkills[i]) || gameState.aiDifficulty || (gameState.useMLAI ? 'hardest' : 'normal')
                                        );
                                        const unique = Array.from(new Set(skills));
                                        return unique.length > 1 ? 'mixed' : unique[0];
                                    })()}
                                </span>
                            </div>
                            {gameState.useMLAI && (
                                <div className="setting-info">
                                    <span className="setting-label">Model Updated:</span>
                                    <span className="setting-value">
                                        {gameState.mlModelLastUpdated
                                            ? new Date(gameState.mlModelLastUpdated).toLocaleString()
                                            : 'Pending training'}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}

                    {gameState.roomLeader === socket.id && (
                        <button
                            className="start-btn"
                            onClick={handleStart}
                            disabled={Object.keys(gameState.players).length < 1}
                        >
                            {Object.keys(gameState.players).length + (gameState.aiPlayerCount || 0) >= 2
                                ? 'Start Game Now'
                                : 'Add AI players or wait for more players...'}
                        </button>
                    )}

                    {gameState.roomLeader !== socket.id && (
                        <div className="waiting-message">Waiting for room leader to start...</div>
                    )}
                </div>
            )}

            {gameState.status === 'playing' && !isSpectator && (
                <div className="ui-layer">
                    <div className="top-banner" style={{ borderColor: myPlayer.color }}>
                        <div className="banner-content">
                            <span className="banner-label">YOU ARE</span>
                            <span className="banner-player" style={{ color: myPlayer.color }}>
                                {myPlayer.username || `Player ${myPlayer.id.substr(0, 4)}`}
                            </span>
                        </div>
                        <div className="turn-info">
                            <div className="turn-label">
                                Turn #{gameState.turnNumber || 1}
                                {gameState.movementMode === 'manual' && (
                                    <span className="mode-badge manual">MANUAL MODE</span>
                                )}
                                {gameState.gamePhase && gameState.gamePhase.phase > 1 && (
                                    <span
                                        className="mode-badge phase-indicator"
                                        style={{
                                            backgroundColor: gameState.gamePhase.color,
                                            marginLeft: '8px'
                                        }}
                                        title={gameState.gamePhase.description}
                                    >
                                        {gameState.gamePhase.name}
                                    </span>
                                )}
                            </div>
                            {gameState.currentTurn === socket.id ? (
                                <div className="your-turn">
                                    <span className="turn-indicator">YOUR TURN</span>
                                    <div className="turn-timer" style={{
                                        width: `${(gameState.turnTimeRemaining / 30) * 100}%`,
                                        backgroundColor: gameState.turnTimeRemaining < 10 ? '#ff4444' : '#44ff44'
                                    }}></div>
                                    <span className="timer-text">{Math.ceil(gameState.turnTimeRemaining || 0)}s</span>
                                </div>
                            ) : (
                                <div className="waiting-turn">
                                    <span className="turn-indicator">WAITING...</span>
                                    <span className="current-player">
                                        {gameState.players[gameState.currentTurn]?.username || `Player ${gameState.currentTurn?.substr(0, 4)}`}'s Turn
                                    </span>
                                    <div className="turn-timer" style={{
                                        width: `${(gameState.turnTimeRemaining / 30) * 100}%`,
                                        backgroundColor: '#ffaa00',
                                        marginTop: '5px'
                                    }}></div>
                                    <span className="timer-text" style={{ fontSize: '1rem' }}>{Math.ceil(gameState.turnTimeRemaining || 0)}s</span>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="elixir-bar">
                        <div className="elixir-fill" style={{ width: `${(myPlayer.elixir / 15) * 100}%` }}></div>
                        <span>{Math.floor(myPlayer.elixir)}</span>
                    </div>

                    <div className="hand">
                        {myPlayer.hand.map((card, idx) => {
                            const iconSrc = CARD_ICONS[card.id];
                            const isDisabled = myPlayer.elixir < card.cost ||
                                (gameState.currentTurn !== socket.id);
                            const isSelected = selectedCard?.id === card.id;

                            return (
                                <div
                                    key={idx}
                                    className={`card ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
                                    style={{
                                        background: `linear-gradient(135deg, ${myPlayer.color}20, ${myPlayer.color}40)`,
                                        borderColor: myPlayer.color
                                    }}
                                    onMouseEnter={(e) => {
                                        if (!isDisabled) {
                                            setHoveredCard(card);
                                            const rect = e.currentTarget.getBoundingClientRect();
                                            const tooltipWidth = 240;
                                            const spacing = 10;
                                            let x = rect.left - tooltipWidth - spacing;
                                            let y = rect.top;

                                            // If tooltip would go off left edge, position to the right
                                            if (x < 10) {
                                                x = rect.right + spacing;
                                            }

                                            // If tooltip would go off bottom, adjust upward
                                            if (y + 300 > window.innerHeight) {
                                                y = window.innerHeight - 300;
                                            }

                                            setHoveredCardPosition({ x, y });
                                        }
                                    }}
                                    onMouseLeave={() => {
                                        setHoveredCard(null);
                                    }}
                                    onClick={() => {
                                        if (!isDisabled) {
                                            setSelectedCard(card);
                                            if (card.type === 'defense') {
                                                setPlacementMode(true);
                                            } else {
                                                setPlacementMode(false);
                                            }
                                        }
                                    }}
                                >
                                    <div className="card-cost" style={{ background: myPlayer.color }}>{card.cost}</div>
                                    {iconSrc && (
                                        <div className="card-icon">
                                            <img src={iconSrc} alt={card.name} />
                                        </div>
                                    )}
                                    <div className="card-name">{card.name}</div>
                                    <div className="card-type">{card.type}</div>
                                </div>
                            );
                        })}
                        <div
                            className="card next-card"
                            onMouseEnter={(e) => {
                                if (myPlayer.nextCard) {
                                    setHoveredCard(myPlayer.nextCard);
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const tooltipWidth = 240;
                                    const spacing = 10;
                                    let x = rect.left - tooltipWidth - spacing;
                                    let y = rect.top;

                                    // If tooltip would go off left edge, position to the right
                                    if (x < 10) {
                                        x = rect.right + spacing;
                                    }

                                    // If tooltip would go off bottom, adjust upward
                                    if (y + 300 > window.innerHeight) {
                                        y = window.innerHeight - 300;
                                    }

                                    setHoveredCardPosition({ x, y });
                                }
                            }}
                            onMouseLeave={() => {
                                setHoveredCard(null);
                            }}
                        >
                            <div className="card-label">Next:</div>
                            {myPlayer.nextCard && (
                                <>
                                    <div className="card-icon">
                                        {CARD_ICONS[myPlayer.nextCard.id] && (
                                            <img src={CARD_ICONS[myPlayer.nextCard.id]} alt={myPlayer.nextCard.name} />
                                        )}
                                    </div>
                                    <div className="card-name">{myPlayer.nextCard.name}</div>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Card Info Tooltip */}
                    {hoveredCard && (
                        <div
                            className="card-info-tooltip"
                            style={{
                                position: 'fixed',
                                left: `${hoveredCardPosition.x}px`,
                                top: `${hoveredCardPosition.y}px`,
                                zIndex: 1000,
                                pointerEvents: 'none'
                            }}
                        >
                            <div className="card-info-header">
                                <h3>{hoveredCard.name}</h3>
                                <span className={`card-info-type ${hoveredCard.type}`}>{hoveredCard.type}</span>
                            </div>
                            <div className="card-info-stats">
                                <div className="stat-row">
                                    <span className="stat-label">Cost:</span>
                                    <span className="stat-value">{hoveredCard.cost} ⚡</span>
                                </div>
                                <div className="stat-row">
                                    <span className="stat-label">Health:</span>
                                    <span className="stat-value">{hoveredCard.hp} ❤️</span>
                                </div>
                                <div className="stat-row">
                                    <span className="stat-label">Damage:</span>
                                    <span className="stat-value">{hoveredCard.damage} ⚔️</span>
                                </div>
                                <div className="stat-row">
                                    <span className="stat-label">Speed:</span>
                                    <span className="stat-value">{hoveredCard.speed} 🏃</span>
                                </div>
                                <div className="stat-row">
                                    <span className="stat-label">Range:</span>
                                    <span className="stat-value">{hoveredCard.range} 📏</span>
                                </div>
                                {hoveredCard.isWall && (
                                    <div className="stat-row special">
                                        <span className="stat-label">Special:</span>
                                        <span className="stat-value">Wall (Immobile)</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {gameState.currentTurn === socket.id && (
                        <button className="end-turn-btn" onClick={handleEndTurn}>
                            END TURN
                        </button>
                    )}
                </div>
            )}

            {gameState.status === 'ended' && endState && (
                <div className="end-overlay">
                    <div className="end-panel">
                        <h2 className={`end-title ${endState.outcome === 'win' ? 'victory' : 'defeat'}`}>
                            {endState.outcome === 'win' ? 'VICTORY' : 'DEFEAT'}
                        </h2>
                        {endState.winnerId && (
                            <p className="end-subtitle">
                                Winner:{' '}
                                <span>
                                    {endState.winnerName ||
                                        gameState.players?.[endState.winnerId]?.username ||
                                        `Player ${endState.winnerId.substr(0, 4)}`}
                                </span>
                            </p>
                        )}
                        {!endState.winnerId && (
                            <p className="end-subtitle">
                                You have been eliminated.
                            </p>
                        )}
                        <button className="end-button" onClick={handlePlayAgain}>
                            Play Again
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Game;
