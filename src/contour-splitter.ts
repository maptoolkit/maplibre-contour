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

    const startTime = performance.now();
    
    // Filter and simplify polygons based on zoom level
    const processedPolygons = this.preprocessPolygons(polygons, zoom);
    
    // Early exit if no relevant polygons after filtering
    if (processedPolygons.length === 0) {
      return this.markAllAsNormal(isolines);
    }
    
    // Index polygons with bounding boxes
    const indexedPolygons = this.indexPolygons(processedPolygons);
    
    // Build grid-based spatial index for faster lookups
    const gridIndex = this.buildGridIndex(indexedPolygons);
    const indexTime = performance.now() - startTime;
    
    const result: SplitContoursResult = {};
    let totalLineCount = 0;

    // Process each elevation level
    for (const [elevationStr, lineStrings] of Object.entries(isolines)) {
      const elevation = Number(elevationStr);
      result[elevation] = [];
      totalLineCount += lineStrings.length;

      // Process each line string at this elevation
      for (const coords of lineStrings) {
        // Convert flat array to turf LineString
        const line = this.coordsToLineString(coords, extent);
        
        // Use grid index to get candidate polygons
        const candidatePolygons = this.getCandidatePolygonsFromGrid(line, gridIndex);
        
        // Split this line by candidate polygons only
        const segments = this.splitLineByPolygons(line, candidatePolygons, extent);
        
        result[elevation].push(...segments);
      }
    }

    // Log summary
    const terrainCounts: { normal: number; glacier: number; rock: number } = { normal: 0, glacier: 0, rock: 0 };
    for (const segments of Object.values(result)) {
      for (const seg of segments) {
        if (seg.terrainType === 'normal') terrainCounts.normal++;
        else if (seg.terrainType === 'glacier') terrainCounts.glacier++;
        else if (seg.terrainType === 'rock') terrainCounts.rock++;
      }
    }
    const splitTime = performance.now() - startTime;
    console.log(`[ContourSplitter] ${totalLineCount} lines, ${processedPolygons.length} polygons: index=${indexTime.toFixed(0)}ms, total=${splitTime.toFixed(0)}ms → ${terrainCounts.glacier} glacier, ${terrainCounts.rock} rock, ${terrainCounts.normal} normal`);

    return result;
  }

  /**
   * Preprocess polygons: filter tiny ones and simplify based on zoom level
   */
  private preprocessPolygons(polygons: TerrainPolygon[], zoom: number): TerrainPolygon[] {
    // Calculate minimum area threshold based on zoom
    // At zoom 11, filter more aggressively; at zoom 14+, keep more detail
    // Area is in normalized 0-1 coordinates, so tiny values matter
    const minAreaThreshold = zoom <= 11 ? 0.00005 : 
                            zoom === 12 ? 0.00002 : 
                            zoom === 13 ? 0.00001 : 
                            0.000005;
    
    // Simplification tolerance: more aggressive at lower zoom
    const simplifyTolerance = zoom <= 11 ? 0.002 : 
                             zoom === 12 ? 0.001 : 
                             zoom === 13 ? 0.0005 : 
                             0.0002;
    
    // Use convex hull at zoom 11-13 for dramatic speedup
    const useConvexHull = zoom <= 13;
    
    const processed: TerrainPolygon[] = [];
    let filteredCount = 0;
    let totalVerticesBefore = 0;
    let totalVerticesAfter = 0;
    let convexHullCount = 0;
    
    for (const polygon of polygons) {
      // Calculate approximate area using shoelace formula
      const coords = polygon.geometry.coordinates[0] as Position[];
      totalVerticesBefore += coords.length;
      const area = this.calculatePolygonArea(coords);
      
      // Skip tiny polygons
      if (area < minAreaThreshold) {
        filteredCount++;
        continue;
      }
      
      let processedPolygon: TerrainPolygon | null = polygon;
      
      // Apply convex hull for zoom 11 (much faster than detailed polygon)
      if (useConvexHull) {
        processedPolygon = this.convexHullPolygon(polygon);
        if (processedPolygon) {
          convexHullCount++;
        }
      } else {
        // Simplify polygon to reduce vertex count
        processedPolygon = this.simplifyPolygon(polygon, simplifyTolerance);
      }
      
      if (processedPolygon) {
        totalVerticesAfter += (processedPolygon.geometry.coordinates[0] as Position[]).length;
        processed.push(processedPolygon);
      } else {
        filteredCount++;
      }
    }
    
    // Performance logging
    if (processed.length > 0) {
      const vertexReduction = ((1 - totalVerticesAfter / totalVerticesBefore) * 100).toFixed(1);
      const hullInfo = useConvexHull ? `, convex hull=${convexHullCount}` : '';
      console.log(`[Polygon preprocessing] z${zoom}: ${polygons.length}→${processed.length} polygons (filtered ${filteredCount}), vertices reduced ${vertexReduction}%${hullInfo}`);
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
   * Create convex hull approximation of polygon
   * Much faster for splitting operations, at the cost of some precision
   */
  private convexHullPolygon(polygon: TerrainPolygon): TerrainPolygon | null {
    try {
      const turfPolygon = turf.polygon(polygon.geometry.coordinates as Position[][]);
      const hull = turf.convex(turfPolygon);
      
      if (!hull || hull.geometry.coordinates[0].length < 4) {
        return null;
      }
      
      return {
        ...polygon,
        geometry: hull.geometry
      };
    } catch (error) {
      // If convex hull fails, return original
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
   * Get bounding box for a line
   */
  private getLineBbox(line: Feature<LineString>): [number, number, number, number] {
    const coords = line.geometry.coordinates;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
    for (const pos of coords) {
      minX = Math.min(minX, pos[0]);
      maxX = Math.max(maxX, pos[0]);
      minY = Math.min(minY, pos[1]);
      maxY = Math.max(maxY, pos[1]);
    }
    
    return [minX, minY, maxX, maxY];
  }

  /**
   * Check if two bounding boxes intersect
   */
  private bboxIntersects(
    bbox1: [number, number, number, number],
    bbox2: [number, number, number, number]
  ): boolean {
    return !(bbox1[2] < bbox2[0] || // bbox1 right < bbox2 left
             bbox1[0] > bbox2[2] || // bbox1 left > bbox2 right
             bbox1[3] < bbox2[1] || // bbox1 top < bbox2 bottom
             bbox1[1] > bbox2[3]);  // bbox1 bottom > bbox2 top
  }

  /**
   * Build a grid-based spatial index for fast polygon lookup
   */
  private buildGridIndex(polygons: IndexedPolygon[]): GridIndex {
    // Use 8x8 grid for good balance between memory and speed
    const gridSize = 8;
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
    // Start with the original line as "normal" terrain
    let segments: ClassifiedContourSegment[] = [{
      geometry: this.lineStringToCoords(line, extent),
      terrainType: 'normal'
    }];

    // Process each polygon individually, accumulating splits
    for (const polygon of polygons) {
      segments = this.splitSegmentsByPolygon(segments, polygon, extent);
    }

    return segments;
  }

  /**
   * Split all segments by a single polygon
   */
  private splitSegmentsByPolygon(
    segments: ClassifiedContourSegment[],
    polygon: IndexedPolygon,
    extent: number
  ): ClassifiedContourSegment[] {
    const result: ClassifiedContourSegment[] = [];
    const turfPolygon = turf.feature(polygon.geometry) as Feature<Polygon | MultiPolygon>;

    for (const segment of segments) {
      // Only split "normal" segments (already classified segments stay as-is)
      if (segment.terrainType !== 'normal') {
        result.push(segment);
        continue;
      }

      const line = this.coordsToLineString(segment.geometry, extent);
      
      // Quick bbox check first
      const lineBbox = this.getLineBbox(line);
      if (!this.bboxIntersects(lineBbox, polygon.bbox)) {
        result.push(segment);
        continue;
      }
      
      try {
        const splitResult = this.splitLineByPolygon(line, polygon, turfPolygon, extent);
        result.push(...splitResult);
      } catch (error) {
        // On error, keep segment as-is
        result.push(segment);
      }
    }

    return result;
  }

  /**
   * Split a line by a single polygon
   */
  private splitLineByPolygon(
    line: Feature<LineString>,
    polygon: IndexedPolygon,
    turfPolygon: Feature<Polygon | MultiPolygon>,
    extent: number
  ): ClassifiedContourSegment[] {

    try {
      // Check if line intersects polygon
      const intersects = turf.booleanIntersects(line, turfPolygon);

      if (!intersects) {
        // Check if entire line is inside
        const firstPoint = turf.point(line.geometry.coordinates[0]);
        const isInside = turf.booleanPointInPolygon(firstPoint, turfPolygon);
        
        // Only classify as glacier/rock if explicitly those types, otherwise normal
        const terrainType = (isInside && (polygon.terrainType === 'glacier' || polygon.terrainType === 'rock')) 
          ? polygon.terrainType 
          : 'normal';

        return [{
          geometry: this.lineStringToCoords(line, extent),
          terrainType
        }];
      }

      // Line crosses polygon - need to split it
      // Only split if polygon is glacier or rock (not unknown)
      if (polygon.terrainType === 'glacier' || polygon.terrainType === 'rock') {
        return this.splitAtBoundary(line, turfPolygon, polygon.terrainType, extent);
      } else {
        return [{
          geometry: this.lineStringToCoords(line, extent),
          terrainType: 'normal'
        }];
      }
      
    } catch (error) {
      // On error, return as normal terrain
      return [{
        geometry: this.lineStringToCoords(line, extent),
        terrainType: 'normal'
      }];
    }
  }

  /**
   * Split line at polygon boundary (optimized version)
   */
  private splitAtBoundary(
    line: Feature<LineString>,
    polygon: Feature<Polygon | MultiPolygon>,
    polygonTerrainType: 'glacier' | 'rock',
    extent: number
  ): ClassifiedContourSegment[] {
    const coords = line.geometry.coordinates;

    if (coords.length < 2) {
      return [{
        geometry: this.lineStringToCoords(line, extent),
        terrainType: 'normal'
      }];
    }

    // Sample points for inside/outside detection (check every Nth point for speed)
    const sampleRate = Math.max(1, Math.floor(coords.length / 20)); // Max 20 samples per line
    const samples: { index: number; inside: boolean }[] = [];
    
    for (let i = 0; i < coords.length; i += sampleRate) {
      const inside = turf.booleanPointInPolygon(turf.point(coords[i]), polygon);
      samples.push({ index: i, inside });
    }
    
    // Add last point if not already sampled
    if (samples[samples.length - 1].index !== coords.length - 1) {
      const inside = turf.booleanPointInPolygon(turf.point(coords[coords.length - 1]), polygon);
      samples.push({ index: coords.length - 1, inside });
    }

    // Check if entire line is inside or outside
    const allInside = samples.every(s => s.inside);
    const allOutside = samples.every(s => !s.inside);
    
    if (allInside) {
      return [{
        geometry: this.lineStringToCoords(line, extent),
        terrainType: polygonTerrainType
      }];
    }
    
    if (allOutside) {
      return [{
        geometry: this.lineStringToCoords(line, extent),
        terrainType: 'normal'
      }];
    }

    // Line crosses boundary - need detailed splitting
    const segments: ClassifiedContourSegment[] = [];
    let currentSegment: Position[] = [coords[0]];
    let currentInside = samples[0].inside;

    for (let i = 1; i < coords.length; i++) {
      const point = turf.point(coords[i]);
      const isInside = turf.booleanPointInPolygon(point, polygon);

      if (isInside === currentInside) {
        // Same state - continue segment
        currentSegment.push(coords[i]);
      } else {
        // State changed - finish current segment
        currentSegment.push(coords[i]);
        
        if (currentSegment.length >= 2) {
          const segmentLine = turf.lineString(currentSegment);
          segments.push({
            geometry: this.lineStringToCoords(segmentLine, extent),
            terrainType: currentInside ? polygonTerrainType : 'normal'
          });
        }

        // Start new segment
        currentSegment = [coords[i]];
        currentInside = isInside;
      }
    }

    // Add final segment
    if (currentSegment.length >= 2) {
      const segmentLine = turf.lineString(currentSegment);
      segments.push({
        geometry: this.lineStringToCoords(segmentLine, extent),
        terrainType: currentInside ? polygonTerrainType : 'normal'
      });
    }

    return segments.length > 0 ? segments : [{
      geometry: this.lineStringToCoords(line, extent),
      terrainType: 'normal'
    }];
  }
}