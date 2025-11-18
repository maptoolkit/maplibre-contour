# Contour Line Simplification Guide

## Overview

The contour line simplification feature uses the [turf.js simplify](https://turfjs.org/docs/api/simplify) function to reduce the complexity of generated contour lines using the Douglas-Peucker algorithm. This can significantly improve rendering performance and reduce vector tile sizes while maintaining visual quality.

## Integration Point

Simplification is applied **after isoline generation but before terrain splitting**, ensuring:
- Simplified lines are used for terrain classification
- Performance benefits apply to the entire pipeline
- Terrain splitting works on optimized geometry

## Usage

### Basic Usage

Add the `simplify` parameter to your contour source options:

```javascript
const demSource = new DemSource({
  url: 'https://example.com/tiles/{z}/{x}/{y}.png',
  encoding: 'terrarium',
  maxzoom: 12,
  worker: true
});

// In your contour layer source
map.addSource('contours', {
  type: 'vector',
  tiles: [
    demSource.contourProtocolUrl({
      thresholds: {
        10: [50, 100],
        11: [25, 100],
        12: [10, 50]
      },
      simplify: 1  // Default tolerance value
    })
  ]
});
```

### Parameters

- **`simplify`** (number, default: `1`)
  - Tolerance for Douglas-Peucker simplification
  - Set to `0` to disable simplification
  - Higher values = more aggressive simplification
  - Value is normalized to tile coordinate space (0-1 range internally)

### Recommended Values by Zoom Level

```javascript
// Conservative (minimal simplification)
thresholds: {
  10: [100, 200],
  12: [25, 100],
  14: [10, 50]
},
simplify: 0.5

// Balanced (default)
thresholds: {
  10: [100, 200],
  12: [25, 100],
  14: [10, 50]
},
simplify: 1

// Aggressive (maximum performance)
thresholds: {
  10: [100, 200],
  12: [25, 100],
  14: [10, 50]
},
simplify: 2
```

### Disabling Simplification

To skip simplification entirely:

```javascript
demSource.contourProtocolUrl({
  thresholds: { /* ... */ },
  simplify: 0  // Disable simplification
})
```

## Performance Impact

The simplification step includes performance logging that outputs to the console:

```
[Contour Simplify] z12 tolerance=1: 45.23ms
```

This helps you:
- Monitor simplification overhead
- Tune the tolerance parameter
- Compare performance with/without simplification

## Technical Details

### Algorithm

- Uses turf.simplify with Douglas-Peucker algorithm
- `highQuality: false` for faster processing (Radial Distance pre-filtering)
- Coordinates normalized to 0-1 range during simplification
- Results rounded back to integer tile coordinates

### Quality Assurance

- Invalid lines (< 2 points) are skipped
- Lines with < 2 points after simplification are discarded
- Simplification errors fall back to original geometry
- All errors are logged to console for debugging

### Caching

Simplified contours are cached along with other tile options, so:
- Each unique `simplify` value generates a separate cache entry
- Changing `simplify` requires rebuilding affected tiles
- Cache key includes all options: `z/x/y/encodeIndividualOptions(options)`

## Integration with Terrain Splitting

The simplification happens **before** terrain-based splitting:

1. Generate isolines from DEM
2. **Simplify contour lines** ← New step
3. Split by terrain polygons (glacier/rock/normal)
4. Encode to vector tile

This ensures terrain classification works on optimized geometry and splitting doesn't re-introduce complexity.

## Building the Library

After modifying the simplification implementation, rebuild the minified library:

```bash
npm run build
```

This generates:
- `dist/index.mjs` - ES module
- `dist/index.cjs` - CommonJS module
- `dist/index.min.js` - Minified browser bundle
- `dist/index.d.ts` - TypeScript definitions

## Examples

### Zoom-dependent Simplification

You can't vary `simplify` by zoom in the URL (it's per-source), but you can create multiple sources:

```javascript
// Low zoom - more simplification
map.addSource('contours-low', {
  type: 'vector',
  tiles: [demSource.contourProtocolUrl({
    thresholds: { 8: [200, 400], 9: [100, 200] },
    simplify: 2
  })],
  maxzoom: 10
});

// High zoom - less simplification
map.addSource('contours-high', {
  type: 'vector',
  tiles: [demSource.contourProtocolUrl({
    thresholds: { 10: [50, 100], 12: [10, 50] },
    simplify: 0.5
  })],
  minzoom: 10
});
```

### Testing Different Values

Use browser console to compare:

```javascript
// Test with different tolerance values
[0, 0.5, 1, 2, 5].forEach(tolerance => {
  console.log(`Testing simplify=${tolerance}`);
  // Update your source with new tolerance and observe results
});
```

## Troubleshooting

### Lines disappearing
- Tolerance too high - try reducing `simplify` value
- Check console for warnings about failed simplifications

### No performance improvement
- Tolerance too low - try increasing `simplify` value
- Check console logs for actual processing time
- Verify simplification is enabled (`simplify > 0`)

### Unexpected geometry
- Review simplified vs original in map
- Check for "Failed to simplify contour line" warnings in console
- Try different tolerance values

## Future Enhancements

Potential improvements:
- Zoom-dependent tolerance in URL parameters
- Adaptive tolerance based on line complexity
- Alternative simplification algorithms
- Per-elevation-level tolerance control
