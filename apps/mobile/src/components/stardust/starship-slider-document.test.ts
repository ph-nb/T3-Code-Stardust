import { describe, expect, it } from "vite-plus/test";
import { starshipSliderDocument, starshipSliderSelection } from "./starship-slider-document";

describe("starship slider bridge", () => {
  it("accepts only choices from the current model catalog", () => {
    const options = [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ];
    expect(starshipSliderSelection('{"id":"high"}', options)).toBe("high");
    for (const message of ['{"id":"max"}', '{"id":1}', "null", '"high"', "{"]) {
      expect(starshipSliderSelection(message, options)).toBeNull();
    }
    expect(starshipSliderSelection('{"id":"high"}', [])).toBeNull();
  });
  it("keeps the bundled script inside its local document", () => {
    const html = starshipSliderDocument(
      'const label = "</script><script src=https://example.com>";',
    );
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("default-src 'none'");
  });
});
