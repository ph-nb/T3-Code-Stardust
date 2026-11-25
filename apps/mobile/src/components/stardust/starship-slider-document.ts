export interface StarshipSliderConfiguration {
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly value: string;
  readonly reducedMotion: boolean;
  readonly active: boolean;
  readonly disabled: boolean;
}

export function starshipSliderDocument(script: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"><style>html,body{margin:0;background:transparent;overflow:hidden}canvas{display:block;width:100%;height:56px;border-radius:18px;touch-action:none}</style></head><body><canvas aria-hidden="true"></canvas><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}

export function starshipSliderSelection(
  message: string,
  options: StarshipSliderConfiguration["options"],
): string | null {
  try {
    const value: unknown = JSON.parse(message);
    if (!value || typeof value !== "object" || !("id" in value)) return null;
    return typeof value.id === "string" && options.some((option) => option.id === value.id)
      ? value.id
      : null;
  } catch {
    return null;
  }
}
