# MapLibre Contour Integration Guide

This guide explains how to integrate the maplibre-contour plugin into an existing MapLibre GL JS project.

## Overview

The maplibre-contour plugin generates topographic contour lines from DEM (Digital Elevation Model) tiles. It supports:
- Dynamic contour generation at multiple zoom levels
- Terrain-aware splitting (contours colored by terrain type: normal/glacier/rock)
- Worker-based processing for performance
- Custom protocol handlers for seamless MapLibre integration

## Required Files

You need **ONE** JavaScript file from the maplibre-contour distribution. Choose based on your setup:

### Option 1: Browser Script Tag (Recommended for HTML)
**`dist/index.js`** or **`dist/index.min.js`** - UMD bundle
- The minified version is smaller (54KB vs 161KB)
- Includes the worker code embedded as a Blob URL
- Use directly via `<script>` tag
- Exposes global `mlcontour` object

### Option 2: ES Module
**`dist/index.mjs`** - ES Module format (153KB)
- For use with `import` statements
- Includes embedded worker

### Option 3: CommonJS
**`dist/index.cjs`** - CommonJS format (153KB)
- For Node.js-style `require()`
- Includes embedded worker

**Note:** The worker code is bundled inside these files as a string and gets converted to a Blob URL at runtime, so you don't need separate worker files!

## Installation Steps

### 1. Include the Script

Add the maplibre-contour script to your HTML, **before** you create your MapLibre map:

```html
<!DOCTYPE html>
<html>
<head>
    <script src="https://unpkg.com/maplibre-gl@5.0.0/dist/maplibre-gl.js"></script>
    <link href="https://unpkg.com/maplibre-gl@5.0.0/dist/maplibre-gl.css" rel="stylesheet" />
    
    <!-- Add maplibre-contour BEFORE map creation -->
    <script src="path/to/dist/index.min.js"></script>
</head>
<body>
    <div id="map"></div>
    <script>
        // Your map initialization code here
    </script>
</body>
</html>
```

### 2. Configure DemSource

**BEFORE** creating your MapLibre map, configure the DemSource. This registers custom protocol handlers with MapLibre:

```javascript
// Create and configure DemSource BEFORE map initialization
const demSource = new mlcontour.DemSource({
    url: "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png",
    encoding: "terrarium",  // or "mapbox" depending on your DEM source
    maxzoom: 13,
    worker: true,  // Enable worker mode for better performance
    cacheSize: 100,  // Number of DEM tiles to cache
    
    // Optional: Enable terrain-aware contour splitting
    vectorTileUrl: "https://vtc-cdn.maptoolkit.net/mtk-contours-bathymetry/{z}/{x}/{y}.pbf",
    vectorSourceLayer: 'natural',
    vectorTerrainTypes: {
        glacier: ['ice'],  // Features with type='ice' become glacier terrain
        rock: ['rock']     // Features with type='rock' become rock terrain
    }
});

// Register protocols with MapLibre - MUST be called before map creation
demSource.setupMaplibre(maplibregl);

// NOW create your map
const map = new maplibregl.Map({
    container: 'map',
    style: 'your-style.json',  // or inline style object
    center: [lng, lat],
    zoom: 12
});
```

### 3. Add Contour Source to Style

Your MapLibre style needs a source definition using the custom `dem-contour://` protocol:

```json
{
    "sources": {
        "contours": {
            "type": "vector",
            "tiles": [
                "dem-contour://{z}/{x}/{y}?contourLayer=contours&elevationKey=ele&levelKey=level&multiplier=1&splitMode=classic&thresholds=11*200*1000~12*100*500~13*50*200~14*20*100"
            ]
        }
    }
}
```

#### URL Parameters Explained:

- **`contourLayer`**: The name of the vector tile layer (use "contours")
- **`elevationKey`**: Property name for elevation values (use "ele")
- **`levelKey`**: Property name for contour importance level (use "level")
- **`multiplier`**: Multiply elevation values (usually 1)
- **`splitMode`**: 
  - `classic` = split contours by terrain type (requires vectorTileUrl)
  - `no-split` = don't split, all contours get terrain_type='normal'
- **`thresholds`**: Zoom-specific contour intervals in format: `zoom*minor*major~zoom*minor*major`
  - Example: `11*200*1000~12*100*500~13*50*200~14*20*100`
  - At zoom 11: minor lines every 200m, major lines every 1000m
  - At zoom 12: minor every 100m, major every 500m
  - etc.

### 4. Add Contour Layers to Style

Add layers that use the contours source. Each contour feature has these properties:

- **`ele`** (number): Elevation in meters
- **`level`** (number): Contour importance (0 = minor, 1+ = major)
- **`terrain_type`** (string): One of "normal", "glacier", or "rock"

Example layers:

```json
{
    "layers": [
        {
            "id": "contours-minor",
            "type": "line",
            "source": "contours",
            "source-layer": "contours",
            "filter": ["==", ["get", "level"], 0],
            "minzoom": 11,
            "paint": {
                "line-color": [
                    "match",
                    ["get", "terrain_type"],
                    "glacier", "hsl(211, 83%, 60%)",
                    "rock", "hsl(0, 0%, 50%)",
                    "hsl(36, 40%, 50%)"
                ],
                "line-width": 1
            }
        },
        {
            "id": "contours-major",
            "type": "line",
            "source": "contours",
            "source-layer": "contours",
            "filter": [">", ["get", "level"], 0],
            "minzoom": 11,
            "paint": {
                "line-color": [
                    "match",
                    ["get", "terrain_type"],
                    "glacier", "hsl(211, 83%, 50%)",
                    "rock", "hsl(0, 0%, 40%)",
                    "hsl(36, 40%, 40%)"
                ],
                "line-width": 2
            }
        },
        {
            "id": "contour-labels",
            "type": "symbol",
            "source": "contours",
            "source-layer": "contours",
            "filter": [">", ["get", "level"], 0],
            "minzoom": 12,
            "layout": {
                "symbol-placement": "line",
                "text-field": ["concat", ["get", "ele"], "m"],
                "text-size": 11,
                "text-font": ["Open Sans Regular"]
            },
            "paint": {
                "text-color": "hsl(36, 40%, 30%)",
                "text-halo-color": "hsla(0, 0%, 100%, 0.8)",
                "text-halo-width": 1.5
            }
        }
    ]
}
```

## Optional: Additional Protocol Handlers

If you want to use shared DEM tiles or vector tiles in your style, the DemSource also registers these protocols:

```json
{
    "sources": {
        "rgb-tiles": {
            "type": "raster-dem",
            "encoding": "terrarium",
            "tiles": ["dem-shared://{z}/{x}/{y}"],
            "maxzoom": 15
        },
        "terrain-polygons": {
            "type": "vector",
            "tiles": ["dem-vector://{z}/{x}/{y}"]
        }
    }
}
```

## Complete Minimal Example

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Contour Map</title>
    <script src="https://unpkg.com/maplibre-gl@5.0.0/dist/maplibre-gl.js"></script>
    <link href="https://unpkg.com/maplibre-gl@5.0.0/dist/maplibre-gl.css" rel="stylesheet" />
    <script src="path/to/dist/index.min.js"></script>
    <style>
        body { margin: 0; padding: 0; }
        #map { position: absolute; top: 0; bottom: 0; width: 100%; }
    </style>
</head>
<body>
    <div id="map"></div>
    <script>
        // 1. Configure DemSource BEFORE map creation
        const demSource = new mlcontour.DemSource({
            url: "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png",
            encoding: "terrarium",
            maxzoom: 13,
            worker: true,
            cacheSize: 100
        });
        
        // 2. Register protocols
        demSource.setupMaplibre(maplibregl);
        
        // 3. Create map with contour source and layers
        const map = new maplibregl.Map({
            container: 'map',
            center: [11.255, 47.261],  // Alps
            zoom: 12,
            style: {
                version: 8,
                sources: {
                    "base-map": {
                        type: "raster",
                        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                        tileSize: 256,
                        attribution: "&copy; OpenStreetMap Contributors"
                    },
                    "contours": {
                        type: "vector",
                        tiles: [
                            "dem-contour://{z}/{x}/{y}?contourLayer=contours&elevationKey=ele&levelKey=level&multiplier=1&splitMode=no-split&thresholds=11*200*1000~12*100*500~13*50*200~14*20*100"
                        ]
                    }
                },
                layers: [
                    {
                        id: "base",
                        type: "raster",
                        source: "base-map"
                    },
                    {
                        id: "contours-minor",
                        type: "line",
                        source: "contours",
                        "source-layer": "contours",
                        filter: ["==", ["get", "level"], 0],
                        minzoom: 11,
                        paint: {
                            "line-color": "hsl(36, 40%, 50%)",
                            "line-width": 1
                        }
                    },
                    {
                        id: "contours-major",
                        type: "line",
                        source: "contours",
                        "source-layer": "contours",
                        filter: [">", ["get", "level"], 0],
                        minzoom: 11,
                        paint: {
                            "line-color": "hsl(36, 40%, 40%)",
                            "line-width": 2
                        }
                    }
                ]
            }
        });
    </script>
</body>
</html>
```

## Critical Order of Operations

1. ✅ Include `mlcontour.js` script
2. ✅ Create `new mlcontour.DemSource(config)`
3. ✅ Call `demSource.setupMaplibre(maplibregl)`
4. ✅ Create `new maplibregl.Map()` with style containing contour source/layers
5. ❌ Do NOT create the map before calling `setupMaplibre()`

## Troubleshooting

**Contours not appearing:**
- Check browser console for errors
- Verify `setupMaplibre()` was called before map creation
- Check that style has both source AND layers using that source
- Verify zoom level is within minzoom/maxzoom range of layers
- Confirm DEM tile URL is accessible (check Network tab)

**Performance issues:**
- Set `worker: true` in DemSource config
- Reduce `cacheSize` if memory is constrained
- Simplify threshold configuration (fewer levels)

**Terrain splitting not working:**
- Verify `vectorTileUrl` is set in DemSource config
- Check vector tiles contain features with correct property names
- Use `splitMode=classic` in contour tile URL
- Verify `vectorSourceLayer` and `vectorTerrainTypes` configuration

## DEM Tile Sources

Common DEM tile sources you can use:

- **Terrarium**: `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png` (encoding: "terrarium")
- **Mapbox**: `https://api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}.png?access_token=YOUR_TOKEN` (encoding: "mapbox")

Make sure the `encoding` parameter in DemSource config matches your tile source format.
