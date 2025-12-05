# Turn-Based Movement System

## Overview
The game now features turn-based discrete movement where troops move a set number of grid cells when each turn ends, with smooth animations showing the movement.

## Key Changes

### 1. Perpendicular Bridge Crossings

Bridges now cross **perpendicular** to the trenches (crossing over them) rather than along them:

```
Trench: \  Bridge: /  (perpendicular)
Trench: /  Bridge: \  (perpendicular)
```

**Bridge 1**: Position (7, 7), Angle -45° - crosses perpendicular to \ diagonal
**Bridge 2**: Position (13, 13), Angle 45° - crosses perpendicular to / diagonal

### 2. Turn-Based Movement

#### Server-Side Movement
- **Timing**: Troops move only when a turn ends (not continuously)
- **Distance**: Each troop moves `Math.floor(speed)` grid cells per turn
- **Pathfinding**: Simple grid-based pathfinding with trench avoidance

#### Movement Rules by Troop Type

**Defensive Units:**
- Stay near their owner's base
- Patrol around the base location
- Don't actively pursue enemies

**Offensive Units:**
- Move to center (10, 10) first
- Upon reaching center, pick a random enemy base as target
- Move towards target enemy base
- Switch targets if current target is eliminated

#### Movement per Turn by Speed

| Speed | Cells per Turn | Example Units |
|-------|----------------|---------------|
| 1 | 1 cell | Turtle (slow defensive) |
| 2 | 2 cells | Jellyfish, Crab |
| 3 | 3 cells | Shark, Barracuda, Trident |

### 3. Smooth Client Animation

#### Animation System
- **Duration**: 500ms per movement
- **Easing**: Cubic ease-out for smooth deceleration
- **Interpolation**: Linear interpolation between grid positions

#### Animation Process
```javascript
// When new position received from server
1. Store start position (current animated position)
2. Store target position (new server position)
3. Record start time
4. For next 500ms:
   - Calculate progress (0 to 1)
   - Apply easing function
   - Interpolate position
   - Render at interpolated position
```

#### Easing Function
```javascript
const eased = 1 - Math.pow(1 - progress, 3); // Cubic ease-out
```

This creates a smooth movement that starts fast and decelerates, making it feel natural.

### 4. Combat System

Combat happens continuously (not turn-based):
- Troops attack enemies in range every game loop update
- Damage is dealt over time while in range
- Combat doesn't interfere with turn-based movement

## Technical Implementation

### Server (`server/index.js`)

#### `moveTroopsOnTurnEnd(game)`
Called at the end of each turn to move all troops:

```javascript
function moveTroopsOnTurnEnd(game) {
    const trenchSet = new Set(game.terrain.trench.map(t => `${t.x},${t.y}`));
    
    game.troops.forEach(troop => {
        const movesPerTurn = Math.floor(troop.speed);
        
        for (let i = 0; i < movesPerTurn; i++) {
            // Determine target
            // Calculate direction
            // Check passability
            // Move one cell
        }
    });
}
```

#### Pathfinding Logic
```javascript
// Prefer larger delta direction
if (Math.abs(dx) > Math.abs(dy)) {
    moveX = dx > 0 ? 1 : -1;
} else {
    moveY = dy > 0 ? 1 : -1;
}

// Check trench
if (!isPassable(nextX, nextY, trenchSet)) {
    // Try alternate direction
}
```

### Client (`Game.jsx`)

#### Animation Data Structure
```javascript
troopAnimationsRef.current[troopId] = {
    startX: number,      // Animation start position
    startY: number,
    targetX: number,     // Target position from server
    targetY: number,
    currentX: number,    // Current interpolated position
    currentY: number,
    startTime: number,   // Animation start time (ms)
    duration: number     // Animation duration (ms)
};
```

#### Rendering Loop
```javascript
// Calculate animated position
if (now < startTime + duration) {
    const progress = (now - startTime) / duration;
    const eased = 1 - Math.pow(1 - progress, 3);
    displayX = startX + (targetX - startX) * eased;
    displayY = startY + (targetY - startY) * eased;
}

// Render at animated position
ctx.arc(displayX, displayY, radius, 0, Math.PI * 2);
```

## Visual Flow

### Turn Sequence

```
1. Player's Turn Starts
   ↓
2. Player Deploys Units
   ↓
3. Player Clicks "END TURN" (or timer expires)
   ↓
4. Server: moveTroopsOnTurnEnd() called
   ↓
5. All troops move N cells instantly (server-side)
   ↓
6. Server sends updated gameState to all clients
   ↓
7. Clients receive new positions
   ↓
8. Clients start 500ms animations
   ↓
9. Troops smoothly animate to new positions
   ↓
10. Next Player's Turn Starts
```

## Benefits

### 1. Strategic Clarity
- Players can see exactly how far units will move
- Easier to plan positioning and tactics
- Predictable unit behavior

### 2. Turn-Based Tactics
- Consider unit speed when deploying
- Fast units reach objectives quicker
- Slow defensive units stay near base

### 3. Visual Polish
- Smooth animations prevent jarring jumps
- Maintains visual continuity
- Professional game feel

### 4. Performance
- Movement calculated once per turn (not every frame)
- Reduced server load
- Efficient pathfinding

## Strategy Tips

### Unit Speed Matters
- **Fast units (speed 3)**: Deploy for quick attacks, reaching center in ~3 turns
- **Medium units (speed 2)**: Balanced movement, good for mid-range control
- **Slow units (speed 1)**: Best for defense, stay near your base

### Timing Your Deployments
- Deploy fast units early to reach bridges quickly
- Save slow defensive units for when enemies approach
- Consider how many turns until unit reaches destination

### Bridge Control
- Fast units can seize bridges before enemies
- Position units 1-2 cells from bridge before turn end
- Control bridges to restrict enemy movement

## Future Enhancements

Potential additions:
- **Unit abilities** that trigger on movement
- **Terrain effects** (speed boosts/penalties)
- **Movement preview** showing where unit will move
- **Waypoints** for custom pathing
- **Formation movement** for grouped units
- **Charge attacks** (bonus damage after movement)



