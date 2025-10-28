# Polygon Simplification Configuration

The `ContourSplitter` now supports three polygon simplification methods that can be configured at runtime:

## Methods

### 1. `convex-hull` (default)
- **Speed**: Fastest (75-80% vertex reduction)
- **Accuracy**: Lower (fills concave areas)
- **Best for**: Zoom 11-12, when speed is critical
- **How it works**: Replaces polygon with its convex hull

### 2. `douglas-peucker`
- **Speed**: Medium (aggressive simplification)
- **Accuracy**: Medium (preserves general shape)
- **Best for**: Testing/comparison at zoom 11-12
- **How it works**: Aggressive Douglas-Peucker simplification
  - Zoom ≤11: tolerance 0.01
  - Zoom 12: tolerance 0.005
  - Zoom 13: tolerance 0.002
  - Zoom 14+: tolerance 0.001

### 3. `none`
- **Speed**: Slowest (no simplification)
- **Accuracy**: Highest (original polygon detail)
- **Best for**: Zoom 13+ when accuracy is critical
- **How it works**: Uses original vector tile polygons

## Usage

```javascript
// Create DemSource with worker: false to enable setSimplificationMethod
const demSource = new maplibrecontour.DemSource({
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  encoding: 'terrarium',
  maxzoom: 15,
  worker: false, // Required! Worker mode doesn't support setSimplificationMethod
  vectorTileUrl: 'https://api.maptoolkit.net/terrain/{z}/{x}/{y}.pbf'
});

// Set the simplification method
demSource.setSimplificationMethod('douglas-peucker'); // or 'convex-hull' or 'none'

// Then use it in MapLibre
map.addSource('contours', {
  type: 'vector',
  tiles: [demSource.contourProtocolUrl(/* ... */)],
  // ...
});
```

**Important**: `setSimplificationMethod()` only works when `worker: false` in the DemSource constructor. Worker mode doesn't expose the ContourSplitter instance.

## Logging Output

The new logging provides detailed per-polygon information:

```
[Polygon preprocessing] z13:
  Method: douglas-peucker
  Polygons: 15→14 (filtered 1)
  Avg vertices: 45.2→12.3 (-72.8%)
  Simplification time: 2.3ms
  Per-polygon details:
    Polygon: 52→14 vertices (-73.1%), 0.18ms
    Polygon: 38→10 vertices (-73.7%), 0.12ms
    ...
```

## Automatic Zoom-Based Behavior

- **Convex hull mode**: Automatically disabled at zoom 13+ (switches to 'none')
- **Douglas-Peucker mode**: Uses zoom-dependent tolerance
- **None mode**: Always uses original polygons

## Testing Recommendations

1. **Compare methods at zoom 12**:
   - Test with `convex-hull` for baseline speed
   - Test with `douglas-peucker` to see if it provides better accuracy with acceptable speed
   
2. **Zoom 13-14 accuracy testing**:
   - Use `none` (default at these zooms) for maximum accuracy
   - Optionally test `douglas-peucker` if speed is critical

3. **Check the logs** to see:
   - Per-polygon vertex reduction
   - Processing time for each polygon
   - Overall simplification time
