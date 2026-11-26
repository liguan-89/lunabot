import { z } from "zod";

/** What a paired phone may ask this computer to search. */
export const nearbyPlacesRequest = z.object({
  query: z.string().trim().min(1).max(200),
  radiusMeters: z.number().int().min(50).max(50_000).default(5_000),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
}).strict();
export type NearbyPlacesRequest = z.infer<typeof nearbyPlacesRequest>;

export interface NearbyPlace {
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceMeters: number | null;
  types: string[];
  rating: number | null;
  openNow: boolean | null;
}

export interface NearbyPlacesAnswer {
  provider: "google";
  query: string;
  radiusMeters: number;
  origin: { latitude: number; longitude: number };
  places: NearbyPlace[];
}

export interface PlacesProvider {
  nearby(input: NearbyPlacesRequest): Promise<NearbyPlacesAnswer>;
}

export type PlacesFetch = (url: string, init: RequestInit) => Promise<Response>;

const GOOGLE_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
  "places.rating",
  "places.currentOpeningHours",
].join(",");
const TIMEOUT_MS = 8_000;
const MAX_RESULTS = 10;
const UPSTREAM_RESULTS = 20;

const upstreamPlace = z.object({
  displayName: z.object({ text: z.string().max(200) }).partial().optional(),
  formattedAddress: z.string().max(500).optional(),
  location: z.object({ latitude: z.number().finite(), longitude: z.number().finite() }).optional(),
  types: z.array(z.string().max(100)).max(20).optional(),
  rating: z.number().finite().min(0).max(5).optional(),
  currentOpeningHours: z.object({ openNow: z.boolean().optional() }).optional(),
}).passthrough();
const upstreamAnswer = z.object({ places: z.array(upstreamPlace).max(20).optional() }).passthrough();

const placesError = (message: string, status = 502) => Object.assign(new Error(message), { status });

function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const radians = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * radians;
  const dLng = (b.longitude - a.longitude) * radians;
  const lat1 = a.latitude * radians;
  const lat2 = b.latitude * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

/** Google Places API (New); the key never leaves this computer. */
export function googlePlacesProvider(apiKey: string, fetcher: PlacesFetch = fetch): PlacesProvider {
  return {
    async nearby(input) {
      let response: Response;
      try {
        response = await fetcher(GOOGLE_SEARCH_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
            "x-goog-fieldmask": FIELD_MASK,
          },
          body: JSON.stringify({
            textQuery: input.query,
            pageSize: UPSTREAM_RESULTS,
            locationBias: {
              circle: {
                center: { latitude: input.latitude, longitude: input.longitude },
                radius: input.radiusMeters,
              },
            },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw placesError("Google Places could not be reached", 502);
      }
      if (!response.ok) throw placesError(`Google Places answered HTTP ${response.status}`, 502);
      let parsed: z.infer<typeof upstreamAnswer>;
      try {
        parsed = upstreamAnswer.parse(await response.json());
      } catch {
        throw placesError("Google Places answered an unexpected shape", 502);
      }
      const origin = { latitude: input.latitude, longitude: input.longitude };
      const places = (parsed.places ?? []).flatMap((place) => {
        const name = place.displayName?.text?.trim();
        if (!name) return [];
        const coordinates = place.location ?? null;
        return [{
          name,
          address: place.formattedAddress?.trim() || null,
          latitude: coordinates?.latitude ?? null,
          longitude: coordinates?.longitude ?? null,
          distanceMeters: coordinates ? distanceMeters(origin, coordinates) : null,
          types: place.types ?? [],
          rating: place.rating ?? null,
          openNow: place.currentOpeningHours?.openNow ?? null,
        }];
      }).filter((place) => place.distanceMeters == null || place.distanceMeters <= input.radiusMeters).slice(0, MAX_RESULTS);
      return { provider: "google", query: input.query, radiusMeters: input.radiusMeters, origin, places };
    },
  };
}

/** Null means the owner has not configured a places key on this computer. */
export function configuredPlacesProvider(env: NodeJS.ProcessEnv = process.env): PlacesProvider | null {
  const key = env.LUNABOT_GOOGLE_PLACES_API_KEY?.trim();
  return key ? googlePlacesProvider(key) : null;
}
