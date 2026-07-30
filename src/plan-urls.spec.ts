/**
 * plan-urls.ts — the plan-URL trio emitted across the CLI/MCP surface.
 *
 * Pins the two audience-split web app routes and the `url`-aliases-clientUrl
 * back-compat rule. Base is passed explicitly so the routes are asserted
 * without coupling to config/env.
 */
import { describe, it, expect } from "@jest/globals";
import { clientPlanUrl, advisorPlanUrl, planUrls } from "./plan-urls.js";

const BASE = "https://app.example.com";

describe("plan-urls", () => {
  it("clientPlanUrl points at the traveller-facing /me/trips/plans/{id} route", () => {
    expect(clientPlanUrl("p1", BASE)).toBe("https://app.example.com/me/trips/plans/p1");
  });

  it("advisorPlanUrl points at the advisor-facing /advisor/plans/{id} route", () => {
    expect(advisorPlanUrl("p1", BASE)).toBe("https://app.example.com/advisor/plans/p1");
  });

  it("planUrls returns the trio with url aliasing clientUrl (back-compat)", () => {
    const urls = planUrls("p1", BASE);
    expect(urls).toEqual({
      url: "https://app.example.com/me/trips/plans/p1",
      clientUrl: "https://app.example.com/me/trips/plans/p1",
      advisorUrl: "https://app.example.com/advisor/plans/p1",
    });
    expect(urls.url).toBe(urls.clientUrl);
  });

  it("no longer emits the retired /plans/{id} route", () => {
    const urls = planUrls("p1", BASE);
    expect(urls.clientUrl).not.toBe("https://app.example.com/plans/p1");
    expect(urls.advisorUrl).not.toBe("https://app.example.com/plans/p1");
  });
});
