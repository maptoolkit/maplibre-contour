import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { TerrainPolygon, ParsedVectorTile } from './types';

/**
 * Loads and parses vector tiles, extracting terrain polygons for contour splitting.
 * 
 * This class handles:
 * - Parsing Mapbox Vector Tile (MVT) format data
 * - Extracting polygon features from a specific layer
 * - Classifying polygons by terrain type (glacier, rock, etc.)
 * - Converting coordinates to tile-relative positioning
 */
export class VectorTileLoader {
  private vectorTileUrlPattern?: string;
  private vectorSourceLayer: string;
  private vectorTerrainTypes: {
    glacier: string[];
    rock: string[];
  };

  constructor(
    vectorTileUrlPattern: string | undefined,
    vectorSourceLayer: string = 'natural',
    vectorTerrainTypes?: {
      glacier?: string[];
      rock?: string[];
    }
  ) {
    this.vectorTileUrlPattern = vectorTileUrlPattern;
    this.vectorSourceLayer = vectorSourceLayer;
    this.vectorTerrainTypes = {
      glacier: vectorTerrainTypes?.glacier || ['ice', 'glacier'],
      rock: vectorTerrainTypes?.rock || ['rock', 'bare_rock', 'scree']
    };
  }

  /**
   * Check if vector tile loading is enabled (URL pattern is configured)
   */
  isEnabled(): boolean {
    return !!this.vectorTileUrlPattern;
  }

  /**
   * Parse vector tile PBF data and extract terrain polygons.
   * 
   * @param arrayBuffer Raw PBF data from the vector tile
   * @param z Tile zoom level
   * @param x Tile x coordinate  
   * @param y Tile y coordinate
   * @returns Parsed polygons with terrain type classification
   */
  parseVectorTile(
    arrayBuffer: ArrayBuffer,
    z: number,
    x: number,
    y: number
  ): ParsedVectorTile {
    try {
      const tile = new VectorTile(new Pbf(arrayBuffer));
      const layer = tile.layers[this.vectorSourceLayer];

      if (!layer) {
        return { polygons: [] };
      }

      const polygons: TerrainPolygon[] = [];

      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);

        // Only process polygons (geometry type 3)
        if (feature.type !== 3) continue;

        const properties = feature.properties;
        const typeValue = properties.type;

        if (!typeValue || typeof typeValue !== 'string') continue;

        // Categorize terrain type based on 'type' property
        const terrainType = this.categorizeTerrainType(typeValue);
        
        if (terrainType === 'unknown') continue;

        // Get geometry in tile coordinates (don't convert to geographic)
        const tileGeometry = feature.loadGeometry();
        
        // Convert tile coordinate rings to normalized 0-1 coordinates
        const normalizedGeometry = this.normalizeGeometry(tileGeometry, layer.extent);

        polygons.push({
          geometry: normalizedGeometry as any,
          properties,
          terrainType
        });
      }

      return { polygons };
      
    } catch (error) {
      console.warn('Error parsing vector tile:', error);
      return { polygons: [] };
    }
  }

  /**
   * Normalize geometry from tile coordinates to 0-1 range
   */
  private normalizeGeometry(
    rings: { x: number; y: number }[][],
    extent: number
  ): import('geojson').Polygon | import('geojson').MultiPolygon {
    // Vector tile geometry is an array of rings
    // For polygons: first ring is exterior, subsequent are holes
    // For multipolygons: separate polygon groups
    
    const normalizedRings = rings.map(ring => 
      ring.map(point => [point.x / extent, point.y / extent])
    );

    // Simple case: single polygon (possibly with holes)
    if (normalizedRings.length === 1) {
      return {
        type: 'Polygon',
        coordinates: normalizedRings
      };
    }

    // Multiple rings - treat as single polygon with potential holes
    // (Most terrain features are single polygons)
    return {
      type: 'Polygon',
      coordinates: normalizedRings
    };
  }

  /**
   * Categorize type property into terrain types we care about
   */
  private categorizeTerrainType(typeValue: string): 'glacier' | 'rock' | 'unknown' {
    if (this.vectorTerrainTypes.glacier.includes(typeValue)) {
      return 'glacier';
    }
    if (this.vectorTerrainTypes.rock.includes(typeValue)) {
      return 'rock';
    }
    return 'unknown';
  }
}