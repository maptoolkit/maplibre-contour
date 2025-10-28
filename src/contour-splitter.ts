import * as turf from '@turf/turf';
import type { Feature, LineString, Position, Polygon, MultiPolygon } from 'geojson';
import type { 
  TerrainPolygon, 
  ClassifiedContourSegment,
  SplitContoursResult 
} from './types';

/**
 * Polygon with precomputed bounding box for faster intersection tests
 */
interface IndexedPolygon extends TerrainPolygon {
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY]
}

/**
 * Grid-based spatial index for fast polygon lookup
 */
interface GridIndex {
  gridSize: number;
  cellSize: number;
  cells: Map<string, IndexedPolygon[]>;
}

/**
 * Splits contour lines by terrain polygons using geometric operations.
 */
export class ContourSplitter {
  /**
   * Split contours by terrain polygons, classifying each segment
   * 
   * @param isolines Original isolines from generateIsolines: {elevation: [[x,y,x,y,...], ...]}
   * @param polygons Terrain polygons from vector tile
   * @param extent Tile extent (e.g., 4096)
   * @param zoom Current zoom level (for simplification)
   * @returns Isolines split and classified by terrain type
   */
  splitContours(
    isolines: { [elevation: number]: number[][] },
    polygons: TerrainPolygon[],
    extent: number,
    zoom: number = 12
  ): SplitContoursResult {
    if (polygons.length === 0) {
      return this.markAllAsNormal(isolines);
    }

    // Filter and simplify polygons based on zoom level
    const processedPolygons = this.preprocessPolygons(polygons, zoom);
    
    // Index polygons with bounding boxes
    const indexedPolygons = this.indexPolygons(processedPolygons);
    
    // Build grid-based spatial index for faster lookups (zoom 11-13)
    const gridIndex = zoom < 14 ? this.buildGridIndex(indexedPolygons, zoom) : null;
    
    const result: SplitContoursResult = {};

    // Process each elevation level
    for (const [elevationStr, lineStrings] of Object.entries(isolines)) {
      const elevation = Number(elevationStr);
      result[elevation] = [];

      // Process each line string at this elevation
      for (const coords of lineStrings) {
        // Convert flat array to turf LineString
        const line = this.coordsToLineString(coords, extent);
        
        // Get candidate polygons from grid or use all
        const candidatePolygons = gridIndex
          ? this.getCandidatePolygonsFromGrid(line, gridIndex)
          : indexedPolygons;
        
        // Early exit: if no candidate polygons, mark as normal
        if (candidatePolygons.length === 0) {
          result[elevation].push({
            geometry: coords,
            terrainType: 'normal'
          });
          continue;
        }
        
        // Split this line by candidate polygons
        const segments = this.splitLineByPolygons(line, candidatePolygons, extent);
        
        result[elevation].push(...segments);
      }
    }

    return result;
  }

  /**
   * Preprocess polygons: filter tiny ones and simplify using Douglas-Peucker
   */
  private preprocessPolygons(polygons: TerrainPolygon[], zoom: number): TerrainPolygon[] {
    // Calculate minimum area threshold based on zoom
    const minAreaThreshold = zoom <= 11 ? 0.00005 : 
                            zoom === 12 ? 0.00002 : 
                            zoom === 13 ? 0.00001 : 
                            0.000005;
    
    // Douglas-Peucker tolerance
    const douglasPeuckerTolerance = zoom <= 11 ? 0.01 : 
                                     zoom === 12 ? 0.005 : 
                                     zoom === 13 ? 0.002 : 
                                     0.001;
    
    const processed: TerrainPolygon[] = [];
    
    for (const polygon of polygons) {
      // Calculate approximate area using shoelace formula
      const coords = polygon.geometry.coordinates[0] as Position[];
      const area = this.calculatePolygonArea(coords);
      
      // Skip tiny polygons
      if (area < minAreaThreshold) {
        continue;
      }
      
      // Apply Douglas-Peucker simplification
      const processedPolygon = this.simplifyPolygon(polygon, douglasPeuckerTolerance);
      
      if (processedPolygon) {
        processed.push(processedPolygon);
      }
    }
    
    return processed;
  }

  /**
   * Calculate polygon area using shoelace formula
   */
  private calculatePolygonArea(coords: Position[]): number {
    let area = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      area += coords[i][0] * coords[i + 1][1];
      area -= coords[i + 1][0] * coords[i][1];
    }
    return Math.abs(area) / 2;
  }

  /**
   * Simplify polygon using Douglas-Peucker algorithm
   */
  private simplifyPolygon(polygon: TerrainPolygon, tolerance: number): TerrainPolygon | null {
    try {
      const turfPolygon = turf.polygon(polygon.geometry.coordinates as Position[][]);
      const simplified = turf.simplify(turfPolygon, { tolerance, highQuality: false });
      
      // Ensure we still have a valid polygon after simplification
      if (simplified.geometry.coordinates[0].length < 4) {
        return null;
      }
      
      return {
        ...polygon,
        geometry: simplified.geometry
      };
    } catch (error) {
      // If simplification fails, return original
      return polygon;
    }
  }

  /**
   * Index polygons with bounding boxes for faster spatial queries
   */
  private indexPolygons(polygons: TerrainPolygon[]): IndexedPolygon[] {
    return polygons.map(polygon => {
      const coords = polygon.geometry.coordinates[0];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      
      for (const pos of coords as Position[]) {
        minX = Math.min(minX, pos[0]);
        maxX = Math.max(maxX, pos[0]);
        minY = Math.min(minY, pos[1]);
        maxY = Math.max(maxY, pos[1]);
      }
      
      return {
        ...polygon,
        bbox: [minX, minY, maxX, maxY]
      };
    });
  }

  /**
   * Build a grid-based spatial index for fast polygon lookup
   * Grid size: 8x8 (z11-12), 4x4 (z13), disabled (z14+)
   */
  private buildGridIndex(polygons: IndexedPolygon[], zoom: number): GridIndex {
    // Grid size based on zoom level
    const gridSize = zoom <= 12 ? 8 : 4;
    
    const cellSize = 1.0 / gridSize;
    const cells = new Map<string, IndexedPolygon[]>();
    
    // Insert each polygon into all grid cells it overlaps
    for (const polygon of polygons) {
      const [minX, minY, maxX, maxY] = polygon.bbox;
      
      // Find grid cells this polygon overlaps
      const minCellX = Math.floor(minX / cellSize);
      const maxCellX = Math.floor(maxX / cellSize);
      const minCellY = Math.floor(minY / cellSize);
      const maxCellY = Math.floor(maxY / cellSize);
      
      // Add polygon to all overlapping cells
      for (let x = minCellX; x <= maxCellX; x++) {
        for (let y = minCellY; y <= maxCellY; y++) {
          const key = `${x},${y}`;
          if (!cells.has(key)) {
            cells.set(key, []);
          }
          cells.get(key)!.push(polygon);
        }
      }
    }
    
    return { gridSize, cellSize, cells };
  }

  /**
   * Get candidate polygons from grid index based on line coordinates
   */
  private getCandidatePolygonsFromGrid(
    line: Feature<LineString>,
    grid: GridIndex
  ): IndexedPolygon[] {
    const coords = line.geometry.coordinates;
    const visitedCells = new Set<string>();
    const candidateSet = new Set<IndexedPolygon>();
    
    // Sample points along the line to determine which grid cells it passes through
    for (const pos of coords) {
      const cellX = Math.floor(pos[0] / grid.cellSize);
      const cellY = Math.floor(pos[1] / grid.cellSize);
      const key = `${cellX},${cellY}`;
      
      if (!visitedCells.has(key)) {
        visitedCells.add(key);
        const cellPolygons = grid.cells.get(key);
        if (cellPolygons) {
          for (const polygon of cellPolygons) {
            candidateSet.add(polygon);
          }
        }
      }
    }
    
    return Array.from(candidateSet);
  }

  /**
   * Mark all contours as normal terrain (no splitting)
   */
  private markAllAsNormal(
    isolines: { [elevation: number]: number[][] }
  ): SplitContoursResult {
    const result: SplitContoursResult = {};
    
    for (const [elevationStr, lineStrings] of Object.entries(isolines)) {
      const elevation = Number(elevationStr);
      result[elevation] = lineStrings.map(geometry => ({
        geometry,
        terrainType: 'normal'
      }));
    }
    
    return result;
  }

  /**
   * Convert flat coordinate array to turf LineString in geographic coordinates
   */
  private coordsToLineString(
    coords: number[],
    extent: number
  ): Feature<LineString> {
    const positions: Position[] = [];
    
    for (let i = 0; i < coords.length; i += 2) {
      // Normalize to 0-1, then to lon/lat
      const x = coords[i] / extent;
      const y = coords[i + 1] / extent;
      positions.push([x, y]);
    }
    
    return turf.lineString(positions);
  }

  /**
   * Convert turf LineString back to flat array in tile coordinates
   */
  private lineStringToCoords(
    line: Feature<LineString>,
    extent: number
  ): number[] {
    const coords: number[] = [];
    
    for (const pos of line.geometry.coordinates) {
      coords.push(
        Math.round(pos[0] * extent),
        Math.round(pos[1] * extent)
      );
    }
    
    return coords;
  }

  /**
   * Split a single line by all polygons
   */
  private splitLineByPolygons(
    line: Feature<LineString>,
    polygons: IndexedPolygon[],
    extent: number
  ): ClassifiedContourSegment[] {
    const coords = line.geometry.coordinates;
    
    if (coords.length < 2) {
      return [{
        geometry: this.lineStringToCoords(line, extent),
        terrainType: 'normal'
      }];
    }

    // Determine terrain type for each point by checking all polygons
    const pointTypes: ('normal' | 'glacier' | 'rock')[] = [];
    
    for (const coord of coords) {
      const point = turf.point(coord);
      let terrainType: 'normal' | 'glacier' | 'rock' = 'normal';
      
      // Check all polygons to find the terrain type at this point
      for (const polygon of polygons) {
        if (polygon.terrainType === 'glacier' || polygon.terrainType === 'rock') {
          const turfPolygon = turf.feature(polygon.geometry) as Feature<Polygon | MultiPolygon>;
          if (turf.booleanPointInPolygon(point, turfPolygon)) {
            terrainType = polygon.terrainType;
            // Prioritize rock over glacier if overlapping (optional - can change)
            if (terrainType === 'glacier') break;
          }
        }
      }
      
      pointTypes.push(terrainType);
    }

    // Split line into segments based on terrain type changes
    // Use minimum run length to filter out narrow sliver polygons
    const minRunLength = 10;
    const segments: ClassifiedContourSegment[] = [];
    let currentSegment: Position[] = [coords[0]];
    let currentType = pointTypes[0];
    let potentialSegment: Position[] = [];
    let potentialType: 'normal' | 'glacier' | 'rock' | null = null;

    for (let i = 1; i < coords.length; i++) {
      if (pointTypes[i] === currentType) {
        // Same type as current segment
        if (potentialSegment.length > 0) {
          // We were building a potential segment, but type changed back
          // Append potential segment to current segment (it was too short)
          currentSegment.push(...potentialSegment);
          potentialSegment = [];
          potentialType = null;
        }
        currentSegment.push(coords[i]);
      } else if (potentialType === null || pointTypes[i] === potentialType) {
        // Building a potential new segment
        potentialSegment.push(coords[i]);
        potentialType = pointTypes[i];
        
        // Check if potential segment is now long enough to become permanent
        if (potentialSegment.length >= minRunLength) {
          // Commit current segment (include last vertex for continuity)
          if (currentSegment.length >= 2) {
            // Add the first vertex of potential segment to close the gap
            currentSegment.push(potentialSegment[0]);
            const segmentLine = turf.lineString(currentSegment);
            segments.push({
              geometry: this.lineStringToCoords(segmentLine, extent),
              terrainType: currentType
            });
          }
          
          // Promote potential segment to current segment
          currentSegment = potentialSegment;
          currentType = potentialType;
          potentialSegment = [];
          potentialType = null;
        }
      } else {
        // Type changed again while building potential segment
        // Append potential segment to current (it was too short)
        currentSegment.push(...potentialSegment);
        
        // Start new potential segment with this vertex
        potentialSegment = [coords[i]];
        potentialType = pointTypes[i];
      }
    }

    // Handle any remaining potential segment
    if (potentialSegment.length > 0) {
      currentSegment.push(...potentialSegment);
    }

    // Add final segment
    if (currentSegment.length >= 2) {
      const segmentLine = turf.lineString(currentSegment);
      segments.push({
        geometry: this.lineStringToCoords(segmentLine, extent),
        terrainType: currentType
      });
    }

    return segments.length > 0 ? segments : [{
      geometry: this.lineStringToCoords(line, extent),
      terrainType: 'normal'
    }];
  }


}