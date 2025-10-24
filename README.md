# maplibre-contour

maplibre-contour is a plugin to render contour lines in [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) from `raster-dem` sources that powers the terrain mode for [onthegomap.com](https://onthegomap.com).

![Topographic map of Mount Washington](demo.png)

[Live example](https://onthegomap.github.io/maplibre-contour) | [Code](./index.html)

To use it, import the [maplibre-contour](https://www.npmjs.com/package/maplibre-contour) package with a script tag:

```html
<script src="https://unpkg.com/maplibre-contour@0.1.0/dist/index.min.js"></script>
```

Or as an ES6 module: `npm add maplibre-contour`

```js
import mlcontour from "maplibre-contour";
```

Then to use, first create a `DemSource` and register it with maplibre:

```js
var demSource = new mlcontour.DemSource({
  url: "https://url/of/dem/source/{z}/{x}/{y}.png",
  encoding: "terrarium", // "mapbox" or "terrarium" default="terrarium"
  maxzoom: 13,
  worker: true, // offload isoline computation to a web worker to reduce jank
  cacheSize: 100, // number of most-recent tiles to cache
  timeoutMs: 10_000, // timeout on fetch requests
});
demSource.setupMaplibre(maplibregl);
```

Then configure a new contour source and add it to your map:

```js
map.addSource("contour-source", {
  type: "vector",
  tiles: [
    demSource.contourProtocolUrl({
      // convert meters to feet, default=1 for meters
      multiplier: 3.28084,
      thresholds: {
        // zoom: [minor, major]
        11: [200, 1000],
        12: [100, 500],
        14: [50, 200],
        15: [20, 100],
      },
      // optional, override vector tile parameters:
      contourLayer: "contours",
      elevationKey: "ele",
      levelKey: "level",
      extent: 4096,
      buffer: 1,
    }),
  ],
  maxzoom: 15,
});
```

Then add contour line and label layers:

```js
map.addLayer({
  id: "contour-lines",
  type: "line",
  source: "contour-source",
  "source-layer": "contours",
  paint: {
    "line-color": "rgba(0,0,0, 50%)",
    // level = highest index in thresholds array the elevation is a multiple of
    "line-width": ["match", ["get", "level"], 1, 1, 0.5],
  },
});
map.addLayer({
  id: "contour-labels",
  type: "symbol",
  source: "contour-source",
  "source-layer": "contours",
  filter: [">", ["get", "level"], 0],
  layout: {
    "symbol-placement": "line",
    "text-size": 10,
    "text-field": ["concat", ["number-format", ["get", "ele"], {}], "'"],
    "text-font": ["Noto Sans Bold"],
  },
  paint: {
    "text-halo-color": "white",
    "text-halo-width": 1,
  },
});
```

You can also share the cached tiles with other maplibre sources that need elevation data:

```js
map.addSource("dem", {
  type: "raster-dem",
  encoding: "terrarium",
  tiles: [demSource.sharedDemProtocolUrl],
  maxzoom: 13,
  tileSize: 256,
});
```

## Terrain-Based Contour Splitting

Split contour lines based on underlying terrain types (glaciers, rock/scree) from vector tiles. This enables different styling for contours crossing different terrain types.

### Setup

Configure terrain splitting when creating a `DemSource`:

```javascript
const demSource = new mlcontour.DemSource({
  url: 'https://elevation-tiles.s3.amazonaws.com/{z}/{x}/{y}.png',
  encoding: 'terrarium',
  maxzoom: 13,
  worker: true, // terrain splitting works in both worker and non-worker mode
  
  // Enable terrain-based splitting
  vectorTileUrl: 'https://tiles.example.com/{z}/{x}/{y}.pbf',
  vectorSourceLayer: 'natural',  // default: 'natural'
  vectorTerrainTypes: {
    glacier: ['ice', 'glacier'],              // default: ['ice', 'glacier']
    rock: ['rock', 'bare_rock', 'scree']      // default: ['rock', 'bare_rock', 'scree']
  }
});
demSource.setupMaplibre(maplibregl);
```

### Using the Custom Vector Tile Protocol

To avoid duplicate network requests, use the custom protocol for your vector tile source:

```javascript
map.addSource('terrain-polygons', {
  type: 'vector',
  tiles: [demSource.vectorTileProtocolUrl],  // Use custom protocol
  minzoom: 0,
  maxzoom: 14
});
```

This enables:
- **Shared caching**: Vector tiles fetched once, used by both MapLibre rendering and contour splitting
- **No duplicate requests**: One network request per tile instead of two
- **Worker support**: Works seamlessly with `worker: true` mode

### Styling by Terrain Type

Contour features will include a `terrain_type` property (`'normal'`, `'glacier'`, or `'rock'`):

```javascript
// Normal terrain contours (brown)
map.addLayer({
  id: 'contours-normal',
  type: 'line',
  source: 'contours',
  'source-layer': 'contours',
  filter: ['==', ['get', 'terrain_type'], 'normal'],
  paint: {
    'line-color': '#8B4513',
    'line-width': ['match', ['get', 'level'], 1, 2, 1]
  }
});

// Glacier contours (blue)
map.addLayer({
  id: 'contours-glacier',
  type: 'line',
  source: 'contours',
  'source-layer': 'contours',
  filter: ['==', ['get', 'terrain_type'], 'glacier'],
  paint: {
    'line-color': '#4A90E2',
    'line-width': ['match', ['get', 'level'], 1, 2, 1]
  }
});

// Rock/scree contours (gray)
map.addLayer({
  id: 'contours-rock',
  type: 'line',
  source: 'contours',
  'source-layer': 'contours',
  filter: ['==', ['get', 'terrain_type'], 'rock'],
  paint: {
    'line-color': '#696969',
    'line-width': ['match', ['get', 'level'], 1, 2, 1]
  }
});
```

### Configuration Options

- **`vectorTileUrl`**: URL pattern for vector tiles (e.g., `'https://tiles.com/{z}/{x}/{y}.pbf'`)
  - Set to `undefined` to disable terrain splitting
- **`vectorSourceLayer`**: Layer name in vector tiles containing terrain polygons
  - Default: `'natural'`
- **`vectorTerrainTypes`**: Object mapping terrain categories to feature property values
  - `glacier`: Array of values to classify as glaciers (default: `['ice', 'glacier']`)
  - `rock`: Array of values to classify as rock/scree (default: `['rock', 'bare_rock', 'scree']`)
  - Features with `type` property matching these values will be used for classification
  - Features not matching any category are ignored (contours marked as `'normal'`)

### Performance

Terrain splitting is highly optimized:

- **Network**: Uses custom protocol to prevent duplicate fetches (~160KB saved per tile)
- **First load**: ~150-500ms per tile (fetch + parse + split, varies by zoom)
- **Cached tiles**: ~50-150ms per tile (split only)
- **Memory**: ~2MB for 100 cached vector tiles
- **Optimizations**:
  - Convex hull approximation for zoom levels ≤13 (75-82% fewer vertices)
  - Grid-based spatial indexing (8×8 cells) for fast polygon lookup
  - Polygon area filtering to remove noise
  - Smart sampling (max 20 points per line segment)

Zoom-specific performance (Mont Blanc area, typical case):
- **Zoom 11**: ~520ms (large glaciers, convex hull used)
- **Zoom 12**: ~285ms (moderate detail, convex hull + grid index)
- **Zoom 13**: ~430ms (fine detail, convex hull)
- **Zoom 14**: ~95ms (full precision, grid index only)

# How it works

<img src="architecture.png" width="500">

[`DemSource.setupMaplibre`](./src/dem-source.ts) uses MapLibre's [`addProtocol`](https://maplibre.org/maplibre-gl-js-docs/api/properties/#addprotocol) utility to register callbacks to provide vector tiles for the contours source and optionally for vector tiles used in terrain splitting. Each time maplibre requests a contour vector tile:

- [`DemManager`](./src/local-dem-manager.ts) fetches (and caches) the raster-dem image tile and its neighbors so that contours are continuous across tile boundaries.
  - When `DemSource` is configured with `worker: true`, it uses [`RemoteDemManager`](./src/remote-dem-manager.ts) to spawn [`worker.ts`](./src/worker.ts) in a web worker. The web worker runs [`LocalDemManager`](./src/local-dem-manager.ts) locally and uses the [`Actor`](./src/actor.ts) utility to send cancelable requests and responses between the main and worker thread.
- [`decode-image.ts`](./src/decode-image.ts) decodes the raster-dem image RGB values to meters above sea level for each pixel in the tile.
- [`HeightTile`](./src/height-tile.ts) stitches those raw DEM tiles into a "virtual tile" that contains the border of neighboring tiles, aligns elevation measurements to the tile grid, and smooths the elevation measurements.
- [`isolines.ts`](./src/isolines.ts) generates contour isolines from a `HeightTile` using a marching-squares implementation derived from [d3-contour](https://github.com/d3/d3-contour).
- **Optional terrain splitting**:
  - [`VectorTileLoader`](./src/vector-tile-loader.ts) fetches and parses vector tiles containing terrain polygons (glaciers, rock, etc.)
  - [`ContourSplitter`](./src/contour-splitter.ts) classifies contour segments based on which terrain polygon they cross
  - Uses optimizations like convex hull approximation, grid-based spatial indexing, and polygon area filtering
  - Custom protocol ensures vector tiles are fetched once and shared between MapLibre rendering and contour splitting
- [`vtpbf.ts`](./src/vtpbf.ts) encodes the contour isolines (with optional terrain type metadata) as mapbox vector tile bytes.

MapLibre sends that vector tile to its own worker, decodes it, and renders as if it had been generated by a server.

# Why?

There are a lot of parameters you can tweak when generating contour lines from elevation data like units, thresholds, and smoothing parameters. Pre-generated contour vector tiles require 100+gb of storage for each variation you want to generate and host. Generating them on-the-fly in the browser gives infinite control over the variations you can use on a map from the same source of raw elevation data that maplibre uses to render hillshade.

# License

maplibre-contour is licensed under the [BSD 3-Clause License](LICENSE). It includes code adapted from:

- [d3-contour](https://github.com/d3/d3-contour) (ISC license)
- [vt-pbf](https://github.com/mapbox/vt-pbf) (MIT license)
