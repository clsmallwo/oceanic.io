# Turn-Based Grid System Update

## Overview
Oceanic.io has been transformed from a real-time strategy game into a turn-based tactical grid game with strategic obstacles.

## Major Changes

### 1. Grid System (20x20)
- **Grid Size**: 20x20 cells
- **Cell Size**: 50 pixels per cell
- **Map Size**: 1000x1000 pixels total
- All units and bases are now grid-aligned

### 2. X-Shaped Trench Obstacle
- **Trench**: Impassable dark trenches forming an X pattern across the map
- **Bridges**: 8 strategic bridge points where units can cross the trenches
  - 4 bridges on each diagonal arm of the X
  - Located at positions: (5,5), (8,8), (11,11), (14,14), (5,14), (8,11), (11,8), (14,5)
- **Pathfinding**: Units automatically avoid trenches and seek bridges

### 3. Turn-Based Gameplay
- **Turn Duration**: 30 seconds per turn
- **Turn Order**: Players take turns in sequence
- **Auto-Advance**: Turns automatically advance when time expires
- **Manual End**: Players can end their turn early with the "END TURN" button

### 4. Turn System Features
- **Turn Timer**: Visual countdown showing remaining time
  - Green bar when >10 seconds remain
  - Red bar when <10 seconds remain
- **Turn Indicator**: 
  - "YOUR TURN" with pulsing animation when it's your turn
  - "WAITING..." when it's another player's turn
- **Turn Number**: Displays current turn number
- **Card Restrictions**: Can only play cards during your turn

### 5. Game Balance Changes
- **Minimum Players**: Game can start with 2 players (was 4)
- **Elixir System**: 
  - Players gain +2 elixir at the start of their turn
  - No passive regeneration during other players' turns
- **Movement**: Grid-based movement with pathfinding around obstacles
- **Combat**: Grid-based range calculations

### 6. Visual Updates
- **Grid Overlay**: Visible grid lines on the battlefield
- **Trench Rendering**: Dark cells showing impassable terrain
- **Bridge Rendering**: Brown wooden bridges with plank patterns
- **Turn UI**: Enhanced top banner showing turn information
- **End Turn Button**: Large, prominent button to end your turn

## Server Changes (`server/index.js`)

### New Constants
```javascript
const GRID_SIZE = 20;
const CELL_SIZE = 50;
const TURN_DURATION = 30;
```

### New Functions
- `generateTrenchMap()`: Creates the X-shaped trench with bridges
- `nextTurn(gameId)`: Advances to the next player's turn
- `isPassable(x, y, trenchSet)`: Checks if a grid cell is passable
- `moveTowardsTarget(troop, target, dt, trenchSet)`: Grid-based pathfinding

### Game State Updates
- Added `terrain` (trench and bridge data)
- Added `currentTurn` (current player's socket ID)
- Added `turnOrder` (array of player IDs)
- Added `turnStartTime` and `turnTimeRemaining`
- Added `turnNumber`

### New Socket Events
- `endTurn`: Allows players to manually end their turn

## Client Changes (`client/src/components/Game.jsx`)

### New Features
- Grid rendering with visible cells
- Trench and bridge visualization
- Turn timer display
- Turn indicator (YOUR TURN / WAITING)
- End Turn button
- Card disabling when not your turn

### Visual Enhancements
- Grid-based battlefield layout
- X-shaped trench with dark styling
- Wooden bridge crossings
- Turn information in top banner
- Animated turn indicator

## How to Play

1. **Join a Game**: Enter a room ID and join
2. **Start Game**: At least 2 players needed (up to 4)
3. **Your Turn**: 
   - Deploy units by selecting cards and clicking
   - Units spawn at your base
   - You have 30 seconds per turn
   - Click "END TURN" when done
4. **Strategy**:
   - Use bridges to cross the X-shaped trench
   - Defensive units patrol around your base
   - Offensive units move to center, then attack enemy bases
   - Plan your moves carefully - you can't act on other players' turns!

## Testing

To test the new system:
```bash
./run.sh restart
```

Then open http://localhost:5173 (or your network IP) in multiple browser windows to test multiplayer.

## Future Enhancements

Potential additions:
- Click to move units to specific grid cells
- Unit abilities that activate on specific turns
- Terrain effects (water currents, whirlpools)
- More complex pathfinding algorithms
- Fog of war
- Turn replay system



