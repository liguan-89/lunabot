import { describe, expect, it } from "vitest";

import { configuredPlacesProvider, googlePlacesProvider, type PlacesFetch } from "./places.ts";

const input = { query: "coffee", radiusMeters: 1_000, latitude: 31.2, longitude: 121.5 };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("places provider", () => {
  it("sends a Google Places text search and normalizes the small answer the phone may use", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: PlacesFetch = async (url, init) => {
      calls.push({ url, init });
      return reply({ places: [
        {
          displayName: { text: "Cafe One" }, formattedAddress: "1 Road",
          location: { latitude: 31.201, longitude: 121.501 }, types: ["cafe"], rating: 4.5,
          currentOpeningHours: { openNow: true }, ignored: "large payload",
        },
        { displayName: { text: "No coordinates" }, formattedAddress: "2 Road" },
        { displayName: { text: "Too far" }, location: { latitude: 32.2, longitude: 121.5 } },
        { formattedAddress: "Nameless" },
      ] });
    };
    const answer = await googlePlacesProvider("secret-key", fetcher).nearby(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(calls[0]!.init.headers).toMatchObject({
      "x-goog-api-key": "secret-key",
      "x-goog-fieldmask": "places.displayName,places.formattedAddress,places.location,places.types,places.rating,places.currentOpeningHours",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      textQuery: "coffee", pageSize: 20,
      locationBias: { circle: { center: { latitude: 31.2, longitude: 121.5 }, radius: 1_000 } },
    });
    expect(answer).toMatchObject({ provider: "google", query: "coffee", radiusMeters: 1_000, origin: { latitude: 31.2, longitude: 121.5 } });
    expect(answer.places).toHaveLength(2);
    expect(answer.places[0]).toMatchObject({ name: "Cafe One", address: "1 Road", latitude: 31.201, longitude: 121.501, types: ["cafe"], rating: 4.5, openNow: true });
    expect(answer.places[0]!.distanceMeters).toBeGreaterThan(100);
    expect(answer.places[1]).toMatchObject({ name: "No coordinates", address: "2 Road", latitude: null, distanceMeters: null });
  });

  it("fails closed without leaking the key or upstream details", async () => {
    const upstream = await googlePlacesProvider("secret-key", async () => reply({ error: { message: "secret-key must not come back" } }, 500)).nearby(input).catch((error) => error);
    expect(upstream).toMatchObject({ status: 502 });
    expect((upstream as Error).message).toBe("Google Places answered HTTP 500");
    expect((upstream as Error).message).not.toContain("secret-key");

    const network = await googlePlacesProvider("secret-key", async () => { throw new Error("down"); }).nearby(input).catch((error) => error);
    expect(network).toMatchObject({ status: 502 });
    expect((network as Error).message).toBe("Google Places could not be reached");

    const malformed = await googlePlacesProvider("secret-key", async () => reply({ places: [{ displayName: { text: "x" }, rating: 99 }] })).nearby(input).catch((error) => error);
    expect((malformed as Error).message).toBe("Google Places answered an unexpected shape");
  });

  it("caps the answer at ten places and is configured only by the server key", async () => {
    const fetcher: PlacesFetch = async () => reply({ places: Array.from({ length: 12 }, (_, index) => ({ displayName: { text: `Place ${index}` } })) });
    const answer = await googlePlacesProvider("secret-key", fetcher).nearby(input);
    expect(answer.places).toHaveLength(10);
    expect(configuredPlacesProvider({})).toBeNull();
    expect(configuredPlacesProvider({ LUNABOT_GOOGLE_PLACES_API_KEY: " secret-key " })).not.toBeNull();
  });
});
