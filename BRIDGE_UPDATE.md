# Angled Bridge Update

## Overview
Bridges have been redesigned to be smaller, angled, and positioned to cross the X-shaped trench diagonally.

## Changes Made

### 1. Reduced Bridge Count
- **Before**: 8 bridges (4 per diagonal)
- **After**: 2 bridges (1 per diagonal line)
- Bridges now cross at the center of the map (10, 10)

### 2. Bridge Design
The bridge SVG has been completely redesigned:

**Dimensions**:
- **Size**: 200x50px (4:1 aspect ratio)
- **In-game**: 4 cells long × 1 cell wide
- Much narrower and longer to fit diagonal crossings

**Visual Features**:
- Horizontal wooden planks (3 planks wide)
- Cross beams for structural support
- Rounded ends for natural appearance
- Wood grain texture pattern
- Shadow filter for depth
- Rope/nail details at corners

### 3. Rotation System
Bridges are now rotated to align with diagonal trenches:

```javascript
ctx.rotate((bridge.angle || 0) * Math.PI / 180);
```

**Bridge Angles**:
- Bridge 1: 45° (top-left to bottom-right diagonal: \)
- Bridge 2: -45° (top-right to bottom-left diagonal: /)

### 4. Wider Trenches
Trenches are now 3 cells wide instead of 2:
- Main diagonal cell
- One cell on each side
- Creates a more imposing obstacle
- Makes bridges more critical

### 5. Bridge Positioning

Bridges are positioned in separate quadrants:

| Bridge | Position | Angle | Diagonal | Quadrant | Cleared Cells |
|--------|----------|-------|----------|----------|---------------|
| 1 | (7, 7) | 45° | Top-left → Bottom-right | NW | (6,6), (7,7), (8,8) |
| 2 | (13, 7) | -45° | Top-right → Bottom-left | NE | (12,8), (13,7), (14,6) |

### 6. Cleared Pathways
For each bridge, 3 cells are cleared in the trench:
- The bridge center cell
- One cell before
- One cell after
- Plus adjacent cells for passage width

## Visual Layout

```
             P1 (North)
               |
        \      |      /
    B1   \     |     /   B2
      ====\====|====/====
           \   |   /
            \  |  /
             \ | /
     P4 ------\|/------ P2
     (West)   /|\   (East)
             / | \
            /  |  \
           /   |   \
      ====/====|====\====
         /     |     \
        /      |      \
               |
             P3 (South)

Legend:
  # = Trench (impassable)
  B1 = Bridge 1 at (7,7) - NW quadrant
  B2 = Bridge 2 at (13,7) - NE quadrant
  ==== = Bridge crossing points
```

## Technical Implementation

### Server Side (`server/index.js`)

**Trench Generation**:
```javascript
// Wider 3-cell trench
for (let i = 0; i < GRID_SIZE; i++) {
    trench.add(`${i},${i}`);
    if (i > 0) trench.add(`${i-1},${i}`);
    if (i < GRID_SIZE - 1) trench.add(`${i+1},${i}`);
}
```

**Bridge Data**:
```javascript
const bridges = [
    { x: 10, y: 10, angle: 45, type: 'diagonal1' },
    { x: 10, y: 10, angle: -45, type: 'diagonal2' }
];
```

### Client Side (`Game.jsx`)

**Rotated Rendering**:
```javascript
ctx.save();
ctx.translate(centerX, centerY);
ctx.rotate((bridge.angle || 0) * Math.PI / 180);
ctx.drawImage(bridgeImageRef.current, -length/2, -width/2, length, width);
ctx.restore();
```

## Strategic Impact

### Before (8 Bridges)
- Multiple crossing points
- Easy to bypass trenches
- Less strategic importance

### After (2 Bridges)
- Single crossing point at center
- Highly contested central location
- Bridges are critical chokepoints
- Forces player interaction at center
- More strategic depth

## Benefits

1. **Visual Clarity**: Bridges clearly cross the trenches
2. **Strategic Depth**: Single crossing point creates tension
3. **Realistic Design**: Narrow bridges fit diagonal gaps
4. **Better Gameplay**: Forces players to contest the center
5. **Cleaner Look**: Less visual clutter

## Map Quadrants

With only 2 bridges crossing at center, the map is divided into 4 quadrants:

```
Quadrant 1 (NW)    |    Quadrant 2 (NE)
    P1 (2,2)       |       P2 (17,2)
-------------------X-------------------
Quadrant 3 (SW)    |    Quadrant 4 (SE)
    P3 (2,17)      |       P4 (17,17)
```

- Players start in their quadrant corners
- Must cross the center bridges to reach other quadrants
- Creates natural territorial boundaries
- Encourages defensive and offensive strategies

## Future Enhancements

Potential additions:
- Bridge durability/destructibility
- Bridge control mechanics (capture the bridge)
- Alternative crossing methods (flying units, tunneling)
- Bridge repair mechanics
- Multiple layers of bridges
- Drawbridge mechanics (open/close)

