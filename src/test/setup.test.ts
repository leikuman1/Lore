import { expect, it } from "vitest";

it("blocks unexpected fetch calls in ordinary tests", () => {
  expect(() => fetch("https://example.invalid")).toThrow("Unexpected network request");
});
