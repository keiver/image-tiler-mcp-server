import { describe, it, expect, beforeEach } from "vitest";
import { recordRecommendation, wasRecommended, clearRecommendations } from "../services/session-state.js";

describe("session-state", () => {
  beforeEach(() => {
    clearRecommendations();
  });

  it("returns false for dimensions that were never recorded", () => {
    expect(wasRecommended(1920, 1080)).toBe(false);
  });

  it("returns true after recording a recommendation", () => {
    recordRecommendation(1920, 1080);
    expect(wasRecommended(1920, 1080)).toBe(true);
  });

  it("tracks multiple dimensions independently", () => {
    recordRecommendation(1920, 1080);
    recordRecommendation(7680, 4032);
    expect(wasRecommended(1920, 1080)).toBe(true);
    expect(wasRecommended(7680, 4032)).toBe(true);
    expect(wasRecommended(3840, 2160)).toBe(false);
  });

  it("clearRecommendations removes all tracked dimensions", () => {
    recordRecommendation(1920, 1080);
    recordRecommendation(7680, 4032);
    clearRecommendations();
    expect(wasRecommended(1920, 1080)).toBe(false);
    expect(wasRecommended(7680, 4032)).toBe(false);
  });

  it("recording the same dimensions twice is idempotent", () => {
    recordRecommendation(1920, 1080);
    recordRecommendation(1920, 1080);
    expect(wasRecommended(1920, 1080)).toBe(true);
  });

  it("distinguishes width×height from height×width", () => {
    recordRecommendation(1920, 1080);
    expect(wasRecommended(1080, 1920)).toBe(false);
  });
});
