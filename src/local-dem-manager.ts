import AsyncCache from "./cache";
import defaultDecodeImage from "./decode-image";
import { HeightTile } from "./height-tile";
import generateIsolines from "./isolines";
import { encodeIndividualOptions, isAborted, withTimeout } from "./utils";
import type {
  ContourTile,
  DecodeImageFunction,
  DemManager,
  DemManagerInitizlizationParameters,
  DemTile,
  Encoding,
  FetchResponse,
  GetTileFunction,
  IndividualContourTileOptions,
} from "./types";
import encodeVectorTile, { GeomType } from "./vtpbf";
import { Timer } from "./performance";
import { VectorTileLoader } from './vector-tile-loader';
import { ContourSplitter } from './contour-splitter';
import type { ParsedVectorTile, SplitContoursResult } from './types';

const defaultGetTile: GetTileFunction = async (
  url: string,
  abortController: AbortController,
) => {
  const options: RequestInit = {
    signal: abortController.signal,
  };
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Bad response: ${response.status} for ${url}`);
  }
  return {
    data: await response.blob(),
    expires: response.headers.get("expires") || undefined,
    cacheControl: response.headers.get("cache-control") || undefined,
  };
};

/**
 * Caches, decodes, and processes raster tiles in the current thread.
 */
export class LocalDemManager implements DemManager {
  tileCache: AsyncCache<string, FetchResponse>;
  parsedCache: AsyncCache<string, DemTile>;
  contourCache: AsyncCache<string, ContourTile>;

  // NEW: Vector tile support
  vectorTileCache: AsyncCache<string, ParsedVectorTile>;
  vectorTileRawCache: AsyncCache<string, ArrayBuffer>; // Cache raw PBF data
  vectorTileLoader: VectorTileLoader;
  contourSplitter: ContourSplitter;

  demUrlPattern: string;
  encoding: Encoding;
  maxzoom: number;
  timeoutMs: number;
  loaded = Promise.resolve();
  decodeImage: DecodeImageFunction;
  getTile: GetTileFunction;

  constructor(options: DemManagerInitizlizationParameters) {
    this.tileCache = new AsyncCache(options.cacheSize);
    this.parsedCache = new AsyncCache(options.cacheSize);
    this.contourCache = new AsyncCache(options.cacheSize);

    // NEW: Vector tile cache and utilities
    this.vectorTileCache = new AsyncCache(options.cacheSize);
    this.vectorTileRawCache = new AsyncCache(options.cacheSize);
    this.vectorTileLoader = new VectorTileLoader(
      options.vectorTileUrl,
      options.vectorSourceLayer,
      options.vectorTerrainTypes
    );
    this.contourSplitter = new ContourSplitter();

    this.timeoutMs = options.timeoutMs;
    this.demUrlPattern = options.demUrlPattern;
    this.encoding = options.encoding;
    this.maxzoom = options.maxzoom;
    this.decodeImage = options.decodeImage || defaultDecodeImage;
    this.getTile = options.getTile || defaultGetTile;
  }

  fetchTile(
    z: number,
    x: number,
    y: number,
    parentAbortController: AbortController,
    timer?: Timer,
  ): Promise<FetchResponse> {
    const url = this.demUrlPattern
      .replace("{z}", z.toString())
      .replace("{x}", x.toString())
      .replace("{y}", y.toString());
    timer?.useTile(url);
    return this.tileCache.get(
      url,
      (_, childAbortController) => {
        timer?.fetchTile(url);
        const mark = timer?.marker("fetch");
        return withTimeout(
          this.timeoutMs,
          this.getTile(url, childAbortController).finally(() => mark?.()),
          childAbortController,
        );
      },
      parentAbortController,
    );
  }
  fetchAndParseTile = (
    z: number,
    x: number,
    y: number,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<DemTile> => {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const url = this.demUrlPattern
      .replace("{z}", z.toString())
      .replace("{x}", x.toString())
      .replace("{y}", y.toString());

    timer?.useTile(url);

    return this.parsedCache.get(
      url,
      async (_, childAbortController) => {
        const response = await self.fetchTile(
          z,
          x,
          y,
          childAbortController,
          timer,
        );
        if (isAborted(childAbortController)) throw new Error("canceled");
        const promise = self.decodeImage(
          response.data,
          self.encoding,
          childAbortController,
        );
        const mark = timer?.marker("decode");
        const result = await promise;
        mark?.();
        return result;
      },
      abortController,
    );
  };

  async fetchDem(
    z: number,
    x: number,
    y: number,
    options: IndividualContourTileOptions,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<HeightTile> {
    const zoom = Math.min(z - (options.overzoom || 0), this.maxzoom);
    const subZ = z - zoom;
    const div = 1 << subZ;
    const newX = Math.floor(x / div);
    const newY = Math.floor(y / div);

    const tile = await this.fetchAndParseTile(
      zoom,
      newX,
      newY,
      abortController,
      timer,
    );

    return HeightTile.fromRawDem(tile).split(subZ, x % div, y % div);
  }

  // NEW: Fetch vector tile with caching
  fetchVectorTile(
    z: number,
    x: number,
    y: number,
    parentAbortController: AbortController
  ): Promise<ParsedVectorTile> {
    if (!this.vectorTileLoader.isEnabled()) {
      return Promise.resolve({ polygons: [] });
    }

    const url = this.vectorTileLoader['vectorTileUrlPattern']!
      .replace('{z}', z.toString())
      .replace('{x}', x.toString())
      .replace('{y}', y.toString());

    return this.vectorTileCache.get(
      url,
      async (_, childAbortController) => {
        // Fetch raw PBF (will be cached)
        const arrayBuffer = await this.fetchVectorTileRaw(z, x, y, childAbortController);
        // Parse it
        return this.vectorTileLoader.parseVectorTile(arrayBuffer, z, x, y);
      },
      parentAbortController
    );
  }

  // NEW: Fetch raw vector tile PBF data (for MapLibre rendering)
  fetchVectorTileRaw(
    z: number,
    x: number,
    y: number,
    parentAbortController: AbortController
  ): Promise<ArrayBuffer> {
    if (!this.vectorTileLoader.isEnabled()) {
      return Promise.resolve(new ArrayBuffer(0));
    }

    const url = this.vectorTileLoader['vectorTileUrlPattern']!
      .replace('{z}', z.toString())
      .replace('{x}', x.toString())
      .replace('{y}', y.toString());

    return this.vectorTileRawCache.get(
      url,
      async (_, childAbortController) => {
        const response = await fetch(url, {
          signal: childAbortController.signal
        });
        
        if (!response.ok) {
          return new ArrayBuffer(0);
        }
        
        return await response.arrayBuffer();
      },
      parentAbortController
    ).then(arrayBuffer => {
      // Clone the ArrayBuffer to prevent detachment issues
      // when the same buffer is used multiple times
      return arrayBuffer.slice(0);
    });
  }

  fetchContourTile(
    z: number,
    x: number,
    y: number,
    options: IndividualContourTileOptions,
    parentAbortController: AbortController,
    timer?: Timer,
  ): Promise<ContourTile> {
    const {
      levels,
      multiplier = 1,
      buffer = 1,
      extent = 4096,
      contourLayer = "contours",
      elevationKey = "ele",
      levelKey = "level",
      subsampleBelow = 100,
    } = options;

    // no levels means less than min zoom with levels specified
    if (!levels || levels.length === 0) {
      return Promise.resolve({ arrayBuffer: new ArrayBuffer(0) });
    }
    const key = [z, x, y, encodeIndividualOptions(options)].join("/");
    return this.contourCache.get(
      key,
      async (_, childAbortController) => {
        const max = 1 << z;
        const neighborPromises: (Promise<HeightTile> | undefined)[] = [];
        for (let iy = y - 1; iy <= y + 1; iy++) {
          for (let ix = x - 1; ix <= x + 1; ix++) {
            neighborPromises.push(
              iy < 0 || iy >= max
                ? undefined
                : this.fetchDem(
                    z,
                    (ix + max) % max,
                    iy,
                    options,
                    childAbortController,
                    timer,
                  ),
            );
          }
        }
        const neighbors = await Promise.all(neighborPromises);
        let virtualTile = HeightTile.combineNeighbors(neighbors);
        if (!virtualTile || isAborted(childAbortController)) {
          return { arrayBuffer: new Uint8Array().buffer };
        }
        const mark = timer?.marker("isoline");

        if (virtualTile.width >= subsampleBelow) {
          virtualTile = virtualTile.materialize(2);
        } else {
          while (virtualTile.width < subsampleBelow) {
            virtualTile = virtualTile.subsamplePixelCenters(2).materialize(2);
          }
        }

        virtualTile = virtualTile
          .averagePixelCentersToGrid()
          .scaleElevation(multiplier)
          .materialize(1);

        const isolines = generateIsolines(
          levels[0],
          virtualTile,
          extent,
          buffer,
        );

        mark?.();

        // ========== NEW CODE: Split by terrain polygons ==========
        let finalIsolines: SplitContoursResult | { [elevation: number]: number[][] };

        if (this.vectorTileLoader.isEnabled()) {
          try {
            const fetchStart = performance.now();
            
            // Fetch vector tile for this coordinate
            const vectorTile = await this.fetchVectorTile(
              z, x, y,
              childAbortController
            );
            
            const fetchTime = performance.now() - fetchStart;
            console.log(`[Performance] Tile ${z}/${x}/${y}: vector fetch=${fetchTime.toFixed(1)}ms, polygons=${vectorTile.polygons.length}`);

            if (vectorTile.polygons.length > 0) {
              const splitStart = performance.now();
              
              // Split contours by polygons
              finalIsolines = this.contourSplitter.splitContours(
                isolines,
                vectorTile.polygons,
                extent,
                z
              );
              
              const splitTime = performance.now() - splitStart;
              console.log(`[Performance] Tile ${z}/${x}/${y}: split=${splitTime.toFixed(1)}ms`);
            } else {
              // No polygons found - mark all as normal
              finalIsolines = this.contourSplitter.splitContours(
                isolines,
                [],
                extent,
                z
              );
            }
          } catch (error) {
            console.warn('Error during terrain splitting:', error);
            // Fallback: mark all as normal
            finalIsolines = this.contourSplitter.splitContours(
              isolines,
              [],
              extent,
              z
            );
          }
        } else {
          // Vector tiles not configured - use original isolines
          finalIsolines = isolines;
        }

        const result = encodeVectorTile({
          extent,
          layers: {
            [contourLayer]: {
              features: this.createFeaturesFromIsolines(
                finalIsolines,
                levels,
                elevationKey,
                levelKey
              ),
            },
          },
        });
        mark?.();

        // Return the buffer - will be copied when retrieved from cache if needed
        return { arrayBuffer: result.buffer as ArrayBuffer };
      },
      parentAbortController,
    );
  }

  // NEW: Create features with terrain_type property
  private createFeaturesFromIsolines(
    isolines: SplitContoursResult | { [elevation: number]: number[][] },
    levels: number[],
    elevationKey: string,
    levelKey: string
  ) {
    const features: any[] = [];

    for (const [eleString, segments] of Object.entries(isolines)) {
      const ele = Number(eleString);
      const level = Math.max(
        ...levels.map((l, i) => (ele % l === 0 ? i : 0))
      );

      // Check if segments are classified (have terrainType)
      if (Array.isArray(segments) && segments.length > 0) {
        const firstSegment = segments[0];
        
        if (typeof firstSegment === 'object' && 'terrainType' in firstSegment) {
          // Classified segments (SplitContoursResult)
          for (const segment of segments as any[]) {
            features.push({
              type: GeomType.LINESTRING,
              geometry: [segment.geometry],
              properties: {
                [elevationKey]: ele,
                [levelKey]: level,
                terrain_type: segment.terrainType
              }
            });
          }
        } else {
          // Original isolines (number[][])
          for (const geom of segments as number[][]) {
            features.push({
              type: GeomType.LINESTRING,
              geometry: [geom],
              properties: {
                [elevationKey]: ele,
                [levelKey]: level,
                terrain_type: 'normal'
              }
            });
          }
        }
      }
    }

    return features;
  }
}


